/**
 * 服务层(Phase 1 M3):把数据层与研究运行以纯函数 / 薄封装暴露给 MCP server 与 HTTP API。
 * 约束:输入全部闭合校验(代码白名单 / 市场枚举 / run_id · session 正则 / args 只允许注册表声明的键与原始类型);
 * 路径全部经 safePath()(词法前缀 + realpath + 逐级禁符号链接,只在用户数据区 .local 内);取数仍由子进程 fetch_endpoint.py 执行(最小环境 + 该端点 auth_env);
 * 研究运行 detached 拉起 run.ts(最小环境:基础 + VRA_* + provider env_key);返回值只含相对路径,错误信息脱敏;不碰 ~/.codex;不返回任何密钥。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FETCH_ENV_KEYS, RUN_ID_RE, stages as packStages, fetchEnv } from "./config.ts";
import { readJsonIfExists } from "./fsutil.ts";
import { recallKnowledge, type KnowledgeRecall } from "./knowledge.ts";
import { loadProductConfig } from "./productConfig.ts";
import { REGISTRY_REL, loadRegistry, type EndpointDef } from "./registry.ts";


// **composition root**:垂类包在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register.ts";
export interface ServiceContext { repoRoot: string; dataRoot: string; python: string; node: string; providerEnvKey: string | null }

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 从产品配置链解析服务上下文(与 run.ts 同源:vibe-research.config.json ← .local/config.json ← VRA_*);VRA_REPO_ROOT 可指定仓库(测试 / 多副本) */
export function serviceContext(opts: { repoRoot?: string; python?: string; env?: NodeJS.ProcessEnv } = {}): ServiceContext {
  const env = opts.env ?? process.env;
  const repoRoot = path.resolve(opts.repoRoot ?? env.VRA_REPO_ROOT ?? repoRootFromHere());
  const pc = loadProductConfig(repoRoot, { env });
  return { repoRoot, dataRoot: pc.resolved.dataRoot, python: opts.python ?? pc.python ?? "python3", node: process.execPath, providerEnvKey: pc.provider?.env_key ?? null };
}

export class ServiceError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,12}$/;       // 主体代码:数字 / 字母 / 点 / 连字符,长度 1-12
const SYMBOL_FREE_RE = /^[^\s\/\\]{1,40}$/;       // raw 类端点(关键词 / 指数)允许中文,但不允许路径分隔符与空白
const MARKETS = new Set(["", "SH", "SZ", "BJ", "CN", "US", "HK"]);
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 注册表未声明、但 mapper 通用读取的参数键 */
const GLOBAL_ARG_KEYS = new Set(["limit", "date"]);
const MAX_ARG_KEYS = 20;
const MAX_ARG_STR = 200;
const MAX_ARG_ARR = 50;

const show = (v: unknown) => JSON.stringify(String(v ?? "")).slice(0, 48);

export function assertSymbol(symbol: unknown, kind: string | undefined): string {
  const s = String(symbol ?? "").trim();
  const re = kind === "raw" || kind === "none" ? SYMBOL_FREE_RE : SYMBOL_RE;
  if (!re.test(s)) throw new ServiceError("bad_symbol", `非法代码 ${show(symbol)}`);
  return s;
}

export function assertMarket(market: unknown): string {
  const m = String(market ?? "").toUpperCase();
  if (!MARKETS.has(m)) throw new ServiceError("bad_market", `非法市场 ${show(market)}(只接受 SH/SZ/BJ/CN/US/HK 或空)`);
  return m;
}

export function assertRunId(runId: unknown): string {
  const s = String(runId ?? "");
  if (!RUN_ID_RE.test(s)) throw new ServiceError("bad_run_id", `非法 run-id ${show(runId)}`);
  return s;
}

export function assertScope(v: unknown): "full" | "core" {
  if (v === undefined || v === "full") return "full";
  if (v === "core") return "core";
  throw new ServiceError("bad_scope", `endpoints 只能是 full|core,收到 ${show(v)}`);
}

export function assertKnowledgeFlag(v: unknown): "on" | "off" {
  if (v === undefined || v === "on") return "on";
  if (v === "off") return "off";
  throw new ServiceError("bad_knowledge", `knowledge 只能是 on|off,收到 ${show(v)}`);
}

