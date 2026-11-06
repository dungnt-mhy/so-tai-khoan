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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/telegram/webhook" && req.method === "POST") return handleTelegram(env, req);
    if (url.pathname.startsWith("/api/")) return handleApi(env, req, url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(UI_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return err("Không tìm thấy", 404);
  },
};

const UI_HTML = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sổ tài khoản</title><style>'
+ 'body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#eef2f7;color:#0f172a}header{background:linear-gradient(135deg,#4f46e5,#7c3aed 60%,#a855f7);color:#fff;padding:16px;position:sticky;top:0;z-index:5;box-shadow:0 2px 12px rgba(79,70,229,.35);display:flex;align-items:center;justify-content:space-between;gap:12px}header button{background:#fff;color:#4f46e5;box-shadow:none;flex:0 0 auto;padding:9px 14px}header h1{font-size:20px;margin:0;letter-spacing:.2px}header p{margin:4px 0 0;font-size:13px;color:#e0e7ff}main{max-width:1020px;margin:0 auto;padding:16px 16px 96px}input,select,textarea{width:100%;padding:11px 12px;margin:6px 0 10px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px;box-sizing:border-box;background:#fff}input:focus,select:focus,textarea:focus{outline:2px solid #a5b4fc;border-color:#6366f1}button{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:0;padding:11px 18px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(79,70,229,.3)}button.ghost{background:#fff;color:#3730a3;border:1px solid #c7d2fe;box-shadow:none}.card,.pcard,.acard{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:16px;margin:12px 0;box-shadow:0 1px 4px rgba(15,23,42,.06)}.card h3,.pcard h3,.acard h3{margin:0 0 6px;font-size:17px}.muted{color:#64748b;font-size:13px}.chip,.chipb{display:inline-block;border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;margin:2px 4px 2px 0}.chip{background:#eef2ff;color:#3730a3}.chipb{background:#dcfce7;color:#166534}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.tabs button{background:#fff;color:#3730a3;border:1px solid #c7d2fe;box-shadow:none}.tabs button.on{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-color:transparent}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:1;min-width:140px}.row button{flex:0 0 auto}label{font-size:13px;font-weight:600;color:#334155}.hidden{display:none}#msg{color:#b91c1c;margin:8px 0;font-weight:600}.grid{display:grid;grid-template-columns:1fr;gap:14px}.grid .card,.grid .pcard,.grid .acard{margin:0}@media(min-width:720px){.grid{grid-template-columns:1fr 1fr}}.bar0,.bar1,.bar2,.bar3,.bar4,.bar5{height:5px;border-radius:16px 16px 0 0;margin:-16px -16px 12px}.bar0{background:#4f46e5}.bar1{background:#059669}.bar2{background:#d97706}.bar3{background:#e11d48}.bar4{background:#0284c7}.bar5{background:#7c3aed}.acard{display:flex;gap:12px;align-items:flex-start}.card .acard{margin:0 0 8px}.avaai,.avacode,.avainfra,.avapublish,.avagoogle,.avaother{flex:0 0 auto;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:20px}.avaai{background:#7c3aed}.avacode{background:#0f172a}.avainfra{background:#0284c7}.avapublish{background:#e11d48}.avagoogle{background:#059669}.avaother{background:#64748b}.sta,.stp,.std{display:inline-block;border-radius:999px;padding:3px 11px;font-size:12px;font-weight:700}.sta{background:#dcfce7;color:#166534}.stp{background:#fef3c7;color:#92400e}.std{background:#e2e8f0;color:#475569}.sect{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5;margin:18px 0 8px;padding-left:10px;border-left:4px solid #4f46e5}.drow{border-top:1px solid #e2e8f0;padding:10px 0}.mini{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.mini button{background:#fff;color:#3730a3;border:1px solid #c7d2fe;box-shadow:none;padding:9px 14px;font-size:14px}.mini button.on{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-color:transparent}.formcard{border-left:5px solid #4f46e5}.formcard.fc-a{border-left-color:#059669}.formcard.fc-l{border-left-color:#d97706}.formcard.fc-r{border-left-color:#0284c7}.statnum{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}.statnum div{flex:1;min-width:90px;background:#eef2ff;border-radius:12px;padding:12px;text-align:center}.statnum b{display:block;font-size:26px;color:#3730a3}.statnum span{font-size:12px;color:#64748b}.login{max-width:440px;margin:32px auto}pre{background:#0f172a;color:#e2e8f0;border-radius:12px;padding:12px;overflow:auto;font-size:12px}h4{margin:14px 0 6px}.bottomnav{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #e2e8f0;display:flex;z-index:10;padding:6px 4px 10px;box-shadow:0 -2px 12px rgba(15,23,42,.08)}.bottomnav button{flex:1;background:none;color:#64748b;box-shadow:none;font-size:12px;padding:8px 2px;border-radius:10px;line-height:1.4}.bottomnav button.on{color:#4f46e5;background:#eef2ff}.listctl{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:14px 0;flex-wrap:wrap}.listctl button{padding:8px 12px;font-size:13px}'
+ '</style></head><body><header><div><h1>📒 Sổ tài khoản</h1><p>Dự án → Tài khoản → Tài nguyên · chạy trên Cloudflare tài khoản mới</p></div><button id="logoutBtn" class="hidden" onclick="doLogout()">Đăng xuất</button></header><main>'
+ '<div id="login" class="card login hidden"><h3>Đăng nhập</h3><div id="loginmsg" class="muted"></div><label>Email</label><input id="lemail" type="email" placeholder="email"><label>Mật khẩu</label><input id="lpass" type="password" placeholder="mật khẩu"><button onclick="doLogin()">Đăng nhập</button><p class="muted">Chưa có tài khoản? Tạo Admin đầu tiên ngay dưới (chỉ chạy khi chưa có user nào).</p><label>Email Admin</label><input id="semail" type="email"><label>Mật khẩu Admin (tối thiểu 8 ký tự)</label><input id="spass" type="password"><button class="ghost" onclick="doSetup()">Tạo Admin đầu tiên</button></div>'
+ '<div id="app" class="hidden"><div id="msg"></div>'
+ '<div id="screenList" class="hidden"><div class="card"><div class="row"><input id="q" placeholder="Tìm: tên, mô tả dự án, tài khoản, tài nguyên… ví dụ: muse, cloudflare, SmartStash" oninput="doSearch()"><button onclick="loadAll()">Tìm</button></div></div>'
+ '<div class="sect" id="listTitle">📁 Dự án</div><div id="list" class="grid"></div><div id="listCtl" class="listctl"></div></div>'
+ '<div id="paneN" class="hidden"><div class="sect">Thêm mới — chọn loại muốn thêm</div><div class="mini"><button id="mf_p" class="on" onclick="showForm(\'p\')">📁 Thêm dự án</button><button id="mf_a" onclick="showForm(\'a\')">👤 Thêm tài khoản</button><button id="mf_l" onclick="showForm(\'l\')">🔗 Gắn tài khoản</button><button id="mf_r" onclick="showForm(\'r\')">🧩 Thêm tài nguyên</button></div><div id="nform_p" class="card formcard"><h3>📁 Thêm dự án</h3><label>Tên dự án *</label><input id="np_name"><label>Mô tả (để tìm kiếm) *</label><textarea id="np_desc" rows="3" placeholder="Viết bằng lời thường: dự án này làm gì, dùng để làm gì…"></textarea><label>Từ khoá (cách nhau bằng dấu phẩy)</label><input id="np_tags" placeholder="media, facebook, cloudflare"><label>Trạng thái</label><select id="np_status"><option value="active">Đang làm</option><option value="paused">Tạm dừng</option><option value="done">Đã xong</option></select><button onclick="addProject()">Lưu dự án</button></div>'
+ '<div id="nform_a" class="card formcard fc-a hidden"><h3>👤 Thêm tài khoản</h3><label>Nhóm</label><select id="na_group"><option value="ai">AI / Công cụ build</option><option value="code">Code</option><option value="infra">Hạ tầng</option><option value="publish">Đăng bài</option><option value="google">Google</option><option value="other">Khác</option></select><label>Nhà cung cấp *</label><input id="na_provider" placeholder="Muse, ChatGPT, GitHub, Cloudflare…"><label>Nhãn phân biệt *</label><input id="na_label" placeholder="Muse #1 — chính"><label>Định danh (email / username / account ID)</label><input id="na_identity"><label>Gói</label><input id="na_plan" placeholder="Pro, Team…"><label>Ghi chú</label><input id="na_notes"><button onclick="addAccount()">Lưu tài khoản</button></div>'
+ '<div id="nform_l" class="card formcard fc-l hidden"><h3>🔗 Gắn tài khoản vào dự án</h3><label>Dự án</label><select id="lk_project"></select><label>Tài khoản</label><select id="lk_account"></select><label>Vai trò</label><select id="lk_role"><option value="build_chinh">Build chính</option><option value="build_phu">Build phụ</option><option value="code">Code</option><option value="deploy">Deploy / chạy</option><option value="storage">Lưu trữ</option><option value="publish">Đăng bài</option><option value="notify">Thông báo</option><option value="other">Khác</option></select><label>Ghi chú</label><input id="lk_note" placeholder="Ví dụ: build chính từ tháng 11"><button onclick="linkAccount()">Gắn vào dự án</button></div>'
+ '<div id="nform_r" class="card formcard fc-r hidden"><h3>🧩 Thêm tài nguyên vào tài khoản</h3><label>Tài khoản</label><select id="rs_account"></select><label>Loại</label><select id="rs_type"><option value="repo">Repo</option><option value="domain">Domain / zone</option><option value="worker">Worker</option><option value="tunnel">Tunnel</option><option value="d1">Database D1</option><option value="r2">Bucket R2</option><option value="page">Fanpage / kênh</option><option value="bot">Bot</option><option value="other">Khác</option></select><label>Tên tài nguyên *</label><input id="rs_name" placeholder="Ví dụ: SmartStash, iaict-platform.com"><label>Định danh</label><input id="rs_id" placeholder="Ví dụ: dungnt-mhy/SmartStash"><label>Link</label><input id="rs_url"><button onclick="addResource()">Lưu tài nguyên</button></div></div>'
+ '<div id="screenStats"><div class="card"><h3>📊 Thống kê</h3><div id="stats"></div><button onclick="doExport()">Xuất toàn bộ (JSON)</button><pre id="exportOut" class="muted"></pre></div><div class="card"><h3>Đổi mật khẩu</h3><label>Mật khẩu cũ</label><input id="cp_old" type="password"><label>Mật khẩu mới (tối thiểu 8 ký tự)</label><input id="cp_new" type="password"><button onclick="doChangePass()">Đổi mật khẩu</button><div id="cp_msg" class="muted"></div></div></div></div>'
+ '</main><nav class="bottomnav"><button id="navS" class="on" onclick="showTab(\'s\')">📊<br>Thống kê</button><button id="navP" onclick="showTab(\'p\')">📁<br>Dự án</button><button id="navA" onclick="showTab(\'a\')">👤<br>Tài khoản</button><button id="navN" onclick="showTab(\'n\')">➕<br>Thêm mới</button></nav><script>'
+ 'async function api(p,m,b){var o={method:m||"GET",headers:{"Content-Type":"application/json"}};if(b)o.body=JSON.stringify(b);var r=await fetch(p,o);var j;try{j=await r.json()}catch(e){j={ok:false,error:"Lỗi mạng"}};if(!r.ok&&j.error)throw new Error(j.error);return j;}'
+ 'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}'
+ 'async function checkMe(){try{var j=await api("/api/auth/me");document.getElementById("login").classList.add("hidden");document.getElementById("app").classList.remove("hidden");document.getElementById("logoutBtn").classList.remove("hidden");showTab("s");}catch(e){document.getElementById("login").classList.remove("hidden");document.getElementById("app").classList.add("hidden");document.getElementById("logoutBtn").classList.add("hidden");}}'
+ 'async function doLogin(){try{await api("/api/auth/login","POST",{email:document.getElementById("lemail").value,password:document.getElementById("lpass").value});checkMe();}catch(e){document.getElementById("loginmsg").textContent=e.message;}}'
+ 'async function doSetup(){try{var j=await api("/api/setup","POST",{email:document.getElementById("semail").value,password:document.getElementById("spass").value,name:"Admin"});document.getElementById("loginmsg").textContent="Đã tạo Admin "+j.email+". Đăng nhập bằng tài khoản này.";}catch(e){document.getElementById("loginmsg").textContent=e.message;}}'
+ 'async function doLogout(){await api("/api/auth/logout","POST",{});checkMe();}'
+ 'function showTab(t){curTab=t;document.getElementById("navS").className=t==="s"?"on":"";document.getElementById("navP").className=t==="p"?"on":"";document.getElementById("navA").className=t==="a"?"on":"";document.getElementById("navN").className=t==="n"?"on":"";document.getElementById("screenStats").classList.toggle("hidden",t!=="s");document.getElementById("screenList").classList.toggle("hidden",t!=="p"&&t!=="a");document.getElementById("paneN").classList.toggle("hidden",t!=="n");if(t==="p"||t==="a")loadAll();if(t==="s")loadStats();if(t==="n"){loadLinkOptions();showForm("p");}}'
+ 'function showForm(k){var f=["p","a","l","r"];f.forEach(function(x){document.getElementById("nform_"+x).classList.toggle("hidden",x!==k);document.getElementById("mf_"+x).className=x===k?"on":"";});if(k==="l"||k==="r")loadLinkOptions();}'
+ 'var curTab="s";var listExpanded=false;var lastItems=[];var lastKind="p";'
+ 'async function loadAll(){var q=document.getElementById("q").value;document.getElementById("listTitle").textContent=curTab==="a"?"👤 Tài khoản":"📁 Dự án";try{if(curTab==="a"){var j=await api("/api/accounts?q="+encodeURIComponent(q));lastKind="a";lastItems=j.accounts||[];}else{var j2=await api("/api/projects?q="+encodeURIComponent(q));lastKind="p";lastItems=j2.projects||[];}listExpanded=false;renderList();}catch(e){document.getElementById("list").innerHTML="<p>"+esc(e.message)+"</p>";document.getElementById("listCtl").innerHTML="";}}'
+ 'function renderList(){var el=document.getElementById("list");var ctl=document.getElementById("listCtl");var total=lastItems.length;var shown=listExpanded?total:Math.min(total,10);var items=lastItems.slice(0,shown);if(total===0){el.innerHTML="<p class=muted>"+(lastKind==="a"?"Chưa có tài khoản nào.":"Chưa có dự án nào.")+"</p>";ctl.innerHTML="";return;}if(lastKind==="a"){el.innerHTML=items.map(function(a){var g=a.provider_group||"other";return "<div class=acard><span class=ava"+g+">"+esc(a.provider).charAt(0)+"</span><div><h3>"+esc(a.label)+"</h3><div class=muted>"+esc(a.provider)+" · "+esc(a.identity||"")+" · "+esc(a.plan||"")+"</div><div>"+esc(a.notes||"")+"</div><div><span class=chip>"+a.project_count+" dự án</span><span class=chip>"+a.resource_count+" tài nguyên</span></div><button class=ghost onclick=viewAccount(\'"+a.id+"\')>Chi tiết</button></div></div>";}).join("");}else{el.innerHTML=items.map(function(p,i){var st=p.status==="paused"?"Tạm dừng":p.status==="done"?"Đã xong":"Đang làm";var sc=p.status==="paused"?"stp":p.status==="done"?"std":"sta";return "<div class=pcard><div class=bar"+(i%6)+"></div><div><span class="+sc+">"+st+"</span></div><h3>"+esc(p.name)+"</h3><div class=muted>"+esc(p.description||"")+"</div><div>"+(p.tags||"").split(",").map(function(t){return t.trim()?("<span class=chip>"+esc(t.trim())+"</span>"):"";}).join("")+"</div><div>"+(p.build_accounts||[]).map(function(a){return "<span class=chipb>🔨 "+esc(a.label)+"</span>";}).join("")+"<span class=chip>🔗 "+p.account_count+" tài khoản</span></div><button class=ghost onclick=viewProject(\'"+p.id+"\')>Chi tiết</button></div>";}).join("");}var h="<span class=muted>Hiển thị "+shown+"/"+total+"</span><span>";if(total>10){h+="<button class=ghost onclick=toggleExpand()>"+(listExpanded?"Thu gọn":"Xem thêm ("+(total-shown)+")")+"</button> ";}h+="<button class=ghost onclick=goTop()>⬆ Đầu trang</button></span>";ctl.innerHTML=h;}'
+ 'function toggleExpand(){listExpanded=!listExpanded;renderList();}'
+ 'function goTop(){if(typeof window!=="undefined")window.scrollTo(0,0);}'
+ 'async function viewProject(id){var j=await api("/api/projects/"+id);var p=j.project;var st=p.status==="paused"?"Tạm dừng":p.status==="done"?"Đã xong":"Đang làm";var sc=p.status==="paused"?"stp":p.status==="done"?"std":"sta";var h="<div class=card><div><span class="+sc+">"+st+"</span></div><h3>"+esc(p.name)+"</h3><div class=muted>"+esc(p.description||"")+"</div><div class=sect>Tài khoản đang dùng</div>";h+=p.accounts.map(function(a){return "<div class=drow><b>"+esc(a.provider)+" — "+esc(a.label)+"</b> <span class=chip>"+esc(a.role)+"</span><div class=muted>"+esc(a.identity||"")+"</div>"+(a.resources||[]).map(function(r){return "<div>· "+esc(r.type)+": "+esc(r.name)+" "+esc(r.identifier||"")+"</div>";}).join("")+"</div>";}).join("")||"<p class=muted>Chưa gắn tài khoản nào.</p>";h+="<button class=ghost onclick=loadAll()>Quay lại</button></div>";document.getElementById("list").innerHTML=h;document.getElementById("listCtl").innerHTML="";}'
+ 'async function viewAccount(id){var j=await api("/api/accounts/"+id);var a=j.account;var g=a.provider_group||"other";var h="<div class=card><div class=acard><span class=ava"+g+">"+esc(a.provider).charAt(0)+"</span><div><h3>"+esc(a.label)+"</h3><div class=muted>"+esc(a.provider)+" · "+esc(a.identity||"")+"</div><div>"+esc(a.notes||"")+"</div></div></div><div class=sect>Dự án đang dùng</div>"+(a.projects||[]).map(function(p){return "<div class=drow>· "+esc(p.name)+" <span class=chip>"+esc(p.role)+"</span></div>";}).join("")+"<div class=sect>Tài nguyên</div>"+(a.resources||[]).map(function(r){return "<div class=drow>· "+esc(r.type)+": "+esc(r.name)+" "+esc(r.identifier||"")+"</div>";}).join("")+"<button class=ghost onclick=loadAll()>Quay lại</button></div>";document.getElementById("list").innerHTML=h;document.getElementById("listCtl").innerHTML="";}'
+ 'async function doSearch(){loadAll();}'
+ 'async function addProject(){try{await api("/api/projects","POST",{name:document.getElementById("np_name").value,description:document.getElementById("np_desc").value,tags:document.getElementById("np_tags").value,status:document.getElementById("np_status").value});document.getElementById("msg").textContent="Đã lưu dự án.";showTab("p");}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function addAccount(){try{await api("/api/accounts","POST",{provider_group:document.getElementById("na_group").value,provider:document.getElementById("na_provider").value,label:document.getElementById("na_label").value,identity:document.getElementById("na_identity").value,plan:document.getElementById("na_plan").value,notes:document.getElementById("na_notes").value});document.getElementById("msg").textContent="Đã lưu tài khoản.";curTab="a";showTab("a");}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function loadLinkOptions(){try{var pj=await api("/api/projects");var ac=await api("/api/accounts");var ph="";pj.projects.forEach(function(p){ph+="<option value="+p.id+">"+esc(p.name)+"</option>";});document.getElementById("lk_project").innerHTML=ph;var ah="";ac.accounts.forEach(function(a){ah+="<option value="+a.id+">"+esc(a.provider)+" — "+esc(a.label)+"</option>";});document.getElementById("lk_account").innerHTML=ah;document.getElementById("rs_account").innerHTML=ah;}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function linkAccount(){try{await api("/api/projects/"+document.getElementById("lk_project").value+"/accounts","POST",{account_id:document.getElementById("lk_account").value,role:document.getElementById("lk_role").value,note:document.getElementById("lk_note").value});document.getElementById("msg").textContent="Đã gắn tài khoản vào dự án.";}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function addResource(){try{await api("/api/resources","POST",{account_id:document.getElementById("rs_account").value,type:document.getElementById("rs_type").value,name:document.getElementById("rs_name").value,identifier:document.getElementById("rs_id").value,url:document.getElementById("rs_url").value});document.getElementById("msg").textContent="Đã lưu tài nguyên.";}catch(e){document.getElementById("msg").textContent=e.message;}}'
+ 'async function loadStats(){var j=await api("/api/stats");document.getElementById("stats").innerHTML="<div class=statnum><div><b>"+j.projects+"</b><span>Dự án</span></div><div><b>"+j.accounts+"</b><span>Tài khoản</span></div><div><b>"+j.resources+"</b><span>Tài nguyên</span></div></div><p class=muted>Sắp hết hạn: "+(j.expiring||[]).map(function(a){return esc(a.label)+" ("+esc(a.expires_on||"")+")"+")";}).join(", ")+"</p>";}'
+ 'async function doExport(){var j=await api("/api/export");document.getElementById("exportOut").textContent=JSON.stringify(j,null,2).slice(0,4000);}'
+ 'async function doChangePass(){try{await api("/api/auth/change-password","POST",{old_password:document.getElementById("cp_old").value,new_password:document.getElementById("cp_new").value});document.getElementById("cp_msg").textContent="Đã đổi mật khẩu.";}catch(e){document.getElementById("cp_msg").textContent=e.message;}}'
+ 'checkMe();'
+ '</script></body></html>';
