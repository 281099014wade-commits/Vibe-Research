/**
 * 数据源注册表(datasources/registry.json)读取与阶段计划推导(Phase 1 M1)。
 * core = 仅 legacy 8 脚本(Phase 0 行为,硬测试默认);full = 注册表里所有启用、市场匹配、声明了 stages 的端点(非 legacy 经 fetch_endpoint.py 通用取数器执行)。
 * 不 import config.ts 的运行时值(避免循环依赖);阶段列表由调用方传入。
 */
import fs from "node:fs";
import path from "node:path";

export type ScopeKind = "core" | "full";
export type StageLevel = "required" | "optional";

export interface EndpointDef {
  id: string;
  title?: string;
  layer?: string;
  market: string[];
  source?: string;
  compliance?: string;
  module: string;
  function: string;
  symbol_kind?: "cn6" | "us" | "hk" | "global" | "raw" | "none";
  symbol_param?: string;
  stages?: Record<string, StageLevel>;
  enabled?: boolean;
  critical?: boolean;
  args?: Record<string, unknown>;
  auth_env?: string;
  mapper?: string;
  mapper_module?: string;
  notes?: string;
  libs?: string[];
  sample?: string;
  /** 产业温度计:只在研究标的命中这些产业标签(datasources/industry_tags.json)时才取 */
  industry_tags?: string[];
  [k: string]: unknown;
}

export interface Registry { version: string; endpoints: EndpointDef[] }
export type StagePlan<S extends string = string> = Record<S, { required: string[]; optional: string[] }>;

export const REGISTRY_REL = path.join("datasources", "registry.json");
export const PLAN_REL = path.join("fetch", "_plan.json");

export function registryPath(repoRoot: string): string {
  return path.join(repoRoot, REGISTRY_REL);
}

/** 读注册表;文件不存在 → null(调用方回退 Phase 0 常量);内容非法 → 抛错(配置错误必须冒泡) */
export function loadRegistry(repoRoot: string): Registry | null {
  const p = registryPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  const reg = JSON.parse(fs.readFileSync(p, "utf8")) as Registry;
  if (!reg || typeof reg.version !== "string" || !Array.isArray(reg.endpoints)) throw new Error(`注册表结构非法:${p}`);
  const seen = new Set<string>();
  for (const e of reg.endpoints) {
    if (!e?.id || !e.module || !e.function || !Array.isArray(e.market)) throw new Error(`注册表端点缺字段(id/module/function/market):${JSON.stringify(e).slice(0, 120)}`);
    if (seen.has(e.id)) throw new Error(`注册表端点 id 重复:${e.id}`);
    seen.add(e.id);
    for (const [st, lvl] of Object.entries(e.stages ?? {})) if (lvl !== "required" && lvl !== "optional") throw new Error(`端点 ${e.id} 阶段 ${st} 的级别非法:${String(lvl)}`);
    // 产业温度计端点按标签门控,未命中会被整体跳过 → 只能是 optional(required 会被 validator 判"未执行")
    if (Array.isArray(e.industry_tags) && e.industry_tags.length && Object.values(e.stages ?? {}).includes("required")) throw new Error(`端点 ${e.id} 带 industry_tags 却是 required:按产业标签门控的端点只能 optional`);
  }
  return reg;
}

/** 运行市场 → 注册表市场区域:SH/SZ/BJ/CN/空(由脚本按代码归一) → CN;US;HK;其它一律拒绝(绝不猜市场) */
export function regionOf(market: string): "CN" | "US" | "HK" {
  const m = (market || "").toUpperCase();
  if (m === "US") return "US";
  if (m === "HK") return "HK";
  if (m === "" || m === "SH" || m === "SZ" || m === "BJ" || m === "CN") return "CN";
  throw new Error(`未知市场 ${market}(只接受 SH/SZ/BJ/CN/US/HK 或空)`);
}

/** 阶段计划:按注册表顺序;core 只含 legacy;full 含所有启用且市场匹配的端点 */
export function buildStagePlan<S extends string>(reg: Registry, stages: readonly S[], opts: { market: string; scope: ScopeKind }): StagePlan<S> {
  const region = regionOf(opts.market);
  const plan = {} as StagePlan<S>;
  for (const s of stages) plan[s] = { required: [], optional: [] };
  for (const ep of reg.endpoints) {
    if (ep.enabled === false) continue;
    if (opts.scope === "core" && ep.module !== "legacy") continue;
    if (!ep.market.includes(region)) continue;
    for (const [st, lvl] of Object.entries(ep.stages ?? {})) {
      if ((stages as readonly string[]).includes(st)) plan[st as S][lvl].push(ep.id);
    }
  }
  return plan;
}

/** 关键端点(全部失败 → 运行 failed):注册表 critical:true */
export function criticalScripts(reg: Registry): string[] {
  return reg.endpoints.filter((e) => e.critical === true && e.enabled !== false).map((e) => e.id);
}

export function endpointsById(reg: Registry): Record<string, EndpointDef> {
  const out: Record<string, EndpointDef> = {};
  for (const e of reg.endpoints) out[e.id] = e;
  return out;
}

/** 取数命令:legacy → 脚本自身;其余 → fetch_endpoint.py --endpoint <id>(symbol_kind=none 不传 --symbol) */
export function fetchArgv(def: EndpointDef | undefined, script: string, opts: { scriptsDir: string; symbol: string; runDir: string }): string[] {
  if (!def || def.module === "legacy") {
    const file = def?.function ?? `${script}.py`;
    return [path.join(opts.scriptsDir, file), "--symbol", opts.symbol, "--out-dir", opts.runDir];
  }
  const argv = [path.join(opts.scriptsDir, "fetch_endpoint.py"), "--endpoint", def.id, "--out-dir", opts.runDir];
  if (def.symbol_kind !== "none") argv.push("--symbol", opts.symbol);
  return argv;
}

/** 写入运行目录的计划文件(审计 + --no-agent 复核时 validator 读取) */
export interface PlanFile {
  scope: ScopeKind;
  registry_version: string | null;
  stage_plan: StagePlan;
  critical: string[];
  endpoints: Record<string, Pick<EndpointDef, "module" | "symbol_kind" | "title" | "source" | "compliance">>;
}

export function planFileOf(scope: ScopeKind, registryVersion: string | null, plan: StagePlan, critical: string[], endpoints: Record<string, EndpointDef>): PlanFile {
  const ids = new Set<string>();
  for (const v of Object.values(plan)) for (const id of [...v.required, ...v.optional]) ids.add(id);
  const eps: PlanFile["endpoints"] = {};
  for (const id of ids) {
    const d = endpoints[id];
    if (d) eps[id] = { module: d.module, symbol_kind: d.symbol_kind, title: d.title, source: d.source, compliance: d.compliance };
  }
  return { scope, registry_version: registryVersion, stage_plan: plan, critical, endpoints: eps };
}