/** args 闭合校验:键 ⊆ 注册表 args 声明 ∪ {limit, date};值只允许 原始类型 / 原始类型数组;限长限量 */
export function assertArgs(ep: EndpointDef, args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ServiceError("bad_args", "args 必须是对象");
  const allowed = new Set([...Object.keys(ep.args ?? {}), ...GLOBAL_ARG_KEYS]);
  const out: Record<string, unknown> = {};
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length > MAX_ARG_KEYS) throw new ServiceError("bad_args", `args 键过多(> ${MAX_ARG_KEYS})`);
  const prim = (v: unknown, k: string) => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) throw new ServiceError("bad_args", `args.${k} 不是有限数`); return v; }
    if (typeof v === "string") { if (v.length > MAX_ARG_STR) throw new ServiceError("bad_args", `args.${k} 过长(> ${MAX_ARG_STR})`); return v; }
    throw new ServiceError("bad_args", `args.${k} 只允许 字符串 / 数字 / 布尔 / null 或其数组`);
  };
  for (const [k, v] of entries) {
    if (!allowed.has(k)) throw new ServiceError("bad_args", `端点 ${ep.id} 不接受参数 ${show(k)}(允许:${[...allowed].join(", ") || "无"})`);
    if (Array.isArray(v)) { if (v.length > MAX_ARG_ARR) throw new ServiceError("bad_args", `args.${k} 数组过长`); out[k] = v.map((x) => prim(x, k)); }
    else out[k] = prim(v, k);
  }
  return out;
}

/** 用户数据区内的安全路径:词法前缀 + 已存在的每一级都不得是符号链接 + 最深存在祖先的 realpath 仍在 dataRoot 的 realpath 内 */
export function safePath(ctx: Pick<ServiceContext, "dataRoot">, ...segments: string[]): string {
  const rootAbs = path.resolve(ctx.dataRoot);
  const abs = path.resolve(rootAbs, ...segments);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new ServiceError("path_escape", `路径越出用户数据区`);
  let cur = abs;
  const chain: string[] = [];
  while (cur !== rootAbs && cur.startsWith(rootAbs + path.sep)) { chain.unshift(cur); cur = path.dirname(cur); }
  for (const p of chain) {
    if (!fs.existsSync(p)) break;
    if (fs.lstatSync(p).isSymbolicLink()) throw new ServiceError("path_symlink", `用户数据区内存在符号链接,拒绝访问:${path.relative(rootAbs, p)}`);
  }
  const deepest = chain.filter((p) => fs.existsSync(p)).pop() ?? rootAbs;
  if (fs.existsSync(rootAbs)) {
    const realRoot = fs.realpathSync(rootAbs);
    const realDeep = fs.realpathSync(deepest);
    if (realDeep !== realRoot && !realDeep.startsWith(realRoot + path.sep)) throw new ServiceError("path_escape", "路径 realpath 越出用户数据区");
  }
  return abs;
}

const rel = (ctx: Pick<ServiceContext, "dataRoot">, p: string) => path.relative(path.resolve(ctx.dataRoot), p).split(path.sep).join("/");

/** 错误 / stderr 脱敏:去 URL 查询串、遮蔽 key/token/secret/password 赋值、截断 */
export function redact(s: string, max = 300): string {
  return String(s ?? "").replace(/([?&][^=\s&]*(key|token|secret|sig|signature|password|access)[^=\s&]*=)[^&\s]+/gi, "$1***").replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, "$1?…")
    .replace(/((api[_-]?key|secret|token|password|authorization)\s*[:=]\s*)\S+/gi, "$1***").slice(-max);
}

/** 研究子进程 / 批量子进程的最小环境:基础 + VRA_* + provider 的 env_key(若设置);不透传其它 *KEY* / *TOKEN* */
export function researchEnv(ctx: Pick<ServiceContext, "providerEnvKey">, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FETCH_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k] as string;
  for (const [k, v] of Object.entries(env)) if (k.startsWith("VRA_") && v !== undefined) out[k] = v;
  if (ctx.providerEnvKey && env[ctx.providerEnvKey]) out[ctx.providerEnvKey] = env[ctx.providerEnvKey] as string;
  return out;
}

