// 仅用于 Playwright 的 API 测试替身：按 api/openapi.yaml 提供内存状态与 SSE。
// 不是正式后端，不写入仓库数据；测试通过真实 HTTP 接口创建数据。
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.MOCK_API_PORT || 8080);
const TEST_PASSWORD = "rsm-e2e-pass-123";

const holidays2026 = [
  ["2026-01-01", "2026-01-03"],
  ["2026-02-15", "2026-02-23"],
  ["2026-04-04", "2026-04-06"],
  ["2026-05-01", "2026-05-05"],
  ["2026-06-19", "2026-06-21"],
  ["2026-09-25", "2026-09-27"],
  ["2026-10-01", "2026-10-07"],
];
const makeup2026 = ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"];
function datesInRange(start, end) {
  const out = [];
  const cursor = new Date(start + "T12:00:00Z");
  const stop = new Date(end + "T12:00:00Z");
  while (cursor <= stop) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
const calendar = {
  restDays: holidays2026.flatMap(([a, b]) => datesInRange(a, b)),
  workDays: [...makeup2026],
  years: [2025, 2026],
  source: "mock-2026",
};

const now = () => new Date().toISOString();
let nextUserId = 2;
let nextRequestId = 1;
let nextDomainId = 3;
let nextLogId = 1;
let nextVersionId = 1;
let revision = 0;
const sessions = new Map();
const passwords = new Map();
const avatars = new Map();
const preferences = new Map();
const sseClients = new Set();

const users = [{ id: "u1", username: "张金科", role: "superadmin", disabled: false, deleted: false, avatar: "" }];
const domains = [
  { id: "d1", name: "流量域", color: "#3b82f6" },
  { id: "d2", name: "广告域", color: "#f97316" },
];
const requests = [];
const logs = [];
const versions = [];
let setupRequired = true;

function defaultPreferences() {
  return { theme: "system", density: "compact", defaultPriority: "P1", defaultRequestType: "常规需求", domainColors: {}, ui: {} };
}
function prefsFor(id) {
  if (!preferences.has(id)) preferences.set(id, defaultPreferences());
  return preferences.get(id);
}
function broadcast() {
  const payload = `event: change\ndata: ${JSON.stringify({ revision })}\n\n`;
  for (const res of sseClients) res.write(payload);
}
function touch() {
  revision += 1;
  broadcast();
}
function sessionUser(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)rsm_session=([^;]+)/);
  if (!match) return null;
  const id = sessions.get(match[1]);
  return users.find((user) => user.id === id && !user.deleted && !user.disabled) || null;
}
function publicUsers() {
  return users.filter((user) => !user.deleted).map((user) => ({ ...user, username: user.username }));
}
function stateFor(req, overrideMe) {
  const me = overrideMe === undefined ? sessionUser(req) : overrideMe;
  return {
    revision,
    requests: requests.map((row) => ({ ...row })),
    domains: domains.map((domain) => ({ ...domain })),
    users: publicUsers(),
    me,
    preferences: me ? prefsFor(me.id) : defaultPreferences(),
    logs: logs.map((entry) => ({ ...entry })),
    versions: versions.map((version) => ({ ...version })),
    calendar,
    setupRequired,
    serverVersion: "0.1.0-e2e",
  };
}
function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}
function error(res, status, message, code) {
  send(res, status, { error: message, code });
}
function requireUser(req, res) {
  const me = sessionUser(req);
  if (!me) {
    error(res, 401, "请先登录", "unauthorized");
    return null;
  }
  return me;
}
function requireAdmin(req, res) {
  const me = requireUser(req, res);
  if (!me) return null;
  if (me.role !== "superadmin" && me.role !== "admin") {
    error(res, 403, "权限不足", "forbidden");
    return null;
  }
  return me;
}
function requireSuper(req, res) {
  const me = requireUser(req, res);
  if (!me) return null;
  if (me.role !== "superadmin") {
    error(res, 403, "仅超级管理员可操作", "forbidden");
    return null;
  }
  return me;
}
function log(actor, action, reversible = true) {
  logs.unshift({ id: nextLogId++, actor, action, createdAt: now(), reversible, undone: false });
  logs.length = Math.min(logs.length, 200);
}
function checkBase(body, res) {
  if (typeof body?.baseRevision !== "number") {
    error(res, 400, "缺少 baseRevision", "missing_base_revision");
    return false;
  }
  if (body.baseRevision !== revision) {
    error(res, 409, "数据已被其他人更新，请刷新后重试", "revision_conflict");
    return false;
  }
  return true;
}
function normalizeRequest(input, existing) {
  const base = {
    id: existing?.id ?? nextRequestId++,
    revision: existing ? existing.revision + 1 : 1,
    name: String(input.name || "").trim(),
    priority: input.priority || "P1",
    status: input.status || "待评审",
    prd: input.prd || "",
    requester: input.requester || "",
    requestedAt: input.requestedAt || new Date().toISOString().slice(0, 10),
    domain: input.domain || "",
    requestType: input.requestType || "常规需求",
    wangyue: input.wangyue || "",
    developer: input.developer || "",
    days: Number(input.days) || 0,
    start: input.start || "",
    delivery: input.delivery || "",
    project: input.project || "",
    brd: input.brd || "",
    review: input.review || "",
    expected: input.expected || "",
    notes: input.notes || "",
    segments: Array.isArray(input.segments) ? input.segments.map((segment) => ({ start: segment.start, end: segment.end, holdBefore: Boolean(segment.holdBefore) })) : [],
    vacation: Array.isArray(input.vacation) ? [...input.vacation] : [],
    overtime: Array.isArray(input.overtime) ? [...input.overtime] : [],
    archived: Boolean(existing?.archived ?? input.archived ?? false),
  };
  return base;
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buffer = await readBody(req);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString("utf8"));
}
function cookieHeader(token) {
  return { "Set-Cookie": `rsm_session=${token}; Path=/; HttpOnly; SameSite=Lax` };
}
function openSession(user) {
  const token = crypto.randomUUID();
  sessions.set(token, user.id);
  return token;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method || "GET";
  try {
    if (path === "/healthz") {
      send(res, 200, { status: "ok", version: "0.1.0-e2e", revision, schemaVersion: 1 });
      return;
    }
    if (path === "/api/state" && method === "GET") {
      send(res, 200, stateFor(req));
      return;
    }
    if (path === "/api/setup" && method === "POST") {
      const body = await readJson(req);
      if (!setupRequired) {
        error(res, 400, "已完成初始化", "already_setup");
        return;
      }
      if (typeof body.password !== "string" || !body.password.length) {
        error(res, 400, "密码至少 1 个字符", "weak_password");
        return;
      }
      setupRequired = false;
      passwords.set("u1", body.password);
      const token = openSession(users[0]);
      touch();
      send(res, 200, stateFor(req, users[0]), cookieHeader(token));
      return;
    }
    if (path === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const user = users.find((candidate) => candidate.username === body.username && !candidate.deleted);
      if (!user || user.disabled) {
        error(res, 401, "用户名或密码不正确", "bad_credentials");
        return;
      }
      if (!passwords.has(user.id) || passwords.get(user.id) !== body.password) {
        error(res, 401, "用户名或密码不正确", "bad_credentials");
        return;
      }
      const token = openSession(user);
      send(res, 200, stateFor(req, user), cookieHeader(token));
      return;
    }
    if (path === "/api/logout" && method === "POST") {
      const cookie = req.headers.cookie || "";
      const match = cookie.match(/(?:^|;\s*)rsm_session=([^;]+)/);
      if (match) sessions.delete(match[1]);
      send(res, 200, stateFor(req), { "Set-Cookie": "rsm_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" });
      return;
    }
    if (path === "/api/presence" && method === "POST") {
      const ids = [...new Set([...sessions.values()])].filter((id) => users.some((user) => user.id === id && !user.deleted && !user.disabled));
      send(res, 200, { users: ids, guests: 0 });
      return;
    }
    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`);
      sseClients.add(res);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return;
    }
    if (path === "/api/auth/password" && method === "POST") {
      const me = requireUser(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (passwords.get(me.id) !== body.currentPassword) {
        error(res, 400, "当前密码不正确", "bad_password");
        return;
      }
      if (typeof body.password !== "string" || !body.password.length) {
        error(res, 400, "新密码至少 1 个字符", "weak_password");
        return;
      }
      passwords.set(me.id, body.password);
      log(me.username, "修改本人密码");
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const passwordMatch = path.match(/^\/api\/auth\/password\/([^/]+)$/);
    if (passwordMatch && method === "GET") {
      const me = requireSuper(req, res);
      if (!me) return;
      send(res, 200, { password: passwords.get(passwordMatch[1]) || "" });
      return;
    }
    if (path === "/api/users" && method === "POST") {
      const me = requireAdmin(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (typeof body.password !== "string" || !body.password.length) {
        error(res, 400, "初始密码至少 1 个字符", "weak_password");
        return;
      }
      if (users.some((user) => user.username === body.username && !user.deleted)) {
        error(res, 400, "用户名已存在", "duplicate_username");
        return;
      }
      const user = { id: `u${nextUserId++}`, username: body.username, role: body.role || "collaborator", disabled: false, deleted: false, avatar: "" };
      users.push(user);
      passwords.set(user.id, body.password || TEST_PASSWORD);
      log(me.username, `创建账号：${user.username}`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && method === "PATCH") {
      const me = requireAdmin(req, res);
      if (!me) return;
      const target = users.find((user) => user.id === userMatch[1]);
      if (!target) {
        error(res, 404, "账号不存在", "not_found");
        return;
      }
      if (target.role === "superadmin" && me.role !== "superadmin") {
        error(res, 403, "权限不足", "forbidden");
        return;
      }
      const body = await readJson(req);
      if (typeof body.role === "string" && target.role !== "superadmin") target.role = body.role;
      if (typeof body.disabled === "boolean" && target.role !== "superadmin") target.disabled = body.disabled;
      if (typeof body.deleted === "boolean" && target.role !== "superadmin") target.deleted = body.deleted;
      if (typeof body.password === "string" && body.password) passwords.set(target.id, body.password);
      log(me.username, `更新账号：${target.username}`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    if (path === "/api/preferences" && method === "PUT") {
      const me = requireUser(req, res);
      if (!me) return;
      preferences.set(me.id, await readJson(req));
      send(res, 200, stateFor(req));
      return;
    }
    if (path === "/api/avatar" && method === "POST") {
      const me = requireUser(req, res);
      if (!me) return;
      const buffer = await readBody(req);
      avatars.set(me.id, { bytes: buffer, type: req.headers["content-type"] || "application/octet-stream" });
      me.avatar = `/api/avatars/${me.id}?v=${Date.now()}`;
      log(me.username, "更新头像", false);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const avatarMatch = path.match(/^\/api\/avatars\/([^/]+)$/);
    if (avatarMatch && method === "GET") {
      const record = avatars.get(avatarMatch[1]);
      if (!record) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": record.type, "Cache-Control": "no-store" });
      res.end(record.bytes);
      return;
    }
    if (path === "/api/requests" && method === "POST") {
      const me = requireAdmin(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      const row = normalizeRequest(body.request || {});
      requests.unshift(row);
      log(me.username, `新增需求：${row.name}`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    if (path === "/api/requests/batch" && method === "POST") {
      const me = requireAdmin(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      for (const input of body.requests || []) {
        const index = requests.findIndex((row) => row.id === input.id);
        if (index >= 0) requests[index] = normalizeRequest(input, requests[index]);
      }
      log(me.username, `顺排需求：${(body.requests || []).length} 条`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const archiveMatch = path.match(/^\/api\/requests\/(\d+)\/archive$/);
    if (archiveMatch && method === "POST") {
      const me = requireAdmin(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      const row = requests.find((item) => item.id === Number(archiveMatch[1]));
      if (!row) {
        error(res, 404, "需求不存在", "not_found");
        return;
      }
      row.archived = Boolean(body.archived);
      row.revision += 1;
      log(me.username, `${row.archived ? "归档" : "恢复"}需求：${row.name}`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const requestMatch = path.match(/^\/api\/requests\/(\d+)$/);
    if (requestMatch) {
      if (method === "PUT") {
        const me = requireAdmin(req, res);
        if (!me) return;
        const body = await readJson(req);
        if (!checkBase(body, res)) return;
        const index = requests.findIndex((row) => row.id === Number(requestMatch[1]));
        if (index < 0) {
          error(res, 404, "需求不存在", "not_found");
          return;
        }
        if (body.request?.revision !== requests[index].revision) {
          error(res, 409, "该需求已被其他人修改", "request_revision_conflict");
          return;
        }
        requests[index] = normalizeRequest(body.request, requests[index]);
        log(me.username, `编辑需求：${requests[index].name}`);
        touch();
        send(res, 200, stateFor(req));
        return;
      }
      if (method === "DELETE") {
        const me = requireAdmin(req, res);
        if (!me) return;
        const body = await readJson(req);
        if (!checkBase(body, res)) return;
        const index = requests.findIndex((row) => row.id === Number(requestMatch[1]));
        if (index < 0) {
          error(res, 404, "需求不存在", "not_found");
          return;
        }
        const [row] = requests.splice(index, 1);
        log(me.username, `删除需求：${row.name}`);
        touch();
        send(res, 200, stateFor(req));
        return;
      }
    }
    if (path === "/api/domains" && method === "POST") {
      const me = requireSuper(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      const domain = { id: `d${nextDomainId++}`, name: body.name, color: body.color || "#3b82f6" };
      domains.push(domain);
      log(me.username, `新增业务域：${domain.name}`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const domainMatch = path.match(/^\/api\/domains\/([^/]+)$/);
    if (domainMatch) {
      const me = requireSuper(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      const domain = domains.find((item) => item.id === domainMatch[1]);
      if (!domain) {
        error(res, 404, "业务域不存在", "not_found");
        return;
      }
      if (method === "PUT") {
        domain.name = body.name ?? domain.name;
        domain.color = body.color ?? domain.color;
        log(me.username, `修改业务域：${domain.name}`);
      } else if (method === "DELETE") {
        if (requests.some((row) => row.domain === domain.name)) {
          error(res, 400, "仍有需求引用该业务域", "domain_in_use");
          return;
        }
        domains.splice(domains.indexOf(domain), 1);
        log(me.username, `删除业务域：${domain.name}`);
      }
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    if (path === "/api/fields/merge" && method === "POST") {
      const me = requireSuper(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      const values = new Set(body.values || []);
      let count = 0;
      for (const row of requests) {
        if (values.has(row[body.field])) {
          row[body.field] = body.target;
          row.revision += 1;
          count += 1;
        }
      }
      log(me.username, `合并字段：${body.field}，${count} 条需求`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    if (path === "/api/versions" && method === "POST") {
      const me = requireAdmin(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      versions.unshift({ id: `v${nextVersionId++}`, label: body.label || "0000", actor: me.username, createdAt: now(), revision });
      log(me.username, `保存版本：${body.label}`);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const versionMatch = path.match(/^\/api\/versions\/([^/]+)(\/restore)?$/);
    if (versionMatch) {
      const me = requireAdmin(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      const index = versions.findIndex((version) => version.id === versionMatch[1]);
      if (index < 0) {
        error(res, 404, "版本不存在", "not_found");
        return;
      }
      const version = versions[index];
      if (versionMatch[2]) {
        log(me.username, `恢复版本：${version.label}`);
      } else if (method === "DELETE") {
        versions.splice(index, 1);
        log(me.username, `删除版本：${version.label}`);
      }
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    const undoMatch = path.match(/^\/api\/history\/(\d+)\/undo$/);
    if (undoMatch && method === "POST") {
      const me = requireAdmin(req, res);
      if (!me) return;
      const body = await readJson(req);
      if (!checkBase(body, res)) return;
      const entry = logs.find((item) => item.id === Number(undoMatch[1]));
      if (entry) entry.undone = true;
      log(me.username, `撤回变更：${entry?.action || ""}`, false);
      touch();
      send(res, 200, stateFor(req));
      return;
    }
    error(res, 404, "接口不存在", "not_found");
  } catch (caught) {
    console.error(caught);
    if (!res.headersSent) error(res, 500, "测试服务内部错误", "internal");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-api] listening on http://127.0.0.1:${PORT}`);
});
