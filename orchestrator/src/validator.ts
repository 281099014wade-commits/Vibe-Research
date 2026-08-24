/**
 * Validator:每阶段产物的机器校验(schema + 规则),不过则编排器自动补跑。
 * 规则来源:AGENTS.md §4 契约、SOP §1 Gate、§2 依赖矩阵。不信任 agent 自报:取数账本核对、calc 复算、确定性报价判定。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CRITICAL_SCRIPTS, HOME_PREFIXES, REPORT_SECTIONS, STAGE_CALCS, STAGE_SCRIPTS, fetchEnv,
  type RunConfig, type RunStatus, type Stage, type StageStatus } from "./config.ts";
import { loadLedgerFromDisk, type Ledger } from "./fetchrun.ts";
import { PLAN_REL, type EndpointDef, type PlanFile, type StagePlan } from "./registry.ts";
import { complianceGate, missingSections, referencedIds, reportStatusToken } from "./gate.ts";
import { extraSectionErrors, requiredExtraSections } from "./report_sections.ts";
import "./finance/register.ts";   // 注册金融包的词表(Core + DomainPack 边界的第一块砖)
import { checkNumberFidelity, quotedHistory } from "./number_fidelity.ts";
import { resultProjection, type ResultProjectionItem } from "./calc_projection.ts";

/** 复算:对每条 calc 记录用同样的函数 / 实参 / 引用重新调用 calc cli,比对 id / status / value / unit / inputs_resolved 与退出码。*/
export type CalcVerifier = (cfg: RunConfig, run: RunView) => ValidationResult;
export { resultProjection, type ResultProjectionItem };
import { listFiles, readJsonIfExists, sha256File } from "./fsutil.ts";
import { detectSourceConflicts, loadCalcs, loadFetch, mergeEvidence, type CalcRecord, type EvidenceItem, type FetchEnvelope, type SourceConflict } from "./merge.ts";
import { validateCalcRecord, validateEvidenceItem, validateFetchEnvelope, validateStageOutput } from "./schemas.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface Gap { operation: string; reason_code: string; detail: string; attempted_sources?: string[] }

export interface StageOutput {
  stage: Stage;
  status: StageStatus;
  summary: string;
  evidence_ids: string[];
  calculation_ids: string[];
  gaps: Gap[];
  [k: string]: unknown;
}

export interface AgentTrace {
  commands: string[];
  fileChanges: string[];
}

export interface RunView {
  runDir: string;
  fetch: Record<string, FetchEnvelope>;
  /** 权威账本:正式运行中来自编排器内存;--no-agent 复核时才从磁盘读 */
  ledger: Ledger;
  calcs: { file: string; record: CalcRecord | null }[];
  evidence: Map<string, EvidenceItem>;
  evidenceIds: Set<string>;
  calcById: Map<string, CalcRecord>;
  calcIds: Set<string>;
  conflicts: SourceConflict[];
  stage: (s: Stage) => StageOutput | null;
  report: string | null;
  /** 本次运行的阶段计划 / 关键端点 / 端点定义(正式运行来自 cfg;复核时读 fetch/_plan.json;都没有 → Phase 0 常量) */
  plan: StagePlan<Stage>;
  critical: string[];
  endpoints: Record<string, Pick<EndpointDef, "module" | "symbol_kind" | "title" | "source" | "compliance">>;
}

export interface PlanInfo { plan: StagePlan<Stage>; critical: string[]; endpoints: Record<string, Pick<EndpointDef, "module" | "symbol_kind" | "title" | "source" | "compliance">> }

function planFromDisk(runDir: string): PlanInfo {
  const pf = readJsonIfExists<PlanFile>(path.join(runDir, PLAN_REL));
  if (pf?.stage_plan) return { plan: pf.stage_plan as StagePlan<Stage>, critical: pf.critical ?? CRITICAL_SCRIPTS, endpoints: pf.endpoints ?? {} };
  return { plan: STAGE_SCRIPTS, critical: CRITICAL_SCRIPTS, endpoints: {} };
}

export function loadRun(runDir: string, ledger?: Ledger, planInfo?: PlanInfo): RunView {
  const fetch = loadFetch(runDir);
  const pi = planInfo ?? planFromDisk(runDir);
  const calcs = loadCalcs(runDir);
  const evidence = new Map(mergeEvidence(fetch).evidence.map((e) => [e.id, e] as const));
  const calcById = new Map(calcs.filter((c) => c.record?.calculation_id).map((c) => [c.record!.calculation_id as string, c.record!] as const));
  const reportPath = path.join(runDir, "report.md");
  return {
    runDir,
    fetch,
    ledger: ledger ?? loadLedgerFromDisk(runDir),
    calcs,
    evidence,
    evidenceIds: new Set(evidence.keys()),
    calcById,
    calcIds: new Set(calcById.keys()),
    conflicts: detectSourceConflicts(fetch),
    stage: (s) => readJsonIfExists<StageOutput>(path.join(runDir, "stages", `${s}.json`)),
    report: fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : null,
    plan: pi.plan,
    critical: pi.critical,
    endpoints: pi.endpoints,
  };
}

const ok = (errors: string[], warnings: string[] = []): ValidationResult => ({ ok: errors.length === 0, errors, warnings });