// ---------------- 注册表 ----------------
export interface EndpointSummary { id: string; title?: string; layer?: string; market: string[]; source?: string; compliance?: string; symbol_kind?: string; stages: Record<string, string>; enabled: boolean; auth_env?: string; computed?: boolean; notes?: string; args?: Record<string, unknown> }

export function listEndpoints(ctx: ServiceContext, filter: { layer?: string; market?: string; q?: string; enabled_only?: boolean } = {}): EndpointSummary[] {
  const reg = loadRegistry(ctx.repoRoot);
  if (!reg) throw new ServiceError("no_registry", `注册表不存在:${REGISTRY_REL}`);
  const q = String(filter.q ?? "").toLowerCase().slice(0, 80);
  const layer = String(filter.layer ?? "").slice(0, 40);
  const market = String(filter.market ?? "").toUpperCase().slice(0, 4);
  return reg.endpoints
    .filter((e) => (!layer || String(e.layer ?? "").startsWith(layer)) && (!market || e.market.includes(market)) && (!filter.enabled_only || e.enabled !== false)
      && (!q || `${e.id} ${e.title ?? ""} ${e.source ?? ""} ${e.layer ?? ""}`.toLowerCase().includes(q)))
    .map((e) => ({ id: e.id, title: e.title, layer: e.layer, market: e.market, source: e.source, compliance: e.compliance, symbol_kind: e.symbol_kind, stages: e.stages ?? {}, enabled: e.enabled !== false, auth_env: e.auth_env, computed: e.computed === true, notes: e.notes, args: e.args }));
}

export function endpointDef(ctx: ServiceContext, id: unknown): EndpointDef {
  const sid = String(id ?? "");
  const reg = loadRegistry(ctx.repoRoot);
  const ep = reg?.endpoints.find((e) => e.id === sid);
  if (!ep) throw new ServiceError("unknown_endpoint", `注册表无端点 ${show(id)}`);
  return ep;
}

// ---------------- 取数(子进程,落 .local/mcp/<session>/) ----------------
export interface FetchResult { envelope: Record<string, unknown>; exit_code: number | null; out_dir: string; duration_ms: number; stderr_tail: string }

