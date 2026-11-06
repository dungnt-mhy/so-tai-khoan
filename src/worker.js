// Sổ tài khoản — Cloudflare Worker, Giai đoạn 1.
// Chạy toàn bộ trên tài khoản Cloudflare mới (dungnt.storage@gmail.com),
// độc lập hoàn toàn với tài khoản cũ. D1: so-tai-khoan-db. R2: so-tai-khoan-backups.
// API + giao diện web trong cùng một Worker. Bot Telegram qua webhook
// /telegram/webhook (cần secret TELEGRAM_BOT_TOKEN, cấp ở Giai đoạn 1b).

const VERSION = "0.1.0";
const SESSION_DAYS = 7;

function nowISO() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID(); }
function slugify(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "du-an";
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
function err(message, status = 400) { return json({ ok: false, error: message }, status); }
async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}
function sha256hex(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""));
}
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password),
    { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt),
    iterations: 100000, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
function getCookie(req, name) {
  const c = req.headers.get("Cookie") || "";
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}
async function currentUser(env, req) {
  const token = getCookie(req, "stk_session");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT s.user_id, s.expires_at, u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
    .bind(await sha256hex(token)).first();
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}
async function requireAuth(env, req) {
  const u = await currentUser(env, req);
  if (!u) return { user: null, res: err("Chưa đăng nhập", 401) };
  return { user: u, res: null };
}
async function audit(env, userId, action, entity, entityId, detail) {
  try {
    await env.DB.prepare("INSERT INTO audit_log (id, user_id, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(uid(), userId || "", action, entity, entityId || "", detail || "", nowISO()).run();
  } catch { /* audit không được chặn luồng chính */ }
}
function likeParam(q) { return "%" + String(q).replace(/[%_\\]/g, m => "\\" + m) + "%"; }

// ---------- Projects ----------
async function listProjects(env, q, status) {
  let sql = "SELECT * FROM projects";
  const conds = [], args = [];
  if (status) { conds.push("status = ?"); args.push(status); }
  if (q) {
    // Tìm cả theo tài khoản đã gắn vào dự án (vd: gõ "muse" ra các dự án
    // đang build bằng Muse) chứ không chỉ tên/mô tả/tag của dự án.
    conds.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM project_accounts pa JOIN accounts a ON a.id = pa.account_id WHERE pa.project_id = projects.id AND (a.label LIKE ? ESCAPE '\\' OR a.provider LIKE ? ESCAPE '\\' OR a.identity LIKE ? ESCAPE '\\')))");
    args.push(likeParam(q), likeParam(q), likeParam(q), likeParam(q), likeParam(q), likeParam(q));
  }
  if (conds.length) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY updated_at DESC";
  const rows = (await env.DB.prepare(sql).bind(...args).all()).results || [];
  for (const p of rows) {
    const builds = await env.DB.prepare(
      "SELECT a.id, a.provider, a.label, pa.role FROM project_accounts pa JOIN accounts a ON a.id = pa.account_id WHERE pa.project_id = ? AND pa.role LIKE 'build%' ORDER BY a.label")
      .bind(p.id).all();
    p.build_accounts = builds.results || [];
    const counts = await env.DB.prepare("SELECT COUNT(*) c FROM project_accounts WHERE project_id = ?").bind(p.id).first();
    p.account_count = counts ? counts.c : 0;
  }
  return rows;
}
async function projectDetail(env, id) {
  const p = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!p) return null;
  const links = await env.DB.prepare(
    "SELECT a.*, pa.role, pa.note FROM project_accounts pa JOIN accounts a ON a.id = pa.account_id WHERE pa.project_id = ? ORDER BY pa.role, a.provider, a.label")
    .bind(id).all();
  p.accounts = links.results || [];
  for (const a of p.accounts) {
    const res = await env.DB.prepare("SELECT * FROM resources WHERE account_id = ? ORDER BY type, name").bind(a.id).all();
    a.resources = res.results || [];
  }
  return p;
}

// ---------- Accounts ----------
async function listAccounts(env, q, provider, group) {
  let sql = "SELECT * FROM accounts";
  const conds = [], args = [];
  if (provider) { conds.push("provider = ?"); args.push(provider); }
  if (group) { conds.push("provider_group = ?"); args.push(group); }
  if (q) { conds.push("(label LIKE ? ESCAPE '\\' OR identity LIKE ? ESCAPE '\\' OR provider LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')"); args.push(likeParam(q), likeParam(q), likeParam(q), likeParam(q)); }
  if (conds.length) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY provider_group, provider, label";
  const rows = (await env.DB.prepare(sql).bind(...args).all()).results || [];
  for (const a of rows) {
    const pc = await env.DB.prepare("SELECT COUNT(*) c FROM project_accounts WHERE account_id = ?").bind(a.id).first();
    a.project_count = pc ? pc.c : 0;
    const rc = await env.DB.prepare("SELECT COUNT(*) c FROM resources WHERE account_id = ?").bind(a.id).first();
    a.resource_count = rc ? rc.c : 0;
  }
  return rows;
}
async function accountDetail(env, id) {
  const a = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
  if (!a) return null;
  const projs = await env.DB.prepare(
    "SELECT p.*, pa.role, pa.note FROM project_accounts pa JOIN projects p ON p.id = pa.project_id WHERE pa.account_id = ? ORDER BY p.name")
    .bind(id).all();
  a.projects = projs.results || [];
  const res = await env.DB.prepare("SELECT * FROM resources WHERE account_id = ? ORDER BY type, name").bind(id).all();
  a.resources = res.results || [];
  const secs = await env.DB.prepare("SELECT * FROM account_secrets WHERE account_id = ? ORDER BY kind").bind(id).all();
  a.secrets = secs.results || [];
  return a;
}