/** 取数产物完整性:fetch/ 与 raw/ 下每个文件都必须能在(内存)账本中找到且 sha256 未变(防 agent 伪造 / 改写);evidence 的 raw_ref 必须指向本次 raw/ 内的真实文件 */
export function validateFetchIntegrity(run: RunView): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  // fetch/ 目录逐文件(不只是能解析的)
  for (const f of listFiles(path.join(run.runDir, "fetch"), ".json")) {
    const base = path.basename(f);
    if (base === "_ledger.json" || base === "_plan.json" || base === "_industry.json" || base === "_chokepoints.json") continue;
    if (!fs.lstatSync(f).isFile()) { errors.push(`fetch/${base} 不是普通文件(目录 / 符号链接 / 设备),取数产物只能是普通文件`); continue; }
    const script = base.replace(/\.json$/, "");
    const entry = run.ledger[script];
    if (!entry) { errors.push(`fetch/${base} 没有编排器账本记录(取数只能由编排器执行,疑似 agent 自写)`); continue; }
    if (entry.sha256 && sha256File(f) !== entry.sha256) errors.push(`fetch/${base} 内容与账本 sha256 不一致(文件被改写)`);
    if (!run.fetch[script]) { errors.push(`fetch/${base} 不是合法取数信封(无法解析或缺 script)`); continue; }
    // 统一退出码契约的两条不变量(不信任账本自报):① 账本 exit_code ↔ status 自洽(0 ⇔ ok、2 ⇔ partial、其它 / 无退出码 ⇔ failed|timeout|error);② 按退出码推导的状态 ⇔ 信封 status
    if (!entry.injected) {
      const derived = entry.exit_code === 0 ? "ok" : entry.exit_code === 2 ? "partial" : "failed";
      const ledgerNorm = entry.status === "timeout" || entry.status === "error" ? "failed" : entry.status;
      if (ledgerNorm !== derived) errors.push(`fetch/${base} 账本自身不自洽:退出码 ${entry.exit_code ?? "无"} 应推导为 ${derived},账本却记 ${entry.status}`);
      const envStatus = run.fetch[script].status;
      if (derived !== envStatus) errors.push(`fetch/${base} 信封 status=${envStatus} 与账本退出码 ${entry.exit_code ?? "无"} 推导的 ${derived} 不一致`);
    }
  }
  // 反向:账本里每个条目的产物文件必须仍在(删除 / 改名 = 破坏认证闭环)
  for (const [script, entry] of Object.entries(run.ledger)) {
    const expect = path.join("fetch", `${script}.json`);
    if (!entry.file) { errors.push(`账本 ${script} 缺 file 字段(每条账本必须指向 ${expect})`); continue; }
    if (entry.file !== expect) { errors.push(`账本 ${script} 的 file=${entry.file} 与脚本名不符(应为 ${expect})`); continue; }
    const p = path.resolve(run.runDir, entry.file);
    if (!p.startsWith(path.resolve(run.runDir, "fetch") + path.sep)) { errors.push(`账本 ${script} 的 file 越出 fetch/:${entry.file}`); continue; }
    if (!fs.existsSync(p)) errors.push(`账本记录的 ${entry.file} 已不存在(取数产物被删除或改名)`);
    else if (!fs.lstatSync(p).isFile()) errors.push(`账本记录的 ${entry.file} 不是普通文件`);
  }
  // raw/ 目录逐文件:必须出现在某次编排器取数的 raw_files 中且 sha 一致
  const knownRaw = new Map<string, string>();
  for (const e of Object.values(run.ledger)) for (const [name, sha] of Object.entries(e.raw_files ?? {})) knownRaw.set(name, sha);
  for (const f of listFiles(path.join(run.runDir, "raw"))) {
    const base = path.basename(f);
    if (fs.lstatSync(f).isSymbolicLink()) { errors.push(`raw/${base} 是符号链接`); continue; }
    const sha = knownRaw.get(base);
    if (!sha) errors.push(`raw/${base} 未经编排器取数记录(疑似 agent 自写)`);
    else if (sha !== sha256File(f)) errors.push(`raw/${base} 内容与账本 sha256 不一致(文件被改写)`);
  }
  for (const [script, env] of Object.entries(run.fetch)) {
    const se = validateFetchEnvelope(env);
    if (se.length) errors.push(`fetch/${script}.json 不符契约:${se.slice(0, 3).join("; ")}`);
    const rawKind = run.endpoints[script]?.symbol_kind === "raw";
    for (const e of env.evidence ?? []) {
      // 全市场证据:market 为区域码(CN / US / HK)且 symbol=MARKET,二者必须同真同假;raw 类端点(指数 / 关键词 / 期权标的)豁免
      const regionCode = e.market === "CN" || e.market === "US" || e.market === "HK";
      if (e.symbol === "MARKET" && !regionCode) errors.push(`${e.id} market/symbol 不匹配:全市场证据(symbol=MARKET)的 market 须为 CN|US|HK`);
      if (e.market === "CN" && e.symbol !== "MARKET" && !rawKind) errors.push(`${e.id} market/symbol 不匹配:A 股全市场证据须 market=CN 且 symbol=MARKET(个股须 SH|SZ|BJ)`);
      if (!e.raw_ref && e.source !== "injected") errors.push(`${e.id} 缺 raw_ref:每条证据必须指向本次 raw/ 内的原始响应(AGENTS.md §4 / §5);硬测试注入证据除外`);
      if (e.raw_ref) {
        const rawRoot = path.resolve(run.runDir, "raw");
        const p = path.resolve(run.runDir, e.raw_ref);
        if (!p.startsWith(rawRoot + path.sep)) errors.push(`${e.id} raw_ref 越出 raw/:${e.raw_ref}`);
        else if (!fs.existsSync(p)) errors.push(`${e.id} raw_ref 文件不存在:${e.raw_ref}`);
        else if (fs.lstatSync(p).isSymbolicLink()) errors.push(`${e.id} raw_ref 是符号链接:${e.raw_ref}`);
      }
    }
  }
  return ok(errors, warnings);
}

/** 确定性报价判定(SOP §2),不信任 agent 自填 */
export type QuoteDecision = "normal" | "pre_open" | "stale" | "unknown_unverified" | "missing";
export function deriveQuoteDecision(run: RunView): { decision: QuoteDecision; reason: string } {
  const q = run.fetch["fetch_quote"];
  const cal = run.fetch["fetch_trade_calendar"];
  if (!q || q.status === "failed") return { decision: "missing", reason: "fetch_quote 缺失或失败" };
  if (!cal || cal.status === "failed") return { decision: "unknown_unverified", reason: "缺少交易日历,无法判定报价时效" };
  const qx = q.extra as Record<string, unknown>;
  const cx = cal.extra as Record<string, unknown>;
  const quoteDate = String(qx.quote_date ?? "");
  const ref = String(cx.reference_quote_day ?? "");
  const last = String(cx.last_trading_day ?? "");
  const phase = String(cx.session_phase ?? "");
  const stale = qx.is_stale;
  const preOpenOk = phase === "pre_open" && (quoteDate === ref || quoteDate === last);
  if (!quoteDate || !ref) return { decision: "unknown_unverified", reason: "缺 quote_date / reference_quote_day" };
  if (quoteDate < ref) return { decision: "stale", reason: `quote_date ${quoteDate} < reference_quote_day ${ref}:个股停牌或数据陈旧` };
  if (quoteDate > ref && !preOpenOk) return { decision: "stale", reason: `quote_date ${quoteDate} 晚于参考日 ${ref} 且非盘前集合竞价:数据异常` };
  if (stale === true) {
    if (preOpenOk) return { decision: "pre_open", reason: `盘前(session_phase=pre_open)且 quote_date ${quoteDate} 吻合,按昨收继续` };
    return { decision: "stale", reason: "成交额 0 且现价 == 昨收,且非盘前:停牌 / 废码" };
  }
  if (stale === "unknown") {
    const k = run.fetch["fetch_kline"];
    const kx = (k?.extra ?? {}) as Record<string, unknown>;
    if (k && k.status !== "failed" && String(kx.end ?? "") === ref) return { decision: "normal", reason: "is_stale=unknown,K 线最新日期 == 参考日,二次验证通过" };
    return { decision: "unknown_unverified", reason: "is_stale=unknown 且无法用 K 线二次验证" };
  }
  return { decision: "normal", reason: `quote_date ${quoteDate} == reference_quote_day ${ref},is_stale=false` };
}

