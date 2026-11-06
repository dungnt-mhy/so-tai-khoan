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

const UI_HTML = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sổ tài khoản</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>'
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
+ '<div id="screenStats"><div class="lane"><span class="snake">🐍</span></div><div class="card statcard"><h3>📊 Thống kê</h3><div id="stats"></div></div><div class="lane hlane"><span class="horse">🐎</span></div></div><div id="screenSetup" class="hidden"><div class="sect">⚙️ Cài đặt</div><div class="card"><h3>🖼️ Nền trang</h3><p class="muted">Chọn màu nền hoặc tải ảnh lên làm nền. Lưu trên thiết bị này.</p><div class="swatches"><button id="bg0" class="swatch bg0" title="Mặc định" onclick="setBg(\'\')"></button><button id="bg1" class="swatch bg1" title="Xanh lá" onclick="setBg(\'preset:green\')"></button><button id="bg2" class="swatch bg2" title="Xanh dương" onclick="setBg(\'preset:sky\')"></button><button id="bg3" class="swatch bg3" title="Hoàng hôn" onclick="setBg(\'preset:sunset\')"></button><button id="bg4" class="swatch bg4" title="Đêm" onclick="setBg(\'preset:night\')"></button></div><label>Ảnh nền (tải lên)</label><input id="bg_file" type="file" accept="image/*" onchange="onBgFile(this)"><div id="bg_msg" class="muted"></div></div><div class="card"><h3>Xuất dữ liệu</h3><p class="muted">Tải toàn bộ dự án, tài khoản và tài nguyên dưới dạng JSON.</p><button class="ghost" onclick="doExport()">Xuất toàn bộ (JSON)</button><pre id="exportOut" class="hidden"></pre></div><div class="card"><h3>Đổi mật khẩu</h3><label>Mật khẩu cũ</label><input id="cp_old" type="password"><label>Mật khẩu mới (tối thiểu 8 ký tự)</label><input id="cp_new" type="password"><button onclick="doChangePass()">Đổi mật khẩu</button><div id="cp_msg" class="muted"></div></div></div></div>'
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
+ 'async function doExport(){var j=await api("/api/export");var o=document.getElementById("exportOut");o.textContent=JSON.stringify(j,null,2).slice(0,4000);o.classList.remove("hidden");}'
+ 'async function doChangePass(){try{await api("/api/auth/change-password","POST",{old_password:document.getElementById("cp_old").value,new_password:document.getElementById("cp_new").value});document.getElementById("cp_msg").textContent="Đã đổi mật khẩu.";}catch(e){document.getElementById("cp_msg").textContent=e.message;}}'
+ 'applyBg();markSwatch();checkMe();'
+ '</script></body></html>';