export function fetchEndpoint(ctx: ServiceContext, req: { endpoint: string; symbol?: string; args?: Record<string, unknown>; session?: string; timeout_ms?: number }): FetchResult {
  const ep = endpointDef(ctx, req.endpoint);
  const session = String(req.session ?? "default");
  if (!SESSION_RE.test(session)) throw new ServiceError("bad_session", `非法 session ${show(session)}`);
  const outDir = safePath(ctx, "mcp", session);
  fs.mkdirSync(path.join(outDir, "fetch"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
  safePath(ctx, "mcp", session, "fetch");  // 创建后再查一次(防 mkdir 途中被替换成链接)
  const argv = [path.join(ctx.repoRoot, ".agents", "skills", "data-access", "scripts", "fetch_endpoint.py"), "--endpoint", ep.id, "--out-dir", outDir];
  if (ep.symbol_kind !== "none") {
    if (req.symbol === undefined) throw new ServiceError("missing_symbol", `端点 ${ep.id} 需要 symbol`);
    argv.push("--symbol", assertSymbol(req.symbol, ep.symbol_kind));
  }
  const args = assertArgs(ep, req.args);
  if (Object.keys(args).length) argv.push("--args", JSON.stringify(args));
  // 取数进程:最小环境 + 该端点声明的 auth_env(只此一个)+ 用户显式的 TLS 降级开关
  const extra: Record<string, string> = {};
  if (ep.auth_env && process.env[ep.auth_env]) extra[ep.auth_env] = process.env[ep.auth_env] as string;
  if (process.env.VRA_ALLOW_INSECURE_TLS) extra.VRA_ALLOW_INSECURE_TLS = process.env.VRA_ALLOW_INSECURE_TLS;
  const timeout = Math.min(Math.max(Number(req.timeout_ms) || 180_000, 1_000), 600_000);
  const t0 = Date.now();
  const p = spawnSync(ctx.python, argv, { cwd: ctx.repoRoot, env: fetchEnv(extra), encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  const dur = Date.now() - t0;
  if (p.error) throw new ServiceError("spawn_failed", `取数进程失败:${redact(p.error.message, 120)}`);
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(p.stdout) as Record<string, unknown>; }
  catch { throw new ServiceError("bad_envelope", `取数器未输出合法 JSON(退出码 ${p.status}):${redact(p.stderr || "", 200)}`); }
  return { envelope, exit_code: p.status, out_dir: rel(ctx, outDir), duration_ms: dur, stderr_tail: redact(p.stderr || "", 300) };
}

// ---------------- 研究运行 ----------------
export interface StartResult { run_id: string; run_dir: string; log: string; pid: number | undefined }

export function startResearch(ctx: ServiceContext, req: { symbol: string; market?: string; stages?: string[]; endpoints?: "full" | "core"; knowledge?: "on" | "off"; run_id?: string; overwrite?: boolean; no_agent?: boolean }): StartResult {
  const symbol = assertSymbol(req.symbol, "cn6");
  const market = assertMarket(req.market);
  const stages = Array.isArray(req.stages) ? req.stages.map(String) : [];
  for (const s of stages) if (!packStages().includes(s)) throw new ServiceError("bad_stage", `未知阶段 ${show(s)}`);
  const scope = assertScope(req.endpoints);
  const kn = assertKnowledgeFlag(req.knowledge);
  const runId = req.run_id !== undefined ? assertRunId(req.run_id) : `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${symbol}-svc`;
  const runDir = safePath(ctx, "runs", runId);
  fs.mkdirSync(safePath(ctx, "logs"), { recursive: true });
  const log = safePath(ctx, "logs", `${runId}.log`);  // 最终文件也经 safePath(已存在且为链接 → 拒绝)
  const argv = [path.join(ctx.repoRoot, "orchestrator", "src", "run.ts"), "--symbol", symbol, "--run-id", runId, "--python", ctx.python, "--endpoints", scope, "--knowledge", kn];
  if (market) argv.push("--market", market);
  if (stages.length) argv.push("--stages", stages.join(","));
  if (req.overwrite === true) argv.push("--overwrite");
  if (req.no_agent === true) argv.push("--no-agent");
  const out = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);  // O_NOFOLLOW:纵深防御
  const child = spawn(ctx.node, argv, { cwd: ctx.repoRoot, detached: true, stdio: ["ignore", out, out], env: researchEnv(ctx) });
  child.unref();
  fs.closeSync(out);
  return { run_id: runId, run_dir: rel(ctx, runDir), log: rel(ctx, log), pid: child.pid };
}

export interface RunStatus { run_id: string; exists: boolean; status: string | null; exit_code: number | null; stages: { stage: string; status: string; attempts: number }[]; evidence_count: number | null; calculation_count: number | null; finished_at: string | null; last_events: Record<string, unknown>[]; report: boolean; viewer: string | null }

function runDirOf(ctx: ServiceContext, runId: unknown): { id: string; dir: string } {
  const id = assertRunId(runId);
  return { id, dir: safePath(ctx, "runs", id) };
}

export function researchStatus(ctx: ServiceContext, runId: string, lastEvents = 8): RunStatus {
  const { id, dir: runDir } = runDirOf(ctx, runId);
  if (!fs.existsSync(runDir)) return { run_id: id, exists: false, status: null, exit_code: null, stages: [], evidence_count: null, calculation_count: null, finished_at: null, last_events: [], report: false, viewer: null };
  const m = readJsonIfExists<Record<string, unknown>>(safePath(ctx, "runs", id, "manifest.json"));
  const evPath = safePath(ctx, "runs", id, "events.jsonl");
  let events: Record<string, unknown>[] = [];
  if (fs.existsSync(evPath)) {
    const n = Math.min(Math.max(Number(lastEvents) || 8, 1), 50);
    const lines = fs.readFileSync(evPath, "utf8").trim().split("\n").filter(Boolean);
    events = lines.slice(-n).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { raw: l.slice(0, 200) }; } });
  }
  const stages = ((m?.stages as { stage: string; status: string; attempts: number }[] | undefined) ?? []).map((s) => ({ stage: s.stage, status: s.status, attempts: s.attempts }));
  const viewer = fs.existsSync(safePath(ctx, "runs", id, "viewer.html")) ? `runs/${id}/viewer.html` : null;
  return { run_id: id, exists: true, status: (m?.status as string) ?? null, exit_code: (m?.exit_code as number) ?? null, stages, evidence_count: (m?.evidence_count as number) ?? null, calculation_count: (m?.calculation_count as number) ?? null,
    finished_at: (m?.finished_at as string) ?? null, last_events: events, report: fs.existsSync(safePath(ctx, "runs", id, "report.md")), viewer };
}