/** 阶段校验(同步、纯文件) */
export function validateStage(stage: Stage, run: RunView): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const integ = validateFetchIntegrity(run);
  errors.push(...integ.errors);

  // 1. 必需 / 可选取数脚本:必须由编排器执行过(账本),文件存在;status=failed 是合法数据缺口(不是校验错误)
  const scripts = run.plan[stage];
  const failedRequired: string[] = [];
  for (const s of scripts.required) {
    const env = run.fetch[s];
    if (!env || !run.ledger[s]) { errors.push(`必需取数 ${s} 未被编排器执行(无 fetch/${s}.json 或无账本)`); continue; }
    if (env.status === "failed") failedRequired.push(s);
    if (env.status === "partial") warnings.push(`fetch/${s}.json status=partial:${String((env.extra as Record<string, unknown>)?.degraded ?? "")}`);
  }
  const gateSkipped = new Set(readJsonIfExists<{ skipped?: string[] }>(path.join(run.runDir, "fetch", "_industry.json"))?.skipped ?? []);
  for (const s of scripts.optional) if (!run.fetch[s] && !gateSkipped.has(s)) warnings.push(`可选取数 ${s} 无产物`);

  // 2. 阶段 JSON
  const so = run.stage(stage);
  if (!so) { errors.push(`缺少 stages/${stage}.json`); return ok(errors, warnings); }
  const se = validateStageOutput(stage, so);
  if (se.length) errors.push(`stages/${stage}.json 不符 schema:${se.slice(0, 5).join("; ")}`);
  for (const id of so.evidence_ids ?? []) if (!run.evidenceIds.has(id)) errors.push(`stages/${stage}.json 引用了不存在的 evidence ${id}`);
  for (const id of so.calculation_ids ?? []) if (!run.calcIds.has(id)) errors.push(`stages/${stage}.json 引用了不存在的 calculation ${id}`);
  // M2 extra_findings:id 必须真实存在,且同时列在本阶段顶层 evidence_ids / calculation_ids(顶层引用是唯一权威口径;扩展发现不得借无关 id 背书)
  const topEv = new Set(so.evidence_ids ?? []);
  const topCalc = new Set(so.calculation_ids ?? []);
  for (const f of ((so as Record<string, unknown>).extra_findings as { topic: string; evidence_ids: string[] }[] | undefined) ?? []) {
    for (const id of f.evidence_ids ?? []) {
      if (!run.evidenceIds.has(id) && !run.calcIds.has(id)) { errors.push(`stages/${stage}.json extra_findings「${f.topic}」引用了不存在的 id ${id}`); continue; }
      if (id.startsWith("ev-") ? !topEv.has(id) : !topCalc.has(id)) errors.push(`stages/${stage}.json extra_findings「${f.topic}」引用的 ${id} 未列入本阶段顶层 evidence_ids / calculation_ids`);
    }
  }
  if (failedRequired.length && so.status === "complete") errors.push(`必需取数 ${failedRequired.join("/")} 失败,阶段不得标 complete(应 incomplete 并在 gaps 以 operation=<脚本名> 说明)`);
  for (const s of failedRequired) {
    if (!(so.gaps ?? []).some((g) => g.operation === s)) errors.push(`必需取数 ${s} 失败,但 gaps 没有 operation=${s} 的条目`);
  }

  // 3. 必需 calc:该阶段 calculation_ids 中有该函数的记录,或 gaps 以 operation 精确说明
  const stageCalcFns = new Set(run.calcs.filter((c) => c.record && so.calculation_ids?.includes(c.record.calculation_id ?? "")).map((c) => c.record!.function));
  const gapOps = new Set((so.gaps ?? []).map((g) => g.operation));
  for (const fn of STAGE_CALCS[stage]) {
    if (!stageCalcFns.has(fn) && !gapOps.has(fn)) errors.push(`阶段 ${stage} 缺少 calc ${fn}:calculation_ids 里没有该函数的记录,gaps 也没有 operation=${fn}`);
  }
  if ((so.gaps ?? []).length && so.status === "complete" && (so.gaps ?? []).some((g) => STAGE_CALCS[stage].includes(g.operation) || scripts.required.includes(g.operation)))
    errors.push(`有必需项缺口却把阶段标为 complete`);

  // 4. calc 记录契约与引用
  for (const c of run.calcs) {
    if (!c.record) { errors.push(`${path.basename(c.file)} 不是合法 JSON`); continue; }
    const ce = validateCalcRecord(c.record);
    if (ce.length) errors.push(`${path.basename(c.file)} 不符 calculation 契约:${ce.slice(0, 3).join("; ")}`);
    for (const r of c.record.inputs_refs ?? []) {
      if (r.ref_type === "evidence" && !run.evidenceIds.has(r.ref_id)) errors.push(`${path.basename(c.file)} 引用了不存在的 evidence ${r.ref_id}`);
      if (r.ref_type === "calculation" && !run.calcIds.has(r.ref_id)) errors.push(`${path.basename(c.file)} 引用了不存在的 calculation ${r.ref_id}`);
    }
    if (c.record.output.status === "ok" && (c.record.inputs_refs ?? []).length === 0)
      errors.push(`${path.basename(c.file)} 没有 inputs_refs:每个计算必须引用其输入 evidence / calculation id`);
  }

  // 5. 语义槽位:必需 calc 的输入必须引用对的证据 / 上游计算,实参值必须等于所引用证据的值与单位
  errors.push(...validateCalcSlots(stage, run, so).errors);

  // 6. 阶段专属
  if (stage === "profile") {
    const d = deriveQuoteDecision(run);
    if (d.decision !== "missing" && so.quote_decision !== d.decision)
      errors.push(`quote_decision 应为 ${d.decision}(${d.reason}),agent 写的是 ${String(so.quote_decision)}`);
  }
  if (stage === "risk") {
    type SC = { field?: string; period?: string; kind?: string; values?: { ref_id?: string }[] };
    const listed = ((so.source_conflicts as SC[] | undefined) ?? []);
    for (const c of run.conflicts) {
      const entry = listed.find((x) => x.field === c.field && (x.period === c.period || !x.period));
      if (!entry) { errors.push(`risk.source_conflicts 未覆盖权威冲突 ${c.field}@${c.period}(见 conflicts.json)`); continue; }
      if (entry.kind !== "source") errors.push(`risk.source_conflicts ${c.field}@${c.period} 是权威冲突,kind 必须为 "source"(实际 ${String(entry.kind)})`);
      const refs = new Set((entry.values ?? []).map((v) => v.ref_id));
      const missing = c.values.map((v) => v.id).filter((id) => !refs.has(id));
      if (missing.length) errors.push(`risk.source_conflicts ${c.field}@${c.period} 的 values 未列出权威冲突全部证据 id(缺 ${missing.join(",")})`);
    }
    for (const ce of (so.counter_evidence as { evidence_ids?: string[] }[] | undefined) ?? []) {
      for (const id of ce.evidence_ids ?? []) if (!run.evidenceIds.has(id) && !run.calcIds.has(id)) errors.push(`risk.counter_evidence 引用了不存在的 id ${id}`);
    }
  }
  if (stage === "report") errors.push(...validateReport(run).errors);
  return ok(errors, warnings);
}

/**
 * 语义槽位 v2:验证"输入选对了"——引用对的证据字段 / 期间、对的上游计算(按口径角色:营收 / 归母 / 扣非),
 * 且实参值 == 所引用证据值(单位参数 == 证据单位)、下游实参 == 上游计算 output.value(单位 == output.unit)。
 */