// ---------- Telegram ----------
async function tgSend(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.ok;
}
function cardProject(p) {
  const lines = [`<b>${esc(p.name)}</b>`, `📝 ${esc(p.description || "(chưa có mô tả)")}`];
  if (p.build_accounts && p.build_accounts.length)
    lines.push(`🔨 Build: ${p.build_accounts.map(a => esc(a.label) + (a.role === "build_chinh" ? " (chính)" : " (phụ)")).join(", ")}`);
  lines.push(`🔗 ${p.account_count || 0} tài khoản`);
  return lines.join("\n");
}
async function handleTelegram(env, req) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, reason: "bot_not_configured" });
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const got = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (got !== env.TELEGRAM_WEBHOOK_SECRET) return err("Sai secret", 403);
  }
  const upd = await readJson(req);
  const msg = upd.message || upd.edited_message;
  if (!msg || !msg.text) return json({ ok: true });
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  if (text === "/start" || text === "/help") {
    await tgSend(env, chatId, "📒 <b>Sổ tài khoản</b>\n/tim &lt;từ khoá&gt; — tìm dự án, tài khoản, tài nguyên\n/duan — liệt kê dự án\n/taikhoan — liệt kê tài khoản");
  } else if (text.startsWith("/tim")) {
    const q = text.replace("/tim", "").trim();
    if (!q) { await tgSend(env, chatId, "Gõ: /tim muse — ví dụ tìm tài khoản Muse"); }
    else {
      const projects = await listProjects(env, q);
      const accounts = await listAccounts(env, q);
      let out = projects.length ? projects.slice(0, 5).map(cardProject).join("\n—\n") : "Không thấy dự án nào.";
      if (accounts.length) out += "\n—\n💳 Tài khoản:\n" + accounts.slice(0, 5).map(a => `• ${esc(a.provider)} — ${esc(a.label)} (${esc(a.identity || "")})`).join("\n");
      await tgSend(env, chatId, out);
    }
  } else if (text === "/duan") {
    const projects = await listProjects(env, "");
    await tgSend(env, chatId, projects.length ? projects.slice(0, 10).map(cardProject).join("\n—\n") : "Chưa có dự án nào.");
  } else if (text === "/taikhoan") {
    const accounts = await listAccounts(env, "");
    await tgSend(env, chatId, accounts.length ? accounts.slice(0, 15).map(a => `• ${esc(a.provider)} — ${esc(a.label)}`).join("\n") : "Chưa có tài khoản nào.");
  }
  return json({ ok: true });
}

