#!/usr/bin/env node
/**
 * 薄 HTTP API(Phase 1 M3):默认只绑 127.0.0.1(非回环地址绑定需显式 VRA_API_TOKEN 且关闭 cookie 登录,见 isLoopbackHost);**每个请求都要鉴权**:Bearer token(VRA_API_TOKEN 或自动生成写入 .local/api.token)对所有路由有效,
 * 回环下 /login?token= 换来的 cookie 只放行 COOKIE_GET_ROUTES 白名单里的只读 GET;拒绝非本机 Origin / 跨站 / 非 JSON POST(防浏览器 CSRF);同一 service 层;返回只含相对路径,错误脱敏。
 * 用法:node orchestrator/src/api.ts [--port 8765] [--host 127.0.0.1]
 * 路由:GET /endpoints[?layer=&market=&q=]  POST /fetch {endpoint, symbol?, args?, session?}  POST /research {symbol, market?, stages?, endpoints?, knowledge?}
 *      GET /runs  GET /runs/:id/status|manifest|report|evidence[?field=&q=]|viewer  GET /knowledge/:market/:symbol  GET /health
 * 薄 UI(M4):GET /login?token=<token> 用 token 换 HttpOnly+SameSite=Strict Cookie 并跳 /ui;GET /ui(运行列表)/ GET /ui/runs/:id(报告 + 查看器链接)。
 *      Cookie 只对白名单只读 GET 有效(COOKIE_GET_ROUTES:/ui、/ui/runs/:id、/runs、/runs/:id/viewer|report|status);其余 GET 与所有 POST 只认 Bearer(防 CSRF);所有响应带 SECURITY_HEADERS。
 */
import fs from "node:fs";
import { productVersion } from "./version.ts";
import http from "node:http";
import path from "node:path";

import crypto from "node:crypto";

import { ServiceError, fetchEndpoint, getEvidence, getReport, knowledgeRecall, listEndpoints, listRuns, readRunFile, redact, researchStatus, safePath, serviceContext, startResearch, type ServiceContext } from "./service.ts";

const MAX_BODY = 256 * 1024;

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(data), ...SECURITY_HEADERS });
  res.end(data);
}

/** 所有响应统一带:不缓存、不发 Referer(登录 URL 含 token)、禁止 MIME 嗅探 */
const SECURITY_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } as const;

/** Cookie 只对这些只读 GET 路由有效(白名单,而不是"任何 GET");其余路由只认 Bearer */
export const COOKIE_GET_ROUTES: readonly RegExp[] = [/^\/ui$/, /^\/ui\/runs\/[^/]+$/, /^\/runs$/, /^\/runs\/[^/]+\/(viewer|report|status)$/];

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > MAX_BODY) { reject(new ServiceError("body_too_large", "请求体过大")); req.destroy(); } });
    req.on("end", () => { if (!buf.trim()) return resolve({}); try { const v = JSON.parse(buf); resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {}); } catch { reject(new ServiceError("bad_json", "请求体不是合法 JSON")); } });
    req.on("error", reject);
  });
}

/** 浏览器跨站防护:带 Origin 的请求只接受本机来源;POST 必须是 application/json(浏览器表单 / text/plain 的无预检请求一律拒绝) */
function crossSiteReject(req: http.IncomingMessage): { code: number; error: string } | null {
  const origin = req.headers.origin;
  if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(origin))) return { code: 403, error: "forbidden_origin" };
  const sfs = req.headers["sec-fetch-site"];
  if (sfs && sfs !== "same-origin" && sfs !== "none") return { code: 403, error: "forbidden_cross_site" };
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return { code: 415, error: "content_type_must_be_json" };
  return null;
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const UI_CSS = "body{font-family:-apple-system,'PingFang SC',sans-serif;margin:0;background:#f6f7f9;color:#1f2328}header{background:#1f2d3d;color:#fff;padding:14px 20px}main{padding:16px 20px}table{border-collapse:collapse;background:#fff;font-size:14px}th,td{border:1px solid #e2e8f0;padding:6px 10px;text-align:left}th{background:#eef2f7}a{color:#1d4ed8}pre{background:#fff;border:1px solid #e2e8f0;padding:12px;white-space:pre-wrap;font-size:13px}.tag{padding:1px 6px;border-radius:4px;background:#e2e8f0}.complete{background:#d1fae5}.failed{background:#fee2e2}.incomplete,.stale{background:#fef3c7}";