export type Role = "revenue_cum" | "net_profit_parent_cum" | "net_profit_deducted_cum";
const ROLES: Role[] = ["revenue_cum", "net_profit_parent_cum", "net_profit_deducted_cum"];
type Fy = "T" | "T+2" | "T+years";
interface Slot {
  fn: string;
  /** inputs_refs 中必须含这些 field 的 evidence(每个至少一条) */
  evidenceFields?: string[];
  /** 每条记录必须引用这样的上游计算(可限定口径角色,角色经 quarterize 的证据字段逐级解析) */
  upstream?: { fn: string; role?: Role }[];
  /** 同函数多条记录合起来必须覆盖这些角色(缺的以 operation=<fn>:<role> 写 gaps) */
  coverRoles?: Role[];
  /** 实参 == 所引用该 field(可限定财年)证据的 value;unitArg == 证据 unit */
  bind?: { arg: string; field: string; unitArg?: string; fy?: Fy }[];
  /** 实参 == 所引用上游计算的 output.value;unitArg == output.unit */
  bindUpstream?: { arg: string; fn: string; role?: Role; unitArg?: string }[];
  /** 这些 field 的引用证据必须同一期间(可要求 == 某财年) */
  samePeriod?: { fields: string[]; fy?: Fy };
  /** 实参常量约束 */
  constArgs?: Record<string, unknown>;
  /** quarterize:按引用证据 field 区分,必须覆盖 requiredGroups */
  distinctBy?: "field";
  requiredGroups?: string[];
}
const SLOTS: Record<string, Slot[]> = {
  financials: [
    { fn: "quarterize", distinctBy: "field", requiredGroups: [...ROLES] },
    { fn: "latest_quarter", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_deducted_cum"] },
    { fn: "ttm_sum", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_parent_cum"] },
    { fn: "ttm_yoy", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_parent_cum"] },
    { fn: "qoq", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_deducted_cum"] },
  ],
  estimates: [
    { fn: "forward_cagr", evidenceFields: ["eps_consensus_mean"], constArgs: { years: 2 },
      bind: [{ arg: "eps_t", field: "eps_consensus_mean", fy: "T" }, { arg: "eps_t_plus_n", field: "eps_consensus_mean", fy: "T+years" }] },
    { fn: "consensus_dispersion", evidenceFields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"],
      bind: [{ arg: "low", field: "eps_consensus_min", fy: "T+2" }, { arg: "mean", field: "eps_consensus_mean", fy: "T+2" }, { arg: "high", field: "eps_consensus_max", fy: "T+2" }],
      samePeriod: { fields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"], fy: "T+2" } },
  ],
  valuation: [
    { fn: "pe_deducted_annualized", evidenceFields: ["total_market_cap"], upstream: [{ fn: "latest_quarter", role: "net_profit_deducted_cum" }],
      bind: [{ arg: "total_market_cap", field: "total_market_cap", unitArg: "cap_unit" }],
      bindUpstream: [{ arg: "latest_quarter_deducted_profit", fn: "latest_quarter", role: "net_profit_deducted_cum", unitArg: "profit_unit" }] },
    { fn: "forward_pe", evidenceFields: ["price", "eps_consensus_mean"], bind: [{ arg: "price", field: "price" }, { arg: "eps_forecast", field: "eps_consensus_mean", fy: "T" }] },
    { fn: "pe_ttm_from_parts", evidenceFields: ["total_market_cap"], upstream: [{ fn: "ttm_sum", role: "net_profit_parent_cum" }],
      bind: [{ arg: "total_market_cap", field: "total_market_cap", unitArg: "cap_unit" }],
      bindUpstream: [{ arg: "ttm_profit", fn: "ttm_sum", role: "net_profit_parent_cum", unitArg: "profit_unit" }] },
    { fn: "percentile_rank", evidenceFields: ["pe_ttm_traded_history_points", "pe_ttm"], bind: [{ arg: "current", field: "pe_ttm" }] },
    { fn: "peg", upstream: [{ fn: "pe_deducted_annualized" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_deducted_annualized" }, { arg: "cagr", fn: "forward_cagr" }] },
    { fn: "pe_digestion_scenarios", upstream: [{ fn: "pe_deducted_annualized" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_deducted_annualized" }, { arg: "cagr", fn: "forward_cagr" }] },
    { fn: "forward_vs_ttm_judgement", upstream: [{ fn: "forward_cagr" }, { fn: "ttm_yoy", role: "net_profit_parent_cum" }],
      bindUpstream: [{ arg: "forward_cagr_value", fn: "forward_cagr" }, { arg: "ttm_yoy_value", fn: "ttm_yoy", role: "net_profit_parent_cum" }] },
  ],
};

/** 口径角色:quarterize 看其引用证据的唯一 field;其他函数沿上游计算递归(必须唯一) */
export function roleOf(c: CalcRecord, run: RunView, depth = 0): Role | null {
  if (depth > 8) return null;
  if (c.function === "quarterize") {
    const fields = [...new Set(refsEvidence(c, run).map((e) => e.field))];
    return fields.length === 1 && (ROLES as string[]).includes(fields[0]) ? (fields[0] as Role) : null;
  }
  const roles = [...new Set(refsCalcs(c, run).map((u) => roleOf(u, run, depth + 1)).filter((r): r is Role => !!r))];
  return roles.length === 1 ? roles[0] : null;
}

/** 当前财年 T(fetch_estimates.extra.current_fy,形如 FY2026;缺失则取 eps_consensus_mean 最早财年) */
export function fiscalT(run: RunView): number | null {
  const raw = (run.fetch["fetch_estimates"]?.extra as Record<string, unknown> | undefined)?.current_fy;
  const m = /(\d{4})/.exec(String(raw ?? ""));
  if (m) return Number(m[1]);
  const ys = [...run.evidence.values()].filter((e) => e.field === "eps_consensus_mean").map((e) => Number((/(\d{4})/.exec(e.period) ?? [])[1])).filter((n) => !Number.isNaN(n));
  return ys.length ? Math.min(...ys) : null;
}
const fyLabel = (n: number) => `FY${n}`;
function resolveFy(fy: Fy | undefined, T: number | null, inputs: Record<string, unknown>): string | null {
  if (!fy || T === null) return null;
  if (fy === "T") return fyLabel(T);
  if (fy === "T+2") return fyLabel(T + 2);
  const y = Number(inputs.years);
  return Number.isFinite(y) ? fyLabel(T + y) : null;
}

export function validateCalcSlots(stage: Stage, run: RunView, so: StageOutput): ValidationResult {
  const errors: string[] = [];
  const slots = SLOTS[stage] ?? [];
  const stageCalcs = (so.calculation_ids ?? []).map((id) => run.calcById.get(id)).filter((c): c is CalcRecord => !!c);
  const gapOps = new Set((so.gaps ?? []).map((g) => g.operation));
  const T = fiscalT(run);
  for (const slot of slots) {
    const recs = stageCalcs.filter((c) => c.function === slot.fn);
    if (!recs.length) continue; // 整个函数缺失由必需 calc 检查处理(需 gaps 说明)
    if (slot.distinctBy === "field" && slot.requiredGroups) {
      const covered = new Set<string>();
      for (const r of recs) {
        const fields = [...new Set(refsEvidence(r, run).map((e) => e.field))];
        if (fields.length !== 1) errors.push(`${slot.fn}(${r.calculation_id})引用的证据字段不唯一:${fields.join(",")}(一次 quarterize 只处理一个字段)`);
        else covered.add(fields[0]);
      }
      for (const g of slot.requiredGroups) if (!covered.has(g) && !gapOps.has(`${slot.fn}:${g}`)) errors.push(`缺少对 ${g} 的 ${slot.fn}(或以 operation=${slot.fn}:${g} 写 gaps)`);
    }
    if (slot.coverRoles) {
      const covered = new Set(recs.map((r) => roleOf(r, run)).filter((r): r is Role => !!r));
      for (const role of slot.coverRoles) if (!covered.has(role) && !gapOps.has(`${slot.fn}:${role}`)) errors.push(`缺少基于 ${role} 的 ${slot.fn}(或以 operation=${slot.fn}:${role} 写 gaps)`);
    }
    for (const r of recs) {
      const evs = refsEvidence(r, run);
      const ups = refsCalcs(r, run);
      const inputs = (r.inputs ?? {}) as Record<string, unknown>;
      const tag = `${slot.fn}(${r.calculation_id})`;
      for (const f of slot.evidenceFields ?? []) if (!evs.some((e) => e.field === f)) errors.push(`${tag}的 inputs_refs 没有引用 field=${f} 的证据`);
      for (const u of slot.upstream ?? []) {
        const hit = ups.find((c) => c.function === u.fn && (!u.role || roleOf(c, run) === u.role));
        if (!hit) errors.push(`${tag}的 inputs_refs 没有引用上游 ${u.fn}${u.role ? `(口径 ${u.role})` : ""} 的计算`);
      }
      if (slot.upstream?.some((u) => u.fn === "quarterize") && roleOf(r, run) === null) errors.push(`${tag}的口径无法唯一解析(上游 quarterize 必须且只能有一个,且其证据字段唯一)`);
      for (const b of slot.bind ?? []) {
        const val = inputs[b.arg];
        const want = resolveFy(b.fy, T, inputs);
        const matched = evs.filter((e) => e.field === b.field && (!want || e.period === want));
        if (!matched.length) { if (b.fy) errors.push(`${tag}必须引用 ${want ?? "(无法确定财年)"} 的 ${b.field} 证据(实参 ${b.arg})`); continue; }
        const hit = matched.find((e) => valuesEqual(e.value, val));
        if (!hit) errors.push(`${tag}实参 ${b.arg}=${JSON.stringify(val)} 与所引用 ${b.field}${want ? "@" + want : ""} 证据的值 ${matched.map((e) => JSON.stringify(e.value)).join("/")} 不一致(输入没选对或手改)`);
        else if (b.unitArg && inputs[b.unitArg] !== hit.unit) errors.push(`${tag}单位参数 ${b.unitArg}=${String(inputs[b.unitArg])} 与证据单位 ${hit.unit} 不一致`);
      }
      for (const b of slot.bindUpstream ?? []) {
        const up = ups.find((c) => c.function === b.fn && (!b.role || roleOf(c, run) === b.role));
        if (!up) continue; // 已由 upstream 规则报错
        if (!valuesEqual(up.output?.value, inputs[b.arg])) errors.push(`${tag}实参 ${b.arg}=${JSON.stringify(inputs[b.arg])} 与上游 ${b.fn} 的 output.value=${JSON.stringify(up.output?.value)} 不一致`);
        else if (b.unitArg && inputs[b.unitArg] !== up.output?.unit) errors.push(`${tag}单位参数 ${b.unitArg}=${String(inputs[b.unitArg])} 与上游 ${b.fn} 的 output.unit=${up.output?.unit} 不一致`);
      }
      if (slot.samePeriod) {
        const periods = new Set(evs.filter((e) => slot.samePeriod!.fields.includes(e.field)).map((e) => e.period));
        const want = resolveFy(slot.samePeriod.fy, T, inputs);
        if (periods.size !== 1) errors.push(`${tag}引用的 ${slot.samePeriod.fields.join("/")} 必须同一期间,实际 ${[...periods].join(",")}`);
        else if (want && ![...periods][0].startsWith(want)) errors.push(`${tag}引用的期间应为 ${want},实际 ${[...periods][0]}`);
      }
      for (const [k, v] of Object.entries(slot.constArgs ?? {})) if (!valuesEqual(inputs[k], v)) errors.push(`${tag}实参 ${k} 必须为 ${JSON.stringify(v)},实际 ${JSON.stringify(inputs[k])}`);
    }
  }
  return ok(errors);
}

function refsEvidence(r: CalcRecord, run: RunView): EvidenceItem[] {
  return (r.inputs_refs ?? []).filter((x) => x.ref_type === "evidence").map((x) => run.evidence.get(x.ref_id)).filter((e): e is EvidenceItem => !!e);
}
function refsCalcs(r: CalcRecord, run: RunView): CalcRecord[] {
  return (r.inputs_refs ?? []).filter((x) => x.ref_type === "calculation").map((x) => run.calcById.get(x.ref_id)).filter((c): c is CalcRecord => !!c);
}
function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateReport(run: RunView, expectedStatus?: RunStatus): ValidationResult {
  const errors: string[] = [];
  if (!run.report) return ok(["缺少 report.md"]);
  const miss = missingSections(run.report, REPORT_SECTIONS);
  if (miss.length) errors.push(`report.md 缺少章节:${miss.join(" / ")}`);
  // 扩展章节:risk 阶段落了哪些 topic 是既成事实 → 报告必须写出对应章节并引其证据。
  // 原来这条纪律只在提示词里,实测会被静默丢掉(见 report_sections.ts 顶部)。
  errors.push(...extraSectionErrors(run.report, requiredExtraSections(run.stage("risk"))));
  // 🔴 数字忠实度:报告写出的数字必须等于**同一行所引** evidence / calc 的值。
  //    在此之前 validateReport 只查"章节在不在、id 存不存在" —— 报告可以引一个**真实的 calc-id
  //    却写另一个数字**,仍判 complete(架构审计 2026-08-24 指出的最关键缺口)。
  //    实现与硬测试共用 number_fidelity.ts,不复制两份。
  //    `applicable=false` = 本次没有带 display 的 calc(旧运行 / 纯取数运行)→ 不适用,不判失败。
  const symbolOf = () => { for (const e of run.evidence.values()) { const s = (e as { symbol?: unknown }).symbol; if (typeof s === "string" && s && s !== "MARKET") return s; } return undefined; };
  const fid = checkNumberFidelity(run.report, run.evidence as never, run.calcById as never, symbolOf(),
                                  quotedHistory((st) => run.stage(st as never) as never));
  if (fid.missingDisplay) {
    // 引用了 calc 结果却一个带 display 的都没有 = calc 侧缺陷。静默跳过等于把这条防线关掉。
    errors.push("report.md 引用的 calc 里有**成功结果没写 display**(该版本本应写),数字忠实度对这些结果无法校验");
  }
  // 纯 evidence 行的违规**不受 applicable 门控**:它与 display 无关,旧运行同样该报
  if (fid.evidenceViolations?.length) {
    errors.push(`report.md 有 ${fid.evidenceViolations.length} 个数字与同行引用的 evidence 对不上(引了 id 却写了别的数)`
      + `:${fid.evidenceViolations.slice(0, 3).join(" | ")}`);
  }
  if (fid.applicable && fid.violations.length) {
    errors.push(`report.md 有 ${fid.violations.length}/${fid.total} 个数字与同行引用的证据 / 计算对不上(引了 id 却写了别的数)`
      + `:${fid.violations.slice(0, 3).join(" | ")}`);
  }
  const refs = referencedIds(run.report);
  for (const id of refs.evidence) if (!run.evidenceIds.has(id)) errors.push(`report.md 引用了不存在的 evidence ${id}`);
  for (const id of refs.calculation) if (!run.calcIds.has(id)) errors.push(`report.md 引用了不存在的 calculation ${id}`);
  if (refs.evidence.length === 0) errors.push(`report.md 没有引用任何 evidence id(每个事实数字必须标 ev- id)`);
  const tok = reportStatusToken(run.report);
  if (!tok) errors.push(`report.md 首行缺少状态标记(状态:complete|incomplete|failed|stale)`);
  else if (expectedStatus && tok !== expectedStatus) errors.push(`report.md 首行状态 ${tok} 与编排器推导状态 ${expectedStatus} 不一致`);
  const gate = complianceGate(run.report);
  if (!gate.ok) errors.push(...gate.hits.map((h) => `合规 gate 命中 第 ${h.line} 行「${h.pattern}」:${h.text}`));
  return ok(errors);
}

/** 仅带 display 键的结果的 display 投影(旧记录整棵树没有 display 键 → 空) */
export function displayProjection(output: unknown): [string, string | null][] {
  return resultProjection(output).filter((r) => r.hasDisplay).map((r) => [r.path, r.display] as [string, string | null]);
}
const sameNum = (a: number | null, b: number | null) => (a === null && b === null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
/** 两份结果投影是否一致(路径集合、status、unit、value[容差]、display[精确]) */
export function projectionsEqual(a: ResultProjectionItem[], b: ResultProjectionItem[]): string | null {
  if (a.length !== b.length) return `子结果数量 ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.path !== y.path) return `路径 ${x.path} vs ${y.path}`;
    // hasDisplay 也比:同版本记录里 display 键被整个删掉(值恰为 null 的多结果函数顶层)同样算被改
    if (x.status !== y.status || x.unit !== y.unit || !sameNum(x.value, y.value) || x.display !== y.display || x.hasDisplay !== y.hasDisplay)
      return `${x.path || "<顶层>"}:${x.status}/${x.value}/${x.unit}/${x.hasDisplay ? JSON.stringify(x.display) : "<无 display 键>"} vs ${y.status}/${y.value}/${y.unit}/${y.hasDisplay ? JSON.stringify(y.display) : "<无 display 键>"}`;
  }
  return null;
}

export const verifyCalcs: CalcVerifier = (cfg, run) => {
  const errors: string[] = [];
  const cli = path.join(cfg.repoRoot, cfg.calcCliRel);
  for (const c of run.calcs) {
    const r = c.record;
    if (!r || !r.calculation_id) continue;
    const args = ["--args", JSON.stringify(r.inputs ?? {}), "--run-dir", cfg.runDir];
    const ev = (r.inputs_refs ?? []).filter((x) => x.ref_type === "evidence").map((x) => x.ref_id);
    const cs = (r.inputs_refs ?? []).filter((x) => x.ref_type === "calculation").map((x) => x.ref_id);
    if (ev.length) args.push("--evidence", ...ev);
    if (cs.length) args.push("--calc", ...cs);
    const p = spawnSync(cfg.python, [cli, r.function, ...args], { encoding: "utf8", cwd: cfg.repoRoot, env: fetchEnv(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    let out: CalcRecord | null = null;
    try { out = JSON.parse(p.stdout) as CalcRecord; } catch { errors.push(`${path.basename(c.file)} 复算失败:cli 无 JSON 输出(${(p.stderr || "").slice(0, 120)})`); continue; }
    if (p.status !== 0 && p.status !== 2) errors.push(`${path.basename(c.file)} 复算退出码 ${p.status}(应为 0 或 2)`);
    if (out.calculation_id !== r.calculation_id) errors.push(`${path.basename(c.file)} 复算 calculation_id 不一致:${r.calculation_id} vs ${out.calculation_id}`);
    const a = r.output?.value, b = out.output?.value;
    const same = (a === null && b === null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
    if (!same || r.output?.status !== out.output?.status || r.output?.unit !== out.output?.unit)
      errors.push(`${path.basename(c.file)} 复算结果不一致:${r.output?.status}/${a}/${r.output?.unit} vs ${out.output?.status}/${b}/${out.output?.unit}`);
    // 结果投影整体比对(顶层 + details 里每个结果形子对象的 status / unit / value / display,如四锚 scenarios):子 value 被改而 display 保留、子 display 被改、顶层 display 被删都判不一致。
    // 只在 calc_version 相同时比(不同版本的记录 calculation_id 已经对不上,上面已报错;避免用新版的 display 去苛责旧版记录)
    if (r.calc_version === out.calc_version) {
      const diff = projectionsEqual(resultProjection(r.output), resultProjection(out.output));
      if (diff) errors.push(`${path.basename(c.file)} 复算结果投影不一致(含 details 子结果与 display):${diff}`);
    }
    if (JSON.stringify(r.inputs_resolved ?? {}) !== JSON.stringify(out.inputs_resolved ?? {}))
      errors.push(`${path.basename(c.file)} 复算 inputs_resolved(序列文件 sha256/行数)不一致`);
  }
  return ok(errors);
};

/**
 * agent 行为检查(由 events 记录的命令 / 文件变更):
 *  (a) 命令含禁止关键词(交接资料 / 既有研究 / ../)→ 违规;
 *  (b) 命令里出现用户主目录下、且不在允许前缀(仓库根 / 解释器 / 系统目录)内的绝对路径 → 读取他人文件;
 *  (c) agent 自行运行取数脚本 → 违规(取数只能由编排器执行);
 *  (d) 文件变更路径在运行目录之外 → 违规。
 */
export function checkAgentTrace(trace: AgentTrace, cfg: Pick<RunConfig, "forbiddenPathPatterns" | "allowedPathPrefixes" | "runDir" | "scriptsRel">): ValidationResult {
  const errors: string[] = [];
  const prefixes = cfg.allowedPathPrefixes.filter(Boolean).map((p) => p.replace(/\/+$/, ""));
  const inAllowed = (p: string) => prefixes.some((pre) => p === pre || p.startsWith(pre + "/"));
  // 读禁区(线程沙箱是 workspace-write、全盘可读,只能在这里拦):raw/ 是未净化的互联网原文(不可信文本可能诱导 agent 去读),
  // 产品凭据 / 配置 / 密钥与主目录路径一律不许在命令里出现。agent 只读 fetch/ 的净化值、calcs/、stages/。
  const READ_DENY: [RegExp, string][] = [
    [/(^|[\s/"'=(`])raw\/(?!extracted_)|\/raw\/(?!extracted_)/, "读取 raw/ 原文(不可信原文只能经 fetch/ 的净化值读;raw/extracted_*.csv 是提取出的数值表,放行)"],
    [/auth\.json|api\.token|codex-home|\.local\/config\.json|(^|[\s/"'=(`])\.env(?![\w.])|id_rsa|\.ssh\/|\.npmrc|\.netrc/, "触及产品凭据 / 配置 / 密钥文件"],
    [/(^|[\s"'=(`])~\/|\$HOME(?![\w])|\$\{HOME\}/, "使用主目录路径(~ / $HOME)"],
  ];
  for (const cmd of trace.commands) {
    for (const p of cfg.forbiddenPathPatterns) if (cmd.includes(p)) errors.push(`命令越界:含「${p}」→ ${cmd.slice(0, 160)}`);
    // calc/cli.py 的 --args JSON 里合法地带 raw_ref(history_csv 指向 raw/extracted_*.csv,是提取出的数值表不是不可信文本;ht5/ht6 真踩误伤)→ 判读禁区时剥掉
    // ① raw_ref 键后面的 raw 路径是 calc 的输入引用(history_csv / history_json),不是读取;② 调 calc 时 --args 到下一个 --evidence / --calc / --run-dir 之间整段剥掉
    //    (展示拼接形态的引号翻译成 '"'{\"…}'"' 时,按引号剥会漏 —— ht12 真踩:K 线计算的 raw_ref 被当读取 raw,risk / report 各失败 3 次)
    //    ③ 先按 && / || / ; / 换行切成命令段,只在**调 calc 的那一段**剥 --args,后续段的 `cat raw/x` 照拦(Codex choke-r3)
    const forDeny = cmd.split(/&&|\|\||;|\n/).map((seg) => {
      let t = seg.replace(/raw_ref\\?["']?\s*[:=]\s*\\?["']?raw\/[^\s"'\\]+/g, " RAWREF ");
      if (/calc\/cli\.py/.test(t)) t = t.replace(/--args\s[\s\S]*?(?=\s--(?:evidence|calc|run-dir)\b|$)/g, "--args Q");
      return t;
    }).join(" ; ");
    for (const [re, why] of READ_DENY) if (re.test(forDeny)) errors.push(`命令${why}→ ${cmd.slice(0, 160)}`);
    // 形态规则只对真实脚本跑(钩子路径拿到的就是脚本本体)。事件流里的命令是 Codex 的展示拼接 `/bin/zsh -lc '…'`,内层引号被渲染成
    // `'"'` 这类无法可靠还原的形态,对它做形态分析会把合法的 `x=$(jq …)` 判成"替换当路径段"(语料回归 47 条误伤)→ 展示形态只跑上面的字面规则。
    if (!isDisplayWrapped(cmd)) for (const why of commandSafetyErrors(cmd, cfg.runDir, cfg.allowedPathPrefixes)) errors.push(`${why}→ ${cmd.slice(0, 160)}`);
    if (cmd.includes(cfg.scriptsRel) || /fetch_[a-z_]+\.py/.test(cmd)) errors.push(`agent 自行运行了取数脚本(取数只能由编排器执行)→ ${cmd.slice(0, 160)}`);
    for (const tok of cmd.match(/(?<![\w@:$}){\]])\/[^\s'"`;|&()<>]+/g) ?? []) {
      const clean = tok.replace(/[.,:]+$/, "");
      if (!HOME_PREFIXES.some((h) => clean.startsWith(h))) continue;
      if (!inAllowed(clean)) errors.push(`命令访问仓库外路径:${clean} → ${cmd.slice(0, 120)}`);
    }
  }
  const runRoot = path.resolve(cfg.runDir);
  const protectedDirs = [path.join(runRoot, "fetch"), path.join(runRoot, "raw"), path.join(runRoot, ".vibe")];
  for (const f of trace.fileChanges) {
    const p = path.resolve(f);
    if (!(p === runRoot || p.startsWith(runRoot + path.sep))) errors.push(`agent 写入了运行目录之外的文件:${f}`);
    else if (protectedDirs.some((d) => p === d || p.startsWith(d + path.sep)) || path.basename(p) === "conflicts.json" || path.basename(p) === "manifest.json" || path.basename(p) === "events.jsonl")
      errors.push(`agent 改写了受保护的取数 / 编排 / 钩子产物:${f}(只允许写 calcs/ stages/ report.md)`);
  }
  // 受保护路径(绝对或相对写法都算):fetch/ raw/ .vibe/ 目录,以及账本 / 冲突集 / manifest / events / 钩子上下文与日志
  const PROT = "((^|[\\s/\"'=])(fetch|raw|\\.vibe)\\/|_ledger\\.json|conflicts\\.json|manifest\\.json|events\\.jsonl|hook-context\\.json|hooks\\.log)";
  const writePatterns = [
    new RegExp(`>>?\\s*['"]?[^\\s'"|;&]*${PROT}`),                                   // 重定向到受保护路径
    new RegExp(`(^|[\\s;&|])(tee|cp|mv|rm|sed\\s+-i\\S*|truncate|shred|touch|mkdir)\\s[^\\n;|&]*${PROT}`), // 写 / 删 / 就地改
    new RegExp(`open\\([^)]*${PROT}[^)]*['"][wax]`),                                    // python 以写模式打开
    new RegExp(`(write_text|write_bytes|unlink|os\\.remove|shutil\\.(copy|move|rmtree)|writeFileSync|appendFileSync|rmSync|unlinkSync)[^\\n]*${PROT}`),
  ];
  for (const cmd of trace.commands) {
    if (writePatterns.some((re) => re.test(cmd)))
      errors.push(`命令疑似改写受保护产物(fetch/ raw/ 账本 / 冲突集 / manifest / events):${cmd.slice(0, 160)}`);
  }
  return ok(errors);
}

/**
 * 命令安全(Codex 审查 voice-r2 / r3b;规则用 1,142 条真实运行命令做过语料回归):正则黑名单不是安全边界——
 * `r?w/*.txt`、`.local/codex-*\/a*.json`、`$(echo raw)` 都绕得过字面量匹配。这里补的是**形态规则**,目标是拦住明显的 raw/ 与凭据读取形态、且不误伤 agent 的合法命令:
 * ① 路径通配(含 "/" 的 `*?[` 记号)的字面前缀必须落在 fetch/ calcs/ stages/ 段下(`calcs/*.json`、`"$RUN"/calcs/*.json`、`.local/runs/x/calcs/0[1-9]_*.json` 都合法;`*\/*`、`r?w/x`、`$X/*` 不行);
 *    不含斜杠的通配只能匹配运行目录顶层,那里没有不可信原文;jq / test 语法里的 `[]`、`$f[0].evidence[]` 也都没有斜杠;
 * ② 命令替换 `$(…)` / 反引号 / 进程替换 `<(…)` 放行(agent 常用 `ids=$(jq …)`、`--argjson x "$(jq …)"`、`--slurpfile c <(jq -s …)`),但内部递归按同一套规则查,
 *    替换结果不得直接当路径段(`$(…)/x`、`/$(…)`),替换内部不得引用 raw(raw_ref / raw_files → 结果就是 raw 路径;调 calc/cli.py 的命令除外,history_csv 就靠它);
 * ③ 禁 eval;禁枚举与改权限类命令(find / xargs / chmod / chown / chflags / ln / xattr / sudo / doas / env -i / locate / mdfind);禁字符串构造器(printf 转义 / base64 -d / xxd);
 * ④ python 文本里禁目录枚举(glob / os.listdir / os.walk / os.scandir / iterdir / rglob)与子进程 / 改权限;⑤ 禁裸词 raw / codex-home 当路径段(raw/extracted_*.csv 是提取出的数值表,放行)。
 * 事件流里的命令是 Codex 的展示拼接 `/bin/zsh -lc "<脚本>"`(内层引号有时转义有时不转义)→ 先剥外壳、还原 `\"`;引号段一趟从左到右剥(单双交错分两趟会剥错);heredoc 正文不做 shell 形态检查但做 python 规则。
 * ⚠️ 真正的物理隔离(raw 加密落盘、线程只见密文)仍是待办;本函数是纵深防御的一层。
 */
const DISPLAY_WRAP_RE = /^\s*(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+(["'])([\s\S]*)\1\s*$/;
/** Codex 事件流里的展示拼接形态 `/bin/zsh -lc "…"` / `'…'` */
export function isDisplayWrapped(cmd: string): boolean {
  return DISPLAY_WRAP_RE.test(cmd);
}

/** 找第一个 `$(` / `<(` / `>(` / 反引号 替换,括号按深度配对(忽略引号内的括号不做,jq 程序括号总体平衡即可);返回 {start,end,inner} */
export function findSubstitution(text: string): { start: number; end: number; inner: string } | null {
  const bt = /`([^`]*)`/.exec(text);
  const m = /[$<>]\(/.exec(text);
  if (!m && !bt) return null;
  if (!m || (bt && bt.index < m.index)) return bt ? { start: bt.index, end: bt.index + bt[0].length, inner: bt[1] } : null;
  let depth = 0;
  for (let i = m.index + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return { start: m.index, end: i + 1, inner: text.slice(m.index + 2, i) }; }
  }
  return { start: m.index, end: text.length, inner: text.slice(m.index + 2) };  // 未闭合:当作到末尾
}

export function commandSafetyErrors(cmdRaw: string, runDir: string, allowedPrefixes: string[] = []): string[] {
  const errors: string[] = [];
  const wrap = DISPLAY_WRAP_RE.exec(cmdRaw);
  const cmd = wrap ? wrap[2].replace(/\\"/g, '"') : cmdRaw;
  const callsCalc = /calc\/cli\.py|--args\s/.test(cmd);  // 变量调用("$CLI" … --args)也算
  const hd = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\1\s*$/m.exec(cmd);
  let shell = hd ? cmd.slice(0, hd.index) + cmd.slice(hd.index + hd[0].length) : cmd;
  // 替换 / 进程替换:按括号深度配对取出(jq 程序里常有括号),由外向内递归检查,换成占位 §SUB§(占位与相邻字符贴合,便于判"当路径段")
  for (let guard = 0; guard < 50; guard++) {
    const sub = findSubstitution(shell);
    if (!sub) break;
    const inner = sub.inner.trim();
    if (inner) {
      for (const e of commandSafetyErrors(inner, runDir, allowedPrefixes)) errors.push(`替换内部:${e}`);
      if (/raw/i.test(inner) && !callsCalc) errors.push("命令替换内部引用 raw(raw_ref / raw_files,其结果可能是 raw 路径)");
    }
    shell = shell.slice(0, sub.start) + "§SUB§" + shell.slice(sub.end);
  }
  // 紧贴才算路径段(`$(…)/x`、`/$(…)`);隔着换行的下一行以 / 开头不算(`x=$(jq …)\n/usr/bin/python …` 是两条语句)
  if (/§SUB§\/|\/§SUB§/.test(shell)) errors.push("命令替换的结果被当作路径段(禁止)");
  if (/(^|[\s;&|])eval\s/.test(shell)) errors.push("命令含 eval(禁止)");
  if (/printf[^\n;|]*\\[xu0-7]|base64\s+(-d|--decode)|(^|[\s;&|])xxd(?=\s|$)/.test(shell)) errors.push("命令含字符串构造器(printf 转义 / base64 -d / xxd)");
  const unquoted = shell.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " Q ");
  if (/(^|[\s;&|(])(chmod|chown|chflags|ln|xattr|sudo|doas|env\s+-i|locate|mdfind)(?=\s|$)/.test(unquoted)) errors.push("命令含改权限 / 全盘检索类程序(chmod / chown / ln / xattr / sudo / locate / mdfind)");
  // find:路径参数须落在 fetch/ calcs/ stages/(agent 真用 `find calcs -maxdepth 1 -type f`,ht9);禁 -exec / -execdir / -ok / -delete;xargs 本身不危险,它喂的命令同受本规则
  for (const m of unquoted.matchAll(/(^|[\s;&|(])find\s+([^\n;|&]*)/g)) {
    const args = m[2].trim().split(/\s+/);
    const paths = []; for (const a of args) { if (a.startsWith("-") || a === "Q") break; paths.push(a); }
    if (/-(exec|execdir|ok|okdir|delete)(?=\s|$)/.test(m[2])) errors.push("find 带 -exec / -delete(禁止)");
    if (!paths.length || !paths.every((p) => /^(\.\/)?(fetch|calcs|stages)(\/|$)/.test(p) && !p.includes(".."))) errors.push(`find 的路径只允许 fetch/ calcs/ stages/:${m[0].trim().slice(0, 60)}`);
  }
  if (/(^|[\s=:/(])(raw(?!\/extracted_)|codex-home)(?=$|[\s/;:)'"])/.test(unquoted)) errors.push("命令含裸路径段 raw / codex-home");
  // python 枚举:字面参数落在 fetch/ calcs/ stages/ 下放行(`glob.glob("fetch/*.json")`,Codex r3d);其它一律拦;子进程 / 改权限不看参数
  if (/\b(subprocess|os\s*\.\s*system|pty\.|os\s*\.\s*chmod)/.test(cmd)) errors.push("命令含子进程 / 改权限的 Python 调用");
  for (const m of cmd.matchAll(/\b(?:glob\s*\.\s*(?:glob|iglob)|os\s*\.\s*(?:listdir|walk|scandir)|\.(?:iterdir|rglob|glob))\s*\(\s*(?:r?["']([^"']*)["'])?/g)) {
    const lit = m[1];
    if (lit !== undefined && /^(\.\/)?(fetch|calcs|stages)(\/|$)/.test(lit) && !/\.\./.test(lit)) continue;
    errors.push(`命令含目录枚举的 Python 调用(只允许字面路径在 fetch/ calcs/ stages/ 下):${m[0].slice(0, 50)}`);
  }
  // 路径通配:参数展开 `${spec%%:*}` 的 * 是子串操作符 → 先换占位;只看含 "/" 的记号;剥掉 `$RUN/` 变量前缀后,字面前缀须含 fetch/ calcs/ stages/ 段且不含 raw/ .vibe/ ..
  const globText = unquoted.replace(/\$\{[^}]*\}/g, " V ");
  for (const tok0 of globText.split(/\s+/)) {
    if (!/[*?[]/.test(tok0) || !tok0.includes("/") || /^\d*[<>]/.test(tok0)) continue;
    const tok = tok0.replace(/^\$\{?[A-Za-z_]\w*\}?\//, "").replace(/^Q\//, "");
    const prefix = tok.slice(0, tok.search(/[*?[]/));
    const unsafe = /raw\/|\.vibe\/|\.\.|codex-home/.test(prefix);
    // 仓库源码 / skills 目录下的通配也放行(agent 偶尔 `rg … orchestrator/src/*.ts` 看代码),但 .local/ 下只认 fetch/ calcs/ stages/ 段
    const underAllowed = path.isAbsolute(prefix) && allowedPrefixes.some((p) => p && prefix.startsWith(p.replace(/\/+$/, "") + "/")) && !/\/\.local\//.test(prefix);
    const ok = !unsafe && (/(^|\/)(fetch|calcs|stages)\//.test(prefix) || underAllowed);
    if (!ok) errors.push(`通配符只允许在 fetch/ calcs/ stages/ 下:${tok0.slice(0, 60)}`);
  }
  return errors;
}

/** 收尾后对最终文件再次做 schema 校验 */
export function validateFinalArtifacts(runDir: string): ValidationResult {
  const errors: string[] = [];
  const ev = readJsonIfExists<unknown[]>(path.join(runDir, "evidence.json"));
  if (!Array.isArray(ev)) errors.push("evidence.json 缺失或不是数组");
  else ev.forEach((e, i) => { const r = validateEvidenceItem(e); if (r.length) errors.push(`evidence.json[${i}] ${r[0]}`); });
  const cs = readJsonIfExists<unknown[]>(path.join(runDir, "calculations.json"));
  if (!Array.isArray(cs)) errors.push("calculations.json 缺失或不是数组");
  else cs.forEach((c, i) => { const r = validateCalcRecord(c); if (r.length) errors.push(`calculations.json[${i}] ${r[0]}`); });
  return ok(errors.slice(0, 20));
}

/** 编排器自有产物认证:events.jsonl 的内容摘要与 runner 记录一致;conflicts.json / manifest.json 与编排器最后一次写入的 sha256 一致 */
export interface ProtectedExpectation { files: Record<string, string>; eventsSha: string | null }
export function validateProtectedArtifacts(runDir: string, expected: ProtectedExpectation): ValidationResult {
  const errors: string[] = [];
  for (const [rel, sha] of Object.entries(expected.files)) {
    const p = path.join(runDir, rel);
    if (!fs.existsSync(p)) { errors.push(`编排器产物 ${rel} 被删除`); continue; }
    if (sha256File(p) !== sha) errors.push(`编排器产物 ${rel} 被改写(sha256 与编排器记录不一致)`);
  }
  if (expected.eventsSha) {
    const p = path.join(runDir, "events.jsonl");
    if (!fs.existsSync(p) || sha256File(p) !== expected.eventsSha) errors.push("events.jsonl 内容与编排器记录不一致(被截断 / 改写 / 追加)");
  }
  return ok(errors);
}

/** 阶段状态的确定性推导(不以 agent 自报为准) */
export function deriveStageStatus(stage: Stage, validatorOk: boolean, turnFailed: boolean, run: RunView): StageStatus {
  if (!validatorOk || turnFailed) return "failed";
  const so = run.stage(stage);
  const requiredFailed = run.plan[stage].required.some((s) => !run.fetch[s] || run.fetch[s].status === "failed");
  if (requiredFailed) return "incomplete";
  if (so?.status === "skipped") return "skipped";
  if (so?.status === "incomplete") return "incomplete";
  if ((so?.gaps ?? []).some((g) => STAGE_CALCS[stage].includes(g.operation))) return "incomplete";
  return "complete";
}

export function allCriticalFetchFailed(run: RunView): boolean {
  return run.critical.every((s) => !run.fetch[s] || run.fetch[s].status === "failed");
}

export function summarizeErrorsForAgent(res: ValidationResult, max = 12): string {
  const lines = res.errors.slice(0, max).map((e, i) => `${i + 1}. ${e}`);
  if (res.errors.length > max) lines.push(`…另有 ${res.errors.length - max} 条`);
  return lines.join("\n");
}