// ---------- API ----------
async function handleApi(env, req, url) {
  const path = url.pathname;
  const m = req.method;
  const seg = path.split("/").filter(Boolean); // ["api", ...]

  if (path === "/api/health") return json({ ok: true, version: VERSION, service: "so-tai-khoan", time: nowISO() });

  if (path === "/api/setup" && m === "POST") {
    const { email, password, name } = await readJson(req);
    if (!email || !password || password.length < 8) return err("Email và mật khẩu tối thiểu 8 ký tự");
    const count = await env.DB.prepare("SELECT COUNT(*) c FROM users").first();
    if (count && count.c > 0) return err("Đã có tài khoản Admin, không tạo thêm bằng setup", 403);
    const salt = randomToken().slice(0, 32);
    const id = uid();
    await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, email.toLowerCase(), name || "", await hashPassword(password, salt), salt, "admin", nowISO()).run();
    return json({ ok: true, email: email.toLowerCase() });
  }

  if (path === "/api/auth/login" && m === "POST") {
    const { email, password } = await readJson(req);
    const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind((email || "").toLowerCase()).first();
    if (!u || (await hashPassword(password || "", u.salt)) !== u.password_hash) return err("Sai email hoặc mật khẩu", 401);
    const token = randomToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)")
      .bind(uid(), u.id, await sha256hex(token), exp, nowISO()).run();
    return json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role } }, 200,
      { "Set-Cookie": `stk_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}; Secure` });
  }
  if (path === "/api/auth/logout" && m === "POST") {
    const token = getCookie(req, "stk_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": "stk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }
  if (path === "/api/auth/me" && m === "GET") {
    const u = await currentUser(env, req);
    return u ? json({ ok: true, user: u }) : err("Chưa đăng nhập", 401);
  }
  if (path === "/api/auth/change-password" && m === "POST") {
    const { user, res } = await requireAuth(env, req);
    if (!user) return res;
    const { old_password, new_password } = await readJson(req);
    if (!new_password || new_password.length < 8) return err("Mật khẩu mới tối thiểu 8 ký tự");
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    if ((await hashPassword(old_password || "", u.salt)) !== u.password_hash) return err("Mật khẩu cũ sai", 401);
    const salt = randomToken().slice(0, 32);
    await env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
      .bind(await hashPassword(new_password, salt), salt, user.id).run();
    return json({ ok: true });
  }

  // Từ đây cần đăng nhập
  const { user, res } = await requireAuth(env, req);
  if (!user) return res;

  if (path === "/api/stats" && m === "GET") {
    const p = await env.DB.prepare("SELECT COUNT(*) c FROM projects").first();
    const a = await env.DB.prepare("SELECT COUNT(*) c FROM accounts").first();
    const r = await env.DB.prepare("SELECT COUNT(*) c FROM resources").first();
    const exp = await env.DB.prepare("SELECT id, label, provider, expires_on FROM accounts WHERE expires_on IS NOT NULL AND expires_on <= date('now','+30 days') ORDER BY expires_on").all();
    return json({ ok: true, projects: p.c, accounts: a.c, resources: r.c, expiring: exp.results || [] });
  }
  if (path === "/api/search" && m === "GET") {
    const q = url.searchParams.get("q") || "";
    if (!q.trim()) return json({ ok: true, projects: [], accounts: [], resources: [] });
    const projects = await listProjects(env, q);
    const accounts = await listAccounts(env, q);
    const resRows = (await env.DB.prepare("SELECT r.*, a.label AS account_label, a.provider FROM resources r JOIN accounts a ON a.id = r.account_id WHERE r.name LIKE ? ESCAPE '\\' OR r.identifier LIKE ? ESCAPE '\\' OR r.type LIKE ? ESCAPE '\\' ORDER BY r.name LIMIT 20")
      .bind(likeParam(q), likeParam(q), likeParam(q)).all()).results || [];
    return json({ ok: true, projects, accounts, resources: resRows });
  }
  if (path === "/api/export" && m === "GET") {
    const projects = await listProjects(env, "");
    const accounts = await listAccounts(env, "");
    const resources = (await env.DB.prepare("SELECT * FROM resources ORDER BY account_id, name").all()).results || [];
    return json({ ok: true, exported_at: nowISO(), projects, accounts, resources });
  }

  // Projects
  if (seg[1] === "projects" && seg.length === 2 && m === "GET")
    return json({ ok: true, projects: await listProjects(env, url.searchParams.get("q") || "", url.searchParams.get("status") || "") });
  if (seg[1] === "projects" && seg.length === 2 && m === "POST") {
    const b = await readJson(req);
    if (!b.name) return err("Thiếu tên dự án");
    const id = uid(); const slug = slugify(b.name) + "-" + id.slice(0, 6);
    await env.DB.prepare("INSERT INTO projects (id, name, slug, description, tags, status, url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, b.name, slug, b.description || "", b.tags || "", b.status || "active", b.url || "", nowISO(), nowISO()).run();
    await audit(env, user.id, "create", "project", id, b.name);
    return json({ ok: true, id });
  }
  if (seg[1] === "projects" && seg.length === 3 && m === "GET") {
    const p = await projectDetail(env, seg[2]);
    return p ? json({ ok: true, project: p }) : err("Không thấy dự án", 404);
  }
  if (seg[1] === "projects" && seg.length === 3 && m === "PUT") {
    const b = await readJson(req);
    await env.DB.prepare("UPDATE projects SET name=?, description=?, tags=?, status=?, url=?, updated_at=? WHERE id=?")
      .bind(b.name, b.description || "", b.tags || "", b.status || "active", b.url || "", nowISO(), seg[2]).run();
    await audit(env, user.id, "update", "project", seg[2], b.name || "");
    return json({ ok: true });
  }
  if (seg[1] === "projects" && seg.length === 3 && m === "DELETE") {
    await env.DB.prepare("DELETE FROM project_accounts WHERE project_id=?").bind(seg[2]).run();
    await env.DB.prepare("DELETE FROM projects WHERE id=?").bind(seg[2]).run();
    await audit(env, user.id, "delete", "project", seg[2], "");
    return json({ ok: true });
  }
  if (seg[1] === "projects" && seg.length === 4 && seg[3] === "accounts" && m === "POST") {
    const b = await readJson(req);
    if (!b.account_id || !b.role) return err("Thiếu tài khoản hoặc vai trò");
    await env.DB.prepare("INSERT OR REPLACE INTO project_accounts (project_id, account_id, role, note, created_at) VALUES (?,?,?,?,?)")
      .bind(seg[2], b.account_id, b.role, b.note || "", nowISO()).run();
    await audit(env, user.id, "link", "project_account", seg[2], `${b.account_id} as ${b.role}`);
    return json({ ok: true });
  }
  if (seg[1] === "projects" && seg.length === 5 && seg[3] === "accounts" && m === "DELETE") {
    await env.DB.prepare("DELETE FROM project_accounts WHERE project_id=? AND account_id=? AND role=?")
      .bind(seg[2], seg[4], url.searchParams.get("role") || "other").run();
    return json({ ok: true });
  }

  // Accounts
  if (seg[1] === "accounts" && seg.length === 2 && m === "GET")
    return json({ ok: true, accounts: await listAccounts(env, url.searchParams.get("q") || "", url.searchParams.get("provider") || "", url.searchParams.get("group") || "") });
  if (seg[1] === "accounts" && seg.length === 2 && m === "POST") {
    const b = await readJson(req);
    if (!b.provider || !b.label) return err("Thiếu nhà cung cấp hoặc nhãn tài khoản");
    const id = uid();
    await env.DB.prepare("INSERT INTO accounts (id, provider, provider_group, label, identity, plan, status, notes, expires_on, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, b.provider, b.provider_group || "other", b.label, b.identity || "", b.plan || "", b.status || "active", b.notes || "", b.expires_on || null, nowISO(), nowISO()).run();
    await audit(env, user.id, "create", "account", id, b.label);
    return json({ ok: true, id });
  }
  if (seg[1] === "accounts" && seg.length === 3 && m === "GET") {
    const a = await accountDetail(env, seg[2]);
    return a ? json({ ok: true, account: a }) : err("Không thấy tài khoản", 404);
  }
  if (seg[1] === "accounts" && seg.length === 3 && m === "PUT") {
    const b = await readJson(req);
    await env.DB.prepare("UPDATE accounts SET provider=?, provider_group=?, label=?, identity=?, plan=?, status=?, notes=?, expires_on=?, updated_at=? WHERE id=?")
      .bind(b.provider, b.provider_group || "other", b.label, b.identity || "", b.plan || "", b.status || "active", b.notes || "", b.expires_on || null, nowISO(), seg[2]).run();
    return json({ ok: true });
  }
  if (seg[1] === "accounts" && seg.length === 3 && m === "DELETE") {
    const linked = await env.DB.prepare("SELECT COUNT(*) c FROM project_accounts WHERE account_id=?").bind(seg[2]).first();
    if (linked && linked.c > 0) return err(`Tài khoản đang gắn ${linked.c} dự án, gỡ liên kết trước`, 409);
    await env.DB.prepare("DELETE FROM resources WHERE account_id=?").bind(seg[2]).run();
    await env.DB.prepare("DELETE FROM account_secrets WHERE account_id=?").bind(seg[2]).run();
    await env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(seg[2]).run();
    return json({ ok: true });
  }

  // Resources
  if (seg[1] === "resources" && seg.length === 2 && m === "POST") {
    const b = await readJson(req);
    if (!b.account_id || !b.name) return err("Thiếu tài khoản hoặc tên tài nguyên");
    const id = uid();
    await env.DB.prepare("INSERT INTO resources (id, account_id, type, name, identifier, url, notes, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, b.account_id, b.type || "other", b.name, b.identifier || "", b.url || "", b.notes || "", nowISO()).run();
    return json({ ok: true, id });
  }
  if (seg[1] === "resources" && seg.length === 3 && m === "DELETE") {
    await env.DB.prepare("DELETE FROM resources WHERE id=?").bind(seg[2]).run();
    return json({ ok: true });
  }
  // Secrets metadata (không lưu giá trị)
  if (seg[1] === "accounts" && seg.length === 4 && seg[3] === "secrets" && m === "POST") {
    const b = await readJson(req);
    if (!b.kind) return err("Thiếu loại bí mật");
    const id = uid();
    await env.DB.prepare("INSERT INTO account_secrets (id, account_id, kind, location, last4, expires_on, notes, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, seg[2], b.kind, b.location || "", b.last4 || "", b.expires_on || null, b.notes || "", nowISO()).run();
    return json({ ok: true, id });
  }
  if (seg[1] === "secrets" && seg.length === 3 && m === "DELETE") {
    await env.DB.prepare("DELETE FROM account_secrets WHERE id=?").bind(seg[2]).run();
    return json({ ok: true });
  }

  return err("Không có endpoint này", 404);
}

const ICON_192 = "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";
const ICON_512 = "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";
const ICON_MASK = "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";
const MANIFEST_JSON = JSON.stringify({name:"Sổ tài khoản",short_name:"Sổ tài khoản",description:"Tra cứu dự án đang dùng những tài khoản nào.",start_url:"/",scope:"/",display:"standalone",orientation:"portrait",theme_color:"#047857",background_color:"#F1F5F9",icons:[{src:"/icons/icon-192.png",sizes:"192x192",type:"image/png",purpose:"any"},{src:"/icons/icon-512.png",sizes:"512x512",type:"image/png",purpose:"any"},{src:"/icons/icon-512-maskable.png",sizes:"512x512",type:"image/png",purpose:"maskable"}]});
const SW_JS = "const CACHE='stk-v2';const SHELL=['/','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-512-maskable.png'];self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/telegram/'))return;if(u.origin===location.origin&&(u.pathname==='/'||u.pathname==='/index.html')){e.respondWith(caches.match(e.request).then(h=>{const net=fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(cc=>cc.put(e.request,c));return r}).catch(()=>h);return h||net}))}else{e.respondWith(caches.match(e.request).then(h=>h||fetch(e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(CACHE).then(cc=>cc.put(e.request,c))}return r}).catch(()=>h||new Response('Offline',{status:503}))))}});";
function b64png(b){const bin=atob(b);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return bytes;}
let SHELL_ETAG=null;
async function shellEtag(){if(!SHELL_ETAG){SHELL_ETAG='"'+(await sha256hex(UI_HTML)).slice(0,16)+'"';}return SHELL_ETAG;}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/telegram/webhook" && req.method === "POST") return handleTelegram(env, req);
    if (url.pathname.startsWith("/api/")) return handleApi(env, req, url);
    if (url.pathname === "/manifest.webmanifest") return new Response(MANIFEST_JSON, { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
    if (url.pathname === "/icons/icon-192.png") return new Response(b64png(ICON_192), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname === "/icons/icon-512.png") return new Response(b64png(ICON_512), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname === "/icons/icon-512-maskable.png") return new Response(b64png(ICON_MASK), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const etag = await shellEtag();
      if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" } });
      return new Response(UI_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" } });
    }
    return err("Không tìm thấy", 404);
  },
};

const UI_HTML = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sổ tài khoản</title><meta name="theme-color" content="#047857"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Sổ tài khoản"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap" rel="stylesheet" media="print" onload="this.media=\'all\'"><style>'
+ ':root{--font:Be Vietnam Pro,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s6:24px;--s8:32px;--s12:48px;--r-sm:8px;--r-md:12px;--r-lg:16px;--r-xl:20px;--r-pill:999px;--bg:#F1F5F9;--surface:#fff;--surface-2:#F8FAFC;--border:#E2E8F0;--border-strong:#CBD5E1;--text:#0F172A;--text-2:#475569;--text-3:#64748B;--primary:#047857;--primary-strong:#065F46;--primary-mid:#059669;--primary-soft:#ECFDF5;--primary-softer:#D1FAE5;--teal:#0F766E;--teal-soft:#F0FDFA;--warn-bg:#FFFBEB;--warn-text:#B45309;--danger-bg:#FEF2F2;--danger-text:#B91C1C;--shadow-card:0 1px 2px rgba(15,23,42,.06),0 4px 12px rgba(15,23,42,.06);--shadow-raised:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.10);--shadow-overlay:0 8px 16px rgba(15,23,42,.10),0 24px 64px -12px rgba(15,23,42,.16);--shadow-hero:0 24px 48px -16px rgba(4,120,87,.18),0 4px 12px rgba(15,23,42,.06);--ease-out:cubic-bezier(.05,.7,.1,1);--ease-standard:cubic-bezier(.4,0,.2,1);--dur-fast:120ms;--dur-base:200ms;--dur-med:280ms}*{box-sizing:border-box}body{font-family:var(--font);font-size:16px;line-height:1.55;color:var(--text);background:var(--bg);margin:0;-webkit-font-smoothing:antialiased}button,input,select,textarea{font-family:var(--font)}header{background:linear-gradient(135deg,#047857,#0F766E);color:#fff;padding:16px;position:sticky;top:0;z-index:5;box-shadow:0 2px 12px rgba(4,120,87,.25);display:flex;align-items:center;justify-content:space-between;gap:12px}header button{background:#fff;color:var(--primary);box-shadow:none;flex:0 0 auto;min-height:40px;padding:8px 14px}header h1{font-size:21px;font-weight:700;line-height:1.25;letter-spacing:-.01em;margin:0}header p{margin:4px 0 0;font-size:13px;color:#D1FAE5}main{max-width:1020px;margin:0 auto;padding:16px 16px calc(88px + env(safe-area-inset-bottom))}input,select,textarea{width:100%;min-height:48px;padding:12px 14px;margin:6px 0 12px;border:1px solid var(--border-strong);border-radius:var(--r-md);font-size:16px;line-height:1.4;box-sizing:border-box;background:#fff;color:var(--text)}input:focus,select:focus,textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(5,150,105,.18)}button{background:var(--primary);color:#fff;border:0;min-height:48px;padding:12px 20px;border-radius:var(--r-md);font-size:16px;font-weight:600;line-height:1.2;cursor:pointer;transition:transform var(--dur-fast) var(--ease-out),background-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)}button:active{transform:scale(.97)}button.ghost{background:var(--surface-2);color:var(--text);border:1px solid var(--border);box-shadow:none}.card,.pcard,.acard{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:20px;margin:0 0 16px;box-shadow:var(--shadow-card)}.card h3,.pcard h3,.acard h3{margin:0 0 8px;font-size:16px;font-weight:600;line-height:1.35}.muted{color:var(--text-3);font-size:13px}.chip,.chipb{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600;margin:2px 4px 2px 0}.chip{background:var(--primary-soft);color:var(--primary-strong)}.chipb{background:#DCFCE7;color:#166534}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:1;min-width:140px}.row button{flex:0 0 auto}label{display:block;font-size:13px;font-weight:600;color:var(--text-2);margin:0 0 6px}.hidden{display:none}#msg{color:var(--danger-text);margin:8px 0;font-weight:600}.grid{display:grid;grid-template-columns:1fr;gap:16px}.grid .card,.grid .pcard,.grid .acard{margin:0}@media(min-width:720px){.grid{grid-template-columns:1fr 1fr}}.bar0,.bar1,.bar2,.bar3,.bar4,.bar5{height:5px;border-radius:16px 16px 0 0;margin:-20px -20px 16px}.bar0{background:#059669}.bar1{background:#0284C7}.bar2{background:#D97706}.bar3{background:#E11D48}.bar4{background:#0D9488}.bar5{background:#475569}.acard{display:flex;gap:12px;align-items:flex-start}.card .acard{margin:0 0 8px}.avaai,.avacode,.avainfra,.avapublish,.avagoogle,.avaother{flex:0 0 auto;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:20px}.avaai{background:#0D9488}.avacode{background:#0F172A}.avainfra{background:#0284C7}.avapublish{background:#E11D48}.avagoogle{background:#059669}.avaother{background:#64748B}.sta,.stp,.std{display:inline-block;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700}.sta{background:#DCFCE7;color:#166534}.stp{background:#FEF3C7;color:#92400E}.std{background:#E2E8F0;color:#475569}.sect{font-size:15px;font-weight:700;color:var(--text-2);margin:24px 0 12px}.drow{border-top:1px solid #F1F5F9;padding:12px 0}.mini{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.mini button{background:var(--surface-2);color:var(--primary-strong);border:1px solid var(--border);box-shadow:none;min-height:44px;padding:9px 14px;font-size:14px}.mini button.on{background:var(--primary);color:#fff;border-color:transparent}.formcard{border-left:5px solid #059669}.formcard.fc-a{border-left-color:#059669}.formcard.fc-l{border-left-color:#D97706}.formcard.fc-r{border-left-color:#0284C7}.statnum{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.statnum div{flex:1;min-width:90px;background:var(--primary-soft);border-radius:12px;padding:12px;text-align:center}.statnum b{display:block;font-size:30px;font-weight:700;line-height:1.15;letter-spacing:-.02em;color:var(--primary-strong)}.statnum span{font-size:13px;font-weight:600;color:var(--text-3)}.login{max-width:440px;margin:32px auto}pre{background:#F8FAFC;color:var(--text);border:1px solid var(--border);border-radius:12px;padding:12px;overflow:auto;font-size:12px}h4{margin:16px 0 8px}.bottomnav{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--border);display:flex;z-index:10;height:calc(62px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom)}.bottomnav button{flex:1;background:none;color:var(--text-3);box-shadow:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:48px;padding:4px 2px;border-radius:12px}.bottomnav .ic{display:inline-block;font-size:24px;line-height:1.1}.bottomnav .lb{font-size:11px;font-weight:600;line-height:1.2}.bottomnav button.on{color:var(--primary)}.bottomnav button.on .ic{background:var(--primary-soft);border-radius:999px;padding:4px 12px}.listctl{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:16px 0;flex-wrap:wrap}.listctl button{min-height:40px;padding:8px 14px;font-size:13px}.formcard button{width:100%}#screenSetup button{width:100%}#screenStats{min-height:calc(100vh - 240px);display:flex;flex-direction:column;justify-content:center}#screenStats,#screenList,#paneN,#screenSetup{animation:fadeUp 180ms var(--ease-out)}@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.lane{overflow:hidden;white-space:nowrap;text-align:center;padding:6px 0;font-size:54px;line-height:1.2}.hlane{border-bottom:3px solid #A7F3D0}.snake{display:inline-block;animation:slither 9s linear infinite}.horse{display:inline-block;animation:gallop 7s linear infinite}@keyframes slither{0%{transform:translateX(-60vw)}25%{transform:translateX(-20vw) translateY(-10px) rotate(-8deg)}50%{transform:translateX(20vw) translateY(6px) rotate(6deg)}75%{transform:translateX(60vw) translateY(-10px) rotate(-8deg)}100%{transform:translateX(110vw)}}@keyframes gallop{0%{transform:translateX(-60vw) translateY(0)}15%{transform:translateX(-35vw) translateY(-18px)}30%{transform:translateX(-10vw) translateY(0)}45%{transform:translateX(15vw) translateY(-18px)}60%{transform:translateX(40vw) translateY(0)}75%{transform:translateX(65vw) translateY(-18px)}90%{transform:translateX(90vw) translateY(0)}100%{transform:translateX(110vw) translateY(0)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms !important;transition-duration:.01ms !important}}.swatches{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 10px}#screenSetup .swatch{width:44px;height:44px;min-height:0;border-radius:50%;padding:0;border:2px solid var(--border);cursor:pointer}#screenSetup .swatch.on{border-color:var(--primary-mid);box-shadow:0 0 0 3px #A7F3D0}.bg0{background:#F1F5F9}.bg1{background:linear-gradient(160deg,#D1FAE5,#A7F3D0 45%,#99F6E4)}.bg2{background:linear-gradient(160deg,#E0F2FE,#BAE6FD 45%,#CCFBF1)}.bg3{background:linear-gradient(160deg,#FEF3C7,#FDE68A 45%,#FECACA)}.bg4{background:linear-gradient(160deg,#0F172A,#1E293B 55%,#334155)}.statcard{background:linear-gradient(135deg,#059669,#0D9488);color:#fff;box-shadow:var(--shadow-hero)}.statcard h3{color:#fff}.statcard .statnum div{background:rgba(255,255,255,.93)}.statcard .muted{color:rgba(255,255,255,.85)}.ptitle{color:#0284C7}.note{display:inline-block;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;background:#E0F2FE;color:#0369A1}.atitle{color:#0284C7}.titlerow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.titlerow h3{margin:0;flex:1}.titlerow .sta,.titlerow .stp,.titlerow .std{flex-shrink:0}.empty{text-align:center;padding:32px 16px}.empty-ic{width:64px;height:64px;border-radius:50%;background:var(--primary-soft);display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 12px}.empty h3{margin:0 0 8px}.empty p{margin:0 0 16px}'
+ '</style></head><body><header><div><h1>📒 Sổ tài khoản</h1><p>Dự án → Tài khoản → Tài nguyên · chạy trên Cloudflare tài khoản mới</p></div><button id="logoutBtn" class="hidden" onclick="doLogout()">Đăng xuất</button></header><main>'
+ '<div id="login" class="card login hidden"><h3>Đăng nhập</h3><div id="loginmsg" class="muted"></div><label>Email</label><input id="lemail" type="email" placeholder="email"><label>Mật khẩu</label><input id="lpass" type="password" placeholder="mật khẩu"><button onclick="doLogin()">Đăng nhập</button><p class="muted">Chưa có tài khoản? Tạo Admin đầu tiên ngay dưới (chỉ chạy khi chưa có user nào).</p><label>Email Admin</label><input id="semail" type="email"><label>Mật khẩu Admin (tối thiểu 8 ký tự)</label><input id="spass" type="password"><button class="ghost" onclick="doSetup()">Tạo Admin đầu tiên</button></div>'
+ '<div id="app" class="hidden"><div id="msg"></div>'
+ '<div id="screenList" class="hidden"><div class="card"><div class="row"><input id="q" placeholder="Tìm: tên, mô tả dự án, tài khoản, tài nguyên… ví dụ: muse, cloudflare, SmartStash" oninput="doSearch()"><button onclick="loadAll()">Tìm</button></div></div>'
+ '<div class="sect" id="listTitle">📁 Dự án</div><div id="list" class="grid"></div><div id="listCtl" class="listctl"></div></div>'
+ '<div id="paneN" class="hidden"><div class="sect">Thêm mới — chọn loại muốn thêm</div><div class="mini"><button id="mf_p" class="on" onclick="showForm(\'p\')">📁 Thêm dự án</button><button id="mf_a" onclick="showForm(\'a\')">👤 Thêm tài khoản</button><button id="mf_l" onclick="showForm(\'l\')">🔗 Gắn tài khoản</button><button id="mf_r" onclick="showForm(\'r\')">🧩 Thêm tài nguyên</button></div><div id="nform_p" class="card formcard"><h3>📁 Thêm dự án</h3><label>Tên dự án *</label><input id="np_name"><label>Mô tả (để tìm kiếm) *</label><textarea id="np_desc" rows="3" placeholder="Viết bằng lời thường: dự án này làm gì, dùng để làm gì…"></textarea><label>Từ khoá (cách nhau bằng dấu phẩy)</label><input id="np_tags" placeholder="media, facebook, cloudflare"><label>Trạng thái</label><select id="np_status"><option value="active">Đang làm</option><option value="paused">Tạm dừng</option><option value="done">Đã xong</option></select><button onclick="addProject()">Lưu dự án</button></div>'
+ '<div id="nform_a" class="card formcard fc-a hidden"><h3>👤 Thêm tài khoản</h3><label>Nhóm</label><select id="na_group"><option value="ai">AI / Công cụ build</option><option value="code">Code</option><option value="infra">Hạ tầng</option><option value="publish">Đăng bài</option><option value="google">Google</option><option value="other">Khác</option></select><label>Nhà cung cấp *</label><input id="na_provider" placeholder="Muse, ChatGPT, GitHub, Cloudflare…"><label>Nhãn phân biệt *</label><input id="na_label" placeholder="Muse #1 — chính"><label>Định danh (email / username / account ID)</label><input id="na_identity"><label>Gói</label><input id="na_plan" placeholder="Pro, Team…"><label>Ghi chú</label><input id="na_notes"><button onclick="addAccount()">Lưu tài khoản</button></div>'
+ '<div id="nform_l" class="card formcard fc-l hidden"><h3>🔗 Gắn tài khoản vào dự án</h3><label>Dự án</label><select id="lk_project"></select><label>Tài khoản</label><select id="lk_account"></select><label>Vai trò</label><select id="lk_role"><option value="build_chinh">Build chính</option><option value="build_phu">Build phụ</option><option value="code">Code</option><option value="deploy">Deploy / chạy</option><option value="storage">Lưu trữ</option><option value="publish">Đăng bài</option><option value="notify">Thông báo</option><option value="other">Khác</option></select><label>Ghi chú</label><input id="lk_note" placeholder="Ví dụ: build chính từ tháng 11"><button onclick="linkAccount()">Gắn vào dự án</button></div>'
+ '<div id="nform_r" class="card formcard fc-r hidden"><h3>🧩 Thêm tài nguyên vào tài khoản</h3><label>Tài khoản</label><select id="rs_account"></select><label>Loại</label><select id="rs_type"><option value="repo">Repo</option><option value="domain">Domain / zone</option><option value="worker">Worker</option><option value="tunnel">Tunnel</option><option value="d1">Database D1</option><option value="r2">Bucket R2</option><option value="page">Fanpage / kênh</option><option value="bot">Bot</option><option value="other">Khác</option></select><label>Tên tài nguyên *</label><input id="rs_name" placeholder="Ví dụ: SmartStash, iaict-platform.com"><label>Định danh</label><input id="rs_id" placeholder="Ví dụ: dungnt-mhy/SmartStash"><label>Link</label><input id="rs_url"><button onclick="addResource()">Lưu tài nguyên</button></div></div>'
+ '<div id="screenStats"><div class="lane"><span class="snake">🐍</span></div><div class="card statcard"><h3>📊 Thống kê</h3><div id="stats"></div></div><div class="lane hlane"><span class="horse">🐎</span></div></div><div id="screenSetup" class="hidden"><div class="sect">⚙️ Cài đặt</div><div class="card"><h3>📲 Cài đặt app</h3><p class="muted">Cài app lên màn hình chính để mở nhanh như app thật, có icon riêng.</p><button id="installBtn" class="hidden" onclick="doInstall()">📲 Cài đặt app</button><div id="installStatus" class="muted"></div></div><div class="card"><h3>🖼️ Nền trang</h3><p class="muted">Chọn màu nền hoặc tải ảnh lên làm nền. Lưu trên thiết bị này.</p><div class="swatches"><button id="bg0" class="swatch bg0" title="Mặc định" onclick="setBg(\'\')"></button><button id="bg1" class="swatch bg1" title="Xanh lá" onclick="setBg(\'preset:green\')"></button><button id="bg2" class="swatch bg2" title="Xanh dương" onclick="setBg(\'preset:sky\')"></button><button id="bg3" class="swatch bg3" title="Hoàng hôn" onclick="setBg(\'preset:sunset\')"></button><button id="bg4" class="swatch bg4" title="Đêm" onclick="setBg(\'preset:night\')"></button></div><label>Ảnh nền (tải lên)</label><input id="bg_file" type="file" accept="image/*" onchange="onBgFile(this)"><div id="bg_msg" class="muted"></div></div><div class="card"><h3>Xuất dữ liệu</h3><p class="muted">Tải toàn bộ dự án, tài khoản và tài nguyên dưới dạng JSON.</p><button class="ghost" onclick="doExport()">Xuất toàn bộ (JSON)</button><pre id="exportOut" class="hidden"></pre></div><div class="card"><h3>Đổi mật khẩu</h3><label>Mật khẩu cũ</label><input id="cp_old" type="password"><label>Mật khẩu mới (tối thiểu 8 ký tự)</label><input id="cp_new" type="password"><button onclick="doChangePass()">Đổi mật khẩu</button><div id="cp_msg" class="muted"></div></div></div></div>'
+ '</main><nav class="bottomnav"><button id="navS" class="on" onclick="showTab(\'s\')"><span class="ic">📊</span><span class="lb">Thống kê</span></button><button id="navP" onclick="showTab(\'p\')"><span class="ic">📁</span><span class="lb">Dự án</span></button><button id="navA" onclick="showTab(\'a\')"><span class="ic">👤</span><span class="lb">Tài khoản</span></button><button id="navN" onclick="showTab(\'n\')"><span class="ic">➕</span><span class="lb">Thêm</span></button><button id="navC" onclick="showTab(\'c\')"><span class="ic">⚙️</span><span class="lb">Cài đặt</span></button></nav><script>'
+ 'async function api(p,m,b){var o={method:m||"GET",headers:{"Content-Type":"application/json"}};if(b)o.body=JSON.stringify(b);var r=await fetch(p,o);var j;try{j=await r.json()}catch(e){j={ok:false,error:"Lỗi mạng"}};if(!r.ok&&j.error)throw new Error(j.error);return j;}'
+ 'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}'
+ 'async function checkMe(){try{var j=await api("/api/auth/me");document.getElementById("login").classList.add("hidden");document.getElementById("app").classList.remove("hidden");document.getElementById("logoutBtn").classList.remove("hidden");showTab("s");}catch(e){document.getElementById("login").classList.remove("hidden");document.getElementById("app").classList.add("hidden");document.getElementById("logoutBtn").classList.add("hidden");}}'
+ 'async function doLogin(){try{await api("/api/auth/login","POST",{email:document.getElementById("lemail").value,password:document.getElementById("lpass").value});checkMe();}catch(e){document.getElementById("loginmsg").textContent=e.message;}}'
+ 'async function doSetup(){try{var j=await api("/api/setup","POST",{email:document.getElementById("semail").value,password:document.getElementById("spass").value,name:"Admin"});document.getElementById("loginmsg").textContent="Đã tạo Admin "+j.email+". Đăng nhập bằng tài khoản này.";}catch(e){document.getElementById("loginmsg").textContent=e.message;}}'
+ 'async function doLogout(){await api("/api/auth/logout","POST",{});checkMe();}'
+ 'function goAdd(f){showTab("n");showForm(f)}'
+ 'function showTab(t){curTab=t;document.getElementById("navS").className=t==="s"?"on":"";document.getElementById("navP").className=t==="p"?"on":"";document.getElementById("navA").className=t==="a"?"on":"";document.getElementById("navN").className=t==="n"?"on":"";document.getElementById("navC").className=t==="c"?"on":"";document.getElementById("screenStats").classList.toggle("hidden",t!=="s");document.getElementById("screenList").classList.toggle("hidden",t!=="p"&&t!=="a");document.getElementById("paneN").classList.toggle("hidden",t!=="n");document.getElementById("screenSetup").classList.toggle("hidden",t!=="c");if(t==="p"||t==="a")loadAll();if(t==="s")loadStats();if(t==="n"){loadLinkOptions();showForm("p");}}'
+ 'function showForm(k){var f=["p","a","l","r"];f.forEach(function(x){document.getElementById("nform_"+x).classList.toggle("hidden",x!==k);document.getElementById("mf_"+x).className=x===k?"on":"";});if(k==="l"||k==="r")loadLinkOptions();}'
+ 'var curTab="s";var listExpanded=false;var lastItems=[];var lastKind="p";'
+ 'async function loadAll(){var q=document.getElementById("q").value;document.getElementById("listTitle").textContent=curTab==="a"?"👤 Tài khoản":"📁 Dự án";try{if(curTab==="a"){var j=await api("/api/accounts?q="+encodeURIComponent(q));lastKind="a";lastItems=j.accounts||[];}else{var j2=await api("/api/projects?q="+encodeURIComponent(q));lastKind="p";lastItems=j2.projects||[];}listExpanded=false;renderList();}catch(e){document.getElementById("list").innerHTML="<p>"+esc(e.message)+"</p>";document.getElementById("listCtl").innerHTML="";}}'
+ 'function renderList(){var el=document.getElementById("list");var ctl=document.getElementById("listCtl");var total=lastItems.length;var shown=listExpanded?total:Math.min(total,10);var items=lastItems.slice(0,shown);if(total===0){el.innerHTML="<div class=empty><div class=empty-ic>"+(lastKind==="a"?"👤":"📁")+"</div><h3>"+(lastKind==="a"?"Chưa có tài khoản nào":"Chưa có dự án nào")+"</h3><p class=muted>"+(lastKind==="a"?"Thêm tài khoản đầu tiên để tra cứu xem dự án nào đang dùng nó.":"Thêm dự án đầu tiên để bắt đầu theo dõi tài khoản.")+"</p><button onclick=goAdd(\'"+(lastKind==="a"?"a":"p")+"\')>"+(lastKind==="a"?"+ Thêm tài khoản":"+ Thêm dự án")+"</button></div>";ctl.innerHTML="";return;}if(lastKind==="a"){el.innerHTML=items.map(function(a){var g=a.provider_group||"other";return "<div class=acard><span class=ava"+g+">"+esc(a.provider).charAt(0)+"</span><div><h3 class=atitle>"+esc(a.label)+"</h3><div class=muted><span class=note>"+esc(a.provider)+"</span> · "+esc(a.identity||"")+" · "+esc(a.plan||"")+"</div><div>"+esc(a.notes||"")+"</div><div><span class=chip>"+a.project_count+" dự án</span><span class=chip>"+a.resource_count+" tài nguyên</span></div><button class=ghost onclick=viewAccount(\'"+a.id+"\')>Chi tiết</button></div></div>";}).join("");}else{el.innerHTML=items.map(function(p,i){var st=p.status==="paused"?"Tạm dừng":p.status==="done"?"Đã xong":"Đang làm";var sc=p.status==="paused"?"stp":p.status==="done"?"std":"sta";return "<div class=pcard><div class=bar"+(i%6)+"></div><div class=titlerow><h3 class=ptitle>"+esc(p.name)+"</h3><span class="+sc+">"+st+"</span></div><div class=muted>"+esc(p.description||"")+"</div><div>"+(p.tags||"").split(",").map(function(t){return t.trim()?("<span class=chip>"+esc(t.trim())+"</span>"):"";}).join("")+"</div><div>"+(p.build_accounts||[]).map(function(a){return "<span class=chipb>🔨 "+esc(a.label)+"</span>";}).join("")+"<span class=chip>🔗 "+p.account_count+" tài khoản</span></div><button class=ghost onclick=viewProject(\'"+p.id+"\')>Chi tiết</button></div>";}).join("");}var h="<span class=muted>Hiển thị "+shown+"/"+total+"</span><span>";if(total>10){h+="<button class=ghost onclick=toggleExpand()>"+(listExpanded?"Thu gọn":"Xem thêm ("+(total-shown)+")")+"</button> ";}h+="<button class=ghost onclick=goTop()>⬆ Đầu trang</button></span>";ctl.innerHTML=h;}'
+ 'function toggleExpand(){listExpanded=!listExpanded;renderList();}'
+ 'function goTop(){if(typeof window!=="undefined")window.scrollTo(0,0);}'
+ 'async function viewProject(id){var j=await api("/api/projects/"+id);var p=j.project;var st=p.status==="paused"?"Tạm dừng":p.status==="done"?"Đã xong":"Đang làm";var sc=p.status==="paused"?"stp":p.status==="done"?"std":"sta";var h="<div class=card><div class=titlerow><h3 class=ptitle>"+esc(p.name)+"</h3><span class="+sc+">"+st+"</span></div><div class=muted>"+esc(p.description||"")+"</div><div class=sect>Tài khoản đang dùng</div>";h+=p.accounts.map(function(a){return "<div class=drow><b>"+esc(a.provider)+" — "+esc(a.label)+"</b> <span class=chip>"+esc(a.role)+"</span><div class=muted>"+esc(a.identity||"")+"</div>"+(a.resources||[]).map(function(r){return "<div>· <b>"+esc(r.type)+":</b> "+esc(r.name)+" "+esc(r.identifier||"")+"</div>";}).join("")+"</div>";}).join("")||"<p class=muted>Chưa gắn tài khoản nào.</p>";h+="<button class=ghost onclick=loadAll()>Quay lại</button></div>";document.getElementById("list").innerHTML=h;document.getElementById("listCtl").innerHTML="";}'
+ 'async function viewAccount(id){var j=await api("/api/accounts/"+id);var a=j.account;var g=a.provider_group||"other";var h="<div class=card><div class=acard><span class=ava"+g+">"+esc(a.provider).charAt(0)+"</span><div><h3 class=atitle>"+esc(a.label)+"</h3><div class=muted><span class=note>"+esc(a.provider)+"</span> · "+esc(a.identity||"")+"</div><div>"+esc(a.notes||"")+"</div></div></div><div class=sect>Dự án đang dùng</div>"+(a.projects||[]).map(function(p){return "<div class=drow>· "+esc(p.name)+" <span class=chip>"+esc(p.role)+"</span></div>";}).join("")+"<div class=sect>Tài nguyên</div>"+(a.resources||[]).map(function(r){return "<div class=drow>· <b>"+esc(r.type)+":</b> "+esc(r.name)+" "+esc(r.identifier||"")+"</div>";}).join("")+"<button class=ghost onclick=loadAll()>Quay lại</button></div>";document.getElementById("list").innerHTML=h;document.getElementById("listCtl").innerHTML="";}'
+ 'async function doSearch(){loadAll();}'
+ 'async function addProject(){try{await api("/api/projects","POST",{name:document.getElementById("np_name").value,description:document.getElementById("np_desc").value,tags:document.getElementById("np_tags").value,status:document.getElementById("np_status").value});document.getElementById("msg").textContent="Đã lưu dự án.";showTab("p");}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function addAccount(){try{await api("/api/accounts","POST",{provider_group:document.getElementById("na_group").value,provider:document.getElementById("na_provider").value,label:document.getElementById("na_label").value,identity:document.getElementById("na_identity").value,plan:document.getElementById("na_plan").value,notes:document.getElementById("na_notes").value});document.getElementById("msg").textContent="Đã lưu tài khoản.";curTab="a";showTab("a");}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function loadLinkOptions(){try{var pj=await api("/api/projects");var ac=await api("/api/accounts");var ph="";pj.projects.forEach(function(p){ph+="<option value="+p.id+">"+esc(p.name)+"</option>";});document.getElementById("lk_project").innerHTML=ph;var ah="";ac.accounts.forEach(function(a){ah+="<option value="+a.id+">"+esc(a.provider)+" — "+esc(a.label)+"</option>";});document.getElementById("lk_account").innerHTML=ah;document.getElementById("rs_account").innerHTML=ah;}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function linkAccount(){try{await api("/api/projects/"+document.getElementById("lk_project").value+"/accounts","POST",{account_id:document.getElementById("lk_account").value,role:document.getElementById("lk_role").value,note:document.getElementById("lk_note").value});document.getElementById("msg").textContent="Đã gắn tài khoản vào dự án.";}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function addResource(){try{await api("/api/resources","POST",{account_id:document.getElementById("rs_account").value,type:document.getElementById("rs_type").value,name:document.getElementById("rs_name").value,identifier:document.getElementById("rs_id").value,url:document.getElementById("rs_url").value});document.getElementById("msg").textContent="Đã lưu tài nguyên.";}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function loadStats(){var j=await api("/api/stats");document.getElementById("stats").innerHTML="<div class=statnum><div><b>"+j.projects+"</b><span>Dự án</span></div><div><b>"+j.accounts+"</b><span>Tài khoản</span></div><div><b>"+j.resources+"</b><span>Tài nguyên</span></div></div><p class=muted>Sắp hết hạn: "+(j.expiring||[]).map(function(a){return esc(a.label)+" ("+esc(a.expires_on||"")+")"+")";}).join(", ")+"</p>";}'
+ 'function setBg(v){try{localStorage.setItem("stk_bg",v)}catch(e){}applyBg();markSwatch(v)}'
+ 'function applyBg(){var v="";try{v=localStorage.getItem("stk_bg")||""}catch(e){}var b=document.body;var g={"preset:green":"linear-gradient(160deg,#d1fae5,#a7f3d0 45%,#99f6e4)","preset:sky":"linear-gradient(160deg,#e0f2fe,#bae6fd 45%,#ccfbf1)","preset:sunset":"linear-gradient(160deg,#fef3c7,#fde68a 45%,#fecaca)","preset:night":"linear-gradient(160deg,#0f172a,#1e293b 55%,#334155)"};if(v.indexOf("img:")===0){b.style.backgroundImage="url("+v.slice(4)+")";b.style.backgroundSize="cover";b.style.backgroundAttachment="fixed";b.style.backgroundPosition="center";b.style.backgroundColor="#eef2f7"}else if(g[v]){b.style.backgroundImage=g[v];b.style.backgroundSize="";b.style.backgroundAttachment="";b.style.backgroundPosition="";b.style.backgroundColor="#eef2f7"}else{b.style.backgroundImage="";b.style.backgroundSize="";b.style.backgroundAttachment="";b.style.backgroundPosition="";b.style.backgroundColor="#eef2f7"}}'
+ 'function markSwatch(v){if(v===undefined){try{v=localStorage.getItem("stk_bg")||""}catch(e){v=""}}var ids=["bg0","bg1","bg2","bg3","bg4"];var vals=["","preset:green","preset:sky","preset:sunset","preset:night"];for(var i=0;i<ids.length;i++){var e=document.getElementById(ids[i]);if(e)e.className="swatch "+ids[i]+(v===vals[i]?" on":"")}}'
+ 'function onBgFile(inp){var f=inp.files&&inp.files[0];if(!f)return;var r=new FileReader();r.onload=function(){var img=new Image();img.onload=function(){var c=document.createElement("canvas");var w=img.width,h=img.height;var m=1280;if(w>m){h=Math.round(h*m/w);w=m}c.width=w;c.height=h;c.getContext("2d").drawImage(img,0,0,w,h);var d=c.toDataURL("image/jpeg",0.8);try{localStorage.setItem("stk_bg","img:"+d)}catch(e){document.getElementById("bg_msg").textContent="Ảnh quá lớn, không lưu được. Thử ảnh nhỏ hơn.";return}applyBg();markSwatch("img:");document.getElementById("bg_msg").textContent="Đã đặt ảnh nền."};img.src=r.result};r.readAsDataURL(f)}'
+ 'var deferredPrompt=null;'
+ 'function isStandalone(){return (window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone===true;}'
+ 'function updateInstallUI(){var b=document.getElementById("installBtn");var s=document.getElementById("installStatus");if(!b||!s)return;if(isStandalone()){b.classList.add("hidden");s.textContent="App đã được cài đặt trên thiết bị này.";return}var ios=/iphone|ipad|ipod/i.test(navigator.userAgent||"");if(ios){b.classList.add("hidden");s.textContent="Trên iPhone/iPad: bấm nút Chia sẻ rồi chọn Thêm vào Màn hình chính.";return}if(deferredPrompt){b.classList.remove("hidden");s.textContent="Có thể cài đặt app lên màn hình chính."}else{s.textContent="Mở app bằng Chrome rồi quay lại đây để cài đặt."}}'
+ 'async function doInstall(){if(!deferredPrompt)return;deferredPrompt.prompt();var c=null;try{c=await deferredPrompt.userChoice}catch(e){}deferredPrompt=null;var b=document.getElementById("installBtn");if(b)b.classList.add("hidden");var s=document.getElementById("installStatus");if(s)s.textContent=(c&&c.outcome==="accepted")?"Đã cài đặt app.":"Đã hủy cài đặt.";}'
+ 'window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();deferredPrompt=e;updateInstallUI();});'
+ 'window.addEventListener("appinstalled",function(){deferredPrompt=null;updateInstallUI();});'
+ 'window.addEventListener("load",function(){if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){});}});'
+ 'async function doExport(){var j=await api("/api/export");var o=document.getElementById("exportOut");o.textContent=JSON.stringify(j,null,2).slice(0,4000);o.classList.remove("hidden");}'
+ 'async function doChangePass(){try{await api("/api/auth/change-password","POST",{old_password:document.getElementById("cp_old").value,new_password:document.getElementById("cp_new").value});document.getElementById("cp_msg").textContent="Đã đổi mật khẩu.";}catch(e){document.getElementById("cp_msg").textContent=e.message;}}'
+ 'applyBg();markSwatch();updateInstallUI();checkMe();'
+ '</script></body></html>';