function cookieToken(req: http.IncomingMessage): string | null {
  const m = /(?:^|;\s*)vra_token=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

function uiIndex(ctx: ServiceContext): string {
  const rows = listRuns(ctx, 200).map((r) => `<tr><td><a href="/ui/runs/${esc(r.run_id)}">${esc(r.run_id)}</a></td><td>${esc(r.symbol)}</td><td><span class="tag ${esc(r.status)}">${esc(r.status)}</span></td><td>${esc(r.started_at)}</td><td>${esc(r.finished_at)}</td><td><a href="/runs/${esc(r.run_id)}/viewer">查看器</a></td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Vibe Research · 运行列表</title><style>${UI_CSS}</style></head><body><header><h1>Vibe Research Agent · 运行列表</h1><div>本机只读页面;本页不提供任何投资动作建议。</div></header><main><table><thead><tr><th>run_id</th><th>标的</th><th>状态</th><th>开始</th><th>结束</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6">(尚无运行;用 node orchestrator/src/run.ts 跑一次)</td></tr>'}</tbody></table></main></body></html>`;
}

function uiRun(ctx: ServiceContext, id: string): string | null {
  const st = researchStatus(ctx, id);
  if (!st.exists) return null;
  const rep = getReport(ctx, id);
  const stages = st.stages.map((s) => `<li>${esc(s.stage)} <span class="tag ${esc(s.status)}">${esc(s.status)}</span> × ${s.attempts}</li>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Vibe Research · ${esc(id)}</title><style>${UI_CSS}</style></head><body><header><h1>${esc(st.run_id)} · <span class="tag ${esc(st.status)}">${esc(st.status)}</span></h1><div><a style="color:#9cf" href="/ui">← 运行列表</a> · 证据 ${st.evidence_count ?? "-"} · 计算 ${st.calculation_count ?? "-"} · ${st.viewer ? `<a style="color:#9cf" href="/runs/${esc(id)}/viewer">打开证据查看器</a>` : "无查看器"}</div></header><main><h2>阶段</h2><ul>${stages}</ul><h2>report.md</h2><pre>${esc(rep.report ?? "(无报告)")}</pre></main></body></html>`;
}

export function createApiServer(ctx: ServiceContext, opts: { token: string; cookieLogin?: boolean }): http.Server {
  if (!opts.token || opts.token.length < 16) throw new Error("API token 必须 ≥ 16 字符(默认随机生成并写入 .local/api.token)");
  const cookieLogin = opts.cookieLogin !== false;  // 非本机绑定(明文 HTTP)时由 main 关闭:cookie 会被网络观察者截获
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const cs = crossSiteReject(req);
      if (cs) return send(res, cs.code, { error: cs.error });
      // 鉴权:Bearer 对所有路由有效;Cookie(由 /login 用 token 换取)只对 COOKIE_GET_ROUTES 白名单里的只读 GET 有效(POST / 其它 GET 仍只认 Bearer,防 CSRF)
      const bearerOk = (req.headers.authorization ?? "") === `Bearer ${opts.token}`;
      if (req.method === "GET" && url.pathname === "/login") {
        if (!cookieLogin) return send(res, 404, { error: "cookie login disabled (non-loopback bind)" });
        if (url.searchParams.get("token") !== opts.token) return send(res, 401, { error: "unauthorized" });
        res.writeHead(302, { "Set-Cookie": `vra_token=${opts.token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/ui", ...SECURITY_HEADERS });
        return res.end();
      }
      const cookieOk = cookieLogin && req.method === "GET" && COOKIE_GET_ROUTES.some((re) => re.test(url.pathname)) && cookieToken(req) === opts.token;
      if (!bearerOk && !cookieOk) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/ui") return send(res, 200, uiIndex(ctx), "text/html; charset=utf-8");
      if (req.method === "GET" && /^\/ui\/runs\/[^/]+$/.test(url.pathname)) { const t = uiRun(ctx, decodeURIComponent(url.pathname.split("/")[3])); return t === null ? send(res, 404, { error: "no such run" }) : send(res, 200, t, "text/html; charset=utf-8"); }
      const parts = url.pathname.split("/").filter(Boolean);
      const q = Object.fromEntries(url.searchParams.entries());
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, version: productVersion() });
      if (req.method === "GET" && url.pathname === "/endpoints") return send(res, 200, listEndpoints(ctx, { layer: q.layer, market: q.market, q: q.q, enabled_only: q.enabled_only === "1" }));
      if (req.method === "POST" && url.pathname === "/fetch") { const b = await readBody(req); return send(res, 200, fetchEndpoint(ctx, b as never)); }
      if (req.method === "POST" && url.pathname === "/research") { const b = await readBody(req); return send(res, 202, startResearch(ctx, b as never)); }
      if (req.method === "GET" && url.pathname === "/runs") return send(res, 200, listRuns(ctx, q.limit ? Number(q.limit) : undefined));
      if (req.method === "GET" && parts[0] === "runs" && parts[1] && parts[2]) {
        const id = parts[1];
        if (parts[2] === "status") return send(res, 200, researchStatus(ctx, id));
        if (parts[2] === "report") return send(res, 200, getReport(ctx, id));
        if (parts[2] === "evidence") return send(res, 200, getEvidence(ctx, id, { field: q.field, source: q.source, q: q.q, limit: q.limit ? Number(q.limit) : undefined }));
        if (parts[2] === "manifest") { const t = readRunFile(ctx, id, "manifest.json"); return t === null ? send(res, 404, { error: "no such run" }) : send(res, 200, t); }
        if (parts[2] === "viewer") { const t = readRunFile(ctx, id, "viewer.html"); return t === null ? send(res, 404, { error: "no viewer" }) : send(res, 200, t, "text/html; charset=utf-8"); }
      }
      if (req.method === "GET" && parts[0] === "knowledge" && parts[1] && parts[2]) return send(res, 200, knowledgeRecall(ctx, parts[2], parts[1]));
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof ServiceError) return send(res, 400, { error: e.code, message: redact(e.message, 200) });
      console.error(`[api] internal error: ${redact(e instanceof Error ? e.stack ?? e.message : String(e), 600)}`);
      return send(res, 500, { error: "internal" });
    }
  });
}

/** token:VRA_API_TOKEN 优先;否则随机生成并写入 <dataRoot>/api.token(0600),客户端从该文件读 */
export function resolveToken(ctx: ServiceContext, env: NodeJS.ProcessEnv = process.env): { token: string; source: "env" | "file" | "generated"; file: string } {
  const file = safePath(ctx, "api.token");  // 文件本身若是符号链接 → safePath 拒绝(不跟随读 / 写数据区外文件)
  if (env.VRA_API_TOKEN && env.VRA_API_TOKEN.length >= 16) return { token: env.VRA_API_TOKEN, source: "env", file };
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile()) throw new ServiceError("path_symlink", "api.token 不是普通文件");
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 16) return { token: t, source: "file", file };
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  fs.writeSync(fd, token + "\n");
  fs.closeSync(fd);
  return { token, source: "generated", file };
}

/** 回环地址判定(绑定前置检查与 cookie 登录开关共用同一口径) */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf("--port") + 1] || 8765) || 8765;
  const host = args.includes("--host") ? args[args.indexOf("--host") + 1] : "127.0.0.1";
  const loopback = isLoopbackHost(host);
  if (!loopback && !process.env.VRA_API_TOKEN) { console.error("[api] 非回环地址绑定必须显式设置 VRA_API_TOKEN"); process.exit(2); }
  const ctx = serviceContext();
  const tk = resolveToken(ctx);
  const srv = createApiServer(ctx, { token: tk.token, cookieLogin: loopback });
  srv.listen(port, host, () => console.error(`[api] listening http://${host}:${port}  token 来源=${tk.source}(文件 .local/api.token;请求头 Authorization: Bearer <token>;${loopback ? `浏览器打开 http://${host}:${port}/login?token=<token> 进入运行列表页 /ui` : "非本机绑定:cookie 登录已关闭,只认 Bearer"})`));
}

if (process.argv[1] && (process.argv[1].endsWith("/api.ts") || process.argv[1].endsWith("\\api.ts"))) {
  main().catch((e) => { console.error(`[api] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