export function readRunFile(ctx: ServiceContext, runId: string, name: "manifest.json" | "report.md" | "report_appendix.md" | "viewer.html"): string | null {
  const { id } = runDirOf(ctx, runId);
  const p = safePath(ctx, "runs", id, name);
  if (!fs.existsSync(p) || !fs.lstatSync(p).isFile()) return null;
  return fs.readFileSync(p, "utf8");
}

export function getReport(ctx: ServiceContext, runId: string): { run_id: string; report: string | null; appendix: string | null } {
  const { id } = runDirOf(ctx, runId);
  return { run_id: id, report: readRunFile(ctx, id, "report.md"), appendix: readRunFile(ctx, id, "report_appendix.md") };
}

export function getEvidence(ctx: ServiceContext, runId: string, filter: { field?: string; source?: string; q?: string; limit?: number } = {}): { run_id: string; total: number; items: Record<string, unknown>[] } {
  const { id } = runDirOf(ctx, runId);
  const merged = readJsonIfExists<Record<string, unknown>[] | { evidence: Record<string, unknown>[] }>(safePath(ctx, "runs", id, "evidence.json"));
  const items: Record<string, unknown>[] = Array.isArray(merged) ? merged : (merged?.evidence ?? []);
  if (!items.length) {
    const fdir = safePath(ctx, "runs", id, "fetch");
    if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir)) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      const env = readJsonIfExists<{ evidence?: Record<string, unknown>[] }>(safePath(ctx, "runs", id, "fetch", f));
      items.push(...(env?.evidence ?? []));
    }
  }
  const q = String(filter.q ?? "").toLowerCase().slice(0, 80);
  const field = filter.field === undefined ? undefined : String(filter.field).slice(0, 80);
  const source = filter.source === undefined ? undefined : String(filter.source).slice(0, 80);
  const out = items.filter((e) => (!field || e.field === field) && (!source || e.source === source) && (!q || JSON.stringify(e).toLowerCase().includes(q)));
  const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 2000);
  return { run_id: id, total: out.length, items: out.slice(0, limit) };
}

export function listRuns(ctx: ServiceContext, limit = 50): { run_id: string; status: string | null; symbol: string | null; started_at: string | null; finished_at: string | null }[] {
  const root = path.join(path.resolve(ctx.dataRoot), "runs");
  if (!fs.existsSync(root)) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return fs.readdirSync(root).filter((d) => RUN_ID_RE.test(d) && fs.lstatSync(path.join(root, d)).isDirectory()).sort().reverse().slice(0, n).map((d) => {
    let m: Record<string, unknown> | null = null;
    try { const mp = safePath(ctx, "runs", d, "manifest.json"); if (fs.existsSync(mp) && fs.lstatSync(mp).isFile()) m = readJsonIfExists<Record<string, unknown>>(mp); } catch { m = null; }  // manifest 是链接 → 当作不可读
    return { run_id: d, status: (m?.status as string) ?? null, symbol: (m?.symbol as string) ?? null, started_at: (m?.started_at as string) ?? null, finished_at: (m?.finished_at as string) ?? null };
  });
}

export function knowledgeRecall(ctx: ServiceContext, symbol: string, market: string): (Omit<KnowledgeRecall, "path"> & { path: string }) | null {
  const sym = assertSymbol(symbol, "cn6");
  const mk = assertMarket(market);
  safePath(ctx, "knowledge", "companies", `${mk || "XX"}_${sym}`, "latest.md");
  const k = recallKnowledge({ dataRoot: ctx.dataRoot, symbol: sym, market: mk });
  return k ? { ...k, path: rel(ctx, k.path) } : null;
}
