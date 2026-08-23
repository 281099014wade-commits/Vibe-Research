/**
 * 主流程(可注入依赖,便于用假运行器做端到端状态机测试):
 * 每阶段:编排器执行取数(账本)→ agent turn → validator(+ agent 行为 + 复算)→ 不过自动补跑 → 阶段状态确定性推导
 * → 合规 gate 重写循环(重写后全量复验)→ 最终状态(failed > stale > incomplete > complete)→ 报告状态归一
 * → 合并产物 + 最终 schema 校验 + manifest。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { STAGES, STATUS_PRIORITY, type RunConfig, type RunStatus, type Stage } from "./config.ts";
import { ledgerSummary, type FetchExecutor, type Ledger } from "./fetchrun.ts";
import { PLAN_REL, planFileOf } from "./registry.ts";
import { archiveRun, recallKnowledge, shouldRecall } from "./knowledge.ts";
import { INDUSTRY_FILE_REL, applyIndustryGate, detectIndustryTags, loadIndustryTags, writeIndustryFile } from "./industry.ts";
import { CHOKE_FILE_REL, loadChokeTable, scanChokepoints, writeChokeFile } from "./chokepoint.ts";
import { writeViewer } from "./viewer.ts";
import { atomicWrite, ensureDirs, nowIso, sha256File, sha256Text, writeJson } from "./fsutil.ts";
import { complianceGate, normalizeReportStatus } from "./gate.ts";
import { HOOK_CONTEXT_REL, clearStopFailed, installHooks, readHookLog, readStopFailed, summarizeHookLog, uninstallHooks, writeHookContext } from "./hooks.ts";
import { installSkillsIsolation } from "./skills_isolation.ts";
import { rawHashes, writeConflicts, writeManifest, writeMergedArtifacts, type Manifest, type StageRecord } from "./merge.ts";
import type { AgentRunner } from "./runner.ts";
import { turnReplySchema, validateManifest } from "./schemas.ts";
import { buildGateRewritePrompt, buildStagePrompt } from "./stages.ts";
import { allCriticalFetchFailed, checkAgentTrace, deriveQuoteDecision, deriveStageStatus, loadRun, summarizeErrorsForAgent, validateFetchIntegrity,
  validateFinalArtifacts, validateProtectedArtifacts, validateReport, validateStage, type AgentTrace, type CalcVerifier, type ProtectedExpectation,
  type ValidationResult } from "./validator.ts";

export interface Deps {
  runner: AgentRunner;
  fetchRunner: FetchExecutor;
  verify: CalcVerifier;
  sdkVersion: () => { version: string; binary: string | null };
}

export interface RunResult { status: RunStatus; exitCode: number; manifest: Manifest }

export function exitCodeFor(status: RunStatus): number {
  return status === "complete" ? 0 : status === "failed" ? 3 : 2;
}

export function deriveRunStatus(input: { stages: StageRecord[]; gateOk: boolean; reportExists: boolean; quoteDecision: string | null;
  criticalAllFailed: boolean; partial: boolean }): RunStatus {
  const c: RunStatus[] = [];
  if (!input.reportExists || !input.gateOk || input.criticalAllFailed || input.stages.some((s) => s.status === "failed")) c.push("failed");
  if (input.quoteDecision === "stale") c.push("stale");
  if (input.partial || input.stages.some((s) => s.status !== "complete")) c.push("incomplete");
  c.push("complete");
  return STATUS_PRIORITY.find((s) => c.includes(s)) ?? "incomplete";
}

function sh(cmd: string, args: string[], cwd: string): string {
  try { return (spawnSync(cmd, args, { encoding: "utf8", cwd, timeout: 30_000 }).stdout || "").trim(); } catch { return ""; }
}

/** 运行目录必须在 <repo>/.local/runs/ 之下;已存在且非空 → 需 overwrite */
export function prepareRunDir(cfg: RunConfig): void {
  const runsRoot = path.resolve(cfg.dataRoot, "runs");
  const rd = path.resolve(cfg.runDir);
  if (path.dirname(rd) !== runsRoot) throw new Error(`运行目录必须是 ${runsRoot} 的直接子目录:${rd}`);
  // 宪法必须存在;且运行目录(Codex 线程 cwd)必须在产品根之内——Codex 只从 .git 项目根逐级发现到 cwd 的 AGENTS.md / .agents/skills(v2.1 安装布局 data/ 在 app/ 外时需 launcher 另行解决,见开发日志)
  if (!fs.existsSync(cfg.constitutionPath)) throw new Error(`宪法文件不存在:${cfg.constitutionPath}`);
  const discovered = path.join(path.resolve(cfg.repoRoot), "AGENTS.md");
  if (path.resolve(cfg.constitutionPath) !== discovered)
    throw new Error(`Phase 0 宪法必须是产品根的 AGENTS.md(${discovered}),因为 Codex 自动加载的就是它;配置为 ${cfg.constitutionPath} 不会被引擎加载(自定义宪法路径需 Phase 1 另造加载机制)`);
  const root = path.resolve(cfg.repoRoot);
  if (!rd.startsWith(root + path.sep)) throw new Error(`运行目录 ${rd} 不在产品根 ${root} 之内:Codex 将发现不到 AGENTS.md / .agents/skills(Phase 0 限制;Phase 1 launcher 需设 project_root_markers 或把 data 放在产品根内)`);
  if (fs.existsSync(rd) && fs.readdirSync(rd).length > 0) {
    if (!cfg.overwrite) throw new Error(`运行目录已存在且非空:${rd}(复用 run-id 会混入旧证据;换 run-id 或加 --overwrite)`);
    fs.rmSync(rd, { recursive: true, force: true });
  }
  ensureDirs(rd, ["raw", "fetch", "calcs", "stages"]);
}

export async function runResearch(cfg: RunConfig, deps: Deps, onlyStages?: Stage[]): Promise<RunResult> {
  prepareRunDir(cfg);
  try {
    return await runResearchInner(cfg, deps, onlyStages);
  } catch (e) {
    // 异常路径也要闭合领域事件(API / UI 不会永远停在 running),并把 manifest 标为 failed
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const mp = path.join(cfg.runDir, "manifest.json");
      const m = fs.existsSync(mp) ? (JSON.parse(fs.readFileSync(mp, "utf8")) as Manifest) : null;
      if (m) { m.status = "failed"; m.exit_code = 3; m.finished_at = nowIso(); m.final_errors = [...(m.final_errors ?? []), `exception:${msg}`]; writeManifest(cfg, m); }
    } catch { /* 尽力而为 */ }
    deps.runner.log("orchestrator", "research.failed", { error: msg });
    deps.runner.log("orchestrator", "research.finished", { run_id: cfg.runId, status: "failed", exit_code: 3, error: msg });
    throw e;
  }
}

async function runResearchInner(cfg: RunConfig, deps: Deps, onlyStages?: Stage[]): Promise<RunResult> {
  const { runner } = deps;
  const sdk = deps.sdkVersion();
  let calcVersion = "unknown";
  try { calcVersion = JSON.parse(sh(cfg.python, [path.join(cfg.repoRoot, cfg.calcCliRel), "list"], cfg.repoRoot)).calc_version ?? "unknown"; } catch { /* unknown */ }
  const headOk = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: cfg.repoRoot, encoding: "utf8" }).status === 0;
  const repoVersion = headOk ? sh("git", ["rev-parse", "HEAD"], cfg.repoRoot) : "uncommitted(无提交)";
  const stagesToRun = STAGES.filter((s) => !onlyStages || onlyStages.includes(s));
  const partial = stagesToRun.length !== STAGES.length;
  const configHash = sha256Text(JSON.stringify({ ...cfg, runDir: undefined, repoRoot: undefined })).slice(0, 16);

  const manifest: Manifest = {
    run_id: cfg.runId, symbol: cfg.symbol, market: cfg.market, started_at: nowIso(), finished_at: null, status: "running", stages: [],
    codex_version: sdk.version, model: cfg.model ?? null, model_note: cfg.model ? "显式指定" : "未指定:使用 provider 的默认模型(事件流不回报实际模型名)",
    provider: { name: cfg.provider.name, wire_api: cfg.provider.wire_api, base_url: cfg.provider.base_url, env_key: cfg.provider.env_key, auth: cfg.provider.auth, profile: cfg.providerProfile?.id ?? null, matrix_status: cfg.providerProfile?.matrix?.status ?? null },
    engine: { codex_path: cfg.codexPath, codex_home: cfg.codexHome, binary: sdk.binary },
    constitution: { path: cfg.constitutionPath, sha256: sha256File(cfg.constitutionPath) },
    hooks: { enabled: cfg.hooksEnabled, installed: false, hooks_json: null, invocations: 0, stop_blocks: 0, stop_terminations: 0, pre_tool_use_blocks: 0, errors: 0, log_trust: "diagnostic_untrusted" },
    calc_version: calcVersion, repo_version: repoVersion, config_hash: configHash, raw_hashes: {}, execution_scope: [...stagesToRun], partial_run: partial,
    thread_id: null, fetch_ledger: {}, evidence_count: 0, calculation_count: 0, evidence_conflicts: [], gate: { ok: true, hits: [] }, exit_code: 2,
    endpoint_scope: cfg.endpointScope, registry_version: cfg.registryVersion,
  };
  /** 编排器自有产物的 sha256(conflicts.json / manifest.json),与 runner 的 events 摘要一起构成"受保护产物"认证 */
  const protectedFiles: Record<string, string> = {};
  const persistManifest = () => { writeManifest(cfg, manifest); protectedFiles["manifest.json"] = sha256File(path.join(cfg.runDir, "manifest.json")); };
  const protectedNow = (): ProtectedExpectation => ({ files: { ...protectedFiles }, eventsSha: runner.eventsDigest() });
  // skills 隔离(执行层,常开):把用户主目录 ~/.agents/skills 与捆绑系统 skills 从产品 CODEX_HOME 的 catalog 里禁掉,只留产品 .agents/skills(skills_isolation.ts)
  if (!cfg.noAgent) {
    const iso = installSkillsIsolation(cfg);  // cfg 含 repoRoot(产品 skill 不写入)与 python(写前 tomllib 校验)
    manifest.skills_isolation = { installed: true, config_toml: iso.configTomlPath, disabled_user_skills: iso.disabledPaths.length, bundled_disabled: iso.bundledDisabled, max_context_tokens: iso.maxContextTokens, truncated: iso.truncated };
    // 事件只记数量 + 清单哈希:events.jsonl 会经 service 层(API / MCP research_status.last_events)回给调用方,不带用户主目录下的路径清单
    runner.log("orchestrator", "skills.isolated", { config_toml: iso.configTomlPath, disabled_user_skills: iso.disabledPaths.length, disabled_sha256: iso.disabledSha256, bundled_disabled: iso.bundledDisabled, max_context_tokens: iso.maxContextTokens, excluded_in_repo: iso.excludedInRepo, truncated: iso.truncated, toml_validated: iso.tomlValidated, changed: iso.changed });
    // 触及 Codex 截断边界(2,000 目录 / 20,000 条目)= 清单可能不完整,出声但不中断(Codex 自己也在同一边界截断、继续运行)
    if (iso.truncated) runner.log("orchestrator", "skills.isolation_truncated", { disabled_user_skills: iso.disabledPaths.length, note: "用户级 skill 根超过 Codex 截断边界,未枚举到的 skill 也不会被 Codex 看到;如需完整隔离请清理 ~/.agents/skills 下的大目录(如 node_modules)" });
  }
  // hooks v0(执行层):安装到产品 CODEX_HOME(hooks.json + trusted_hash),每个 turn 前写钩子上下文(受保护)
  if (!cfg.hooksEnabled && !cfg.noAgent) { uninstallHooks(cfg); runner.log("orchestrator", "hooks.uninstalled", { codex_home: cfg.codexHome }); }
  if (cfg.hooksEnabled && !cfg.noAgent) {
    const fault = cfg.scenario?.hook_fault;
    const inst = installHooks(cfg, process.execPath, fault === "timeout" || fault === "crash" ? fault : undefined);
    if (fault) runner.log("orchestrator", "scenario.hook_fault", { fault });
    manifest.hooks.installed = true;
    manifest.hooks.hooks_json = inst.hooksJsonPath;
    runner.log("orchestrator", "hooks.installed", { hooks_json: inst.hooksJsonPath, config_toml: inst.configTomlPath, states: inst.states });
  }
  const hookCtx = (stage: Stage, attempt: number) => {
    if (!cfg.hooksEnabled) return;
    clearStopFailed(cfg.runDir);
    if (cfg.scenario?.hook_fault === "context_missing" && stage === (cfg.scenario.probe_stage ?? "profile")) {
      // 故障注入:本阶段不写钩子上下文 → 钩子应放行但出声(hooks.log error),编排器 validator 兜底
      const p = path.join(cfg.runDir, HOOK_CONTEXT_REL); if (fs.existsSync(p)) fs.rmSync(p); delete protectedFiles[HOOK_CONTEXT_REL];
      runner.log(stage, "scenario.hook_context_withheld", { attempt });
      return;
    }
    writeHookContext(cfg, stage, attempt);
    protectedFiles[HOOK_CONTEXT_REL] = sha256File(path.join(cfg.runDir, HOOK_CONTEXT_REL));
  };
  /** turn 后汇总钩子日志(诊断,不可信);Stop 钩子留下终止标记 → 该 turn 视为失败(缺产物不许正常收工) */
  const hookSummary = (stage: Stage, attempt: number): string | null => {
    if (!cfg.hooksEnabled) return null;
    const sum = summarizeHookLog(readHookLog(cfg.runDir));
    Object.assign(manifest.hooks, sum);
    runner.log(stage, "hooks.summary", { attempt, ...sum });
    const marker = readStopFailed(cfg.runDir);
    if (marker && marker.stage === stage && marker.attempt === attempt) {
      runner.log(stage, "hooks.stop_terminated", { attempt, blocks: marker.blocks, problems: marker.problems.slice(0, 6) });
      return `Stop 钩子终止本轮(拦截 ${marker.blocks} 次后仍不合格):${marker.problems.slice(0, 3).join("; ")}`;
    }
    return null;
  };
  // M2 知识层召回:只在未由 scenario 注入且开启时;注入文本进全阶段提示词,由 knowledge_conflicts 裁决
  if (shouldRecall(cfg)) {
    const k = recallKnowledge(cfg);
    if (k) { cfg.knowledge = { as_of: k.as_of, text: k.text, status: k.status, path: k.path }; manifest.knowledge_recalled = { path: k.path, as_of: k.as_of, status: k.status, truncated: k.truncated }; runner.log("orchestrator", "knowledge.recalled", { path: k.path, as_of: k.as_of, status: k.status, chars: k.text.length, truncated: k.truncated }); }
    else { manifest.knowledge_recalled = null; runner.log("orchestrator", "knowledge.none", { dir: path.join(cfg.dataRoot, "knowledge") }); }
  } else manifest.knowledge_recalled = null;
  persistManifest();
  runner.log("orchestrator", "run.start", { config: { ...cfg, endpoints: Object.keys(cfg.endpoints).length }, codex_version: sdk.version, codex_binary: sdk.binary, calc_version: calcVersion, repo_version: repoVersion, stages: stagesToRun });
  // 领域事件(v2.1 §5 ④,供 API / UI 消费):research.started / stage.completed / gate.failed / report.ready / research.finished
  runner.log("orchestrator", "research.started", { run_id: cfg.runId, symbol: cfg.symbol, market: cfg.market, stages: stagesToRun, run_dir: cfg.runDir });

  const stageRecords: StageRecord[] = [];
  const trace: AgentTrace = { commands: [], fileChanges: [] };
  const statusSoFar: Record<string, string> = {};
  /** 权威账本:只存在于编排器内存;磁盘上的 _ledger.json 仅供审计,validator 从不读它 */
  const ledger: Ledger = {};
  /** 阶段计划(注册表推导):validator 用内存计划;fetch/_plan.json 仅供审计与 --no-agent 复核 */
  const planOf = { plan: cfg.stagePlan, critical: cfg.criticalScripts, endpoints: cfg.endpoints };
  writeJson(path.join(cfg.runDir, PLAN_REL), planFileOf(cfg.endpointScope, cfg.registryVersion, cfg.stagePlan, cfg.criticalScripts, cfg.endpoints));
  runner.log("orchestrator", "plan.written", { scope: cfg.endpointScope, registry_version: cfg.registryVersion, stages: Object.fromEntries(Object.entries(cfg.stagePlan).map(([k, v]) => [k, { required: v.required.length, optional: v.optional.length }])) });

  for (const stage of stagesToRun) {
    const scripts = cfg.stagePlan[stage];
    let toFetch = [...scripts.required, ...scripts.optional];
    // 产业温度计门控(第 13 层):带 industry_tags 的端点只在标的命中对应产业标签时才取;判定用 profile 阶段已落盘的行业 / 概念信封
    if (toFetch.some((id) => (cfg.endpoints[id]?.industry_tags ?? []).length)) {
      const table = loadIndustryTags(cfg.repoRoot);  // 缺失 / 损坏直接抛 → 运行失败出声,不当"零标签"
      const det = detectIndustryTags(cfg.runDir, table);
      const gate = applyIndustryGate(toFetch, cfg.endpoints, det.tags);
      toFetch = gate.included;
      const f = writeIndustryFile(cfg.runDir, table, det, gate);
      protectedFiles[INDUSTRY_FILE_REL] = sha256File(path.join(cfg.runDir, INDUSTRY_FILE_REL));
      manifest.industry_tags = { tags: f.tags, matched: f.matched, skipped: f.skipped, signals: f.signals };
      runner.log(stage, "industry.gate", { tags: f.tags, matched: f.matched, skipped: f.skipped, signals: f.signals });
    }
    deps.fetchRunner(cfg, stage, toFetch, (t, p) => runner.log(stage, t, p), ledger);
    // 卡口事件分类(确定性,不拉新数据):risk 阶段取数后扫公司自己的公告 / 新闻信封 → fetch/_chokepoints.json(受保护)
    if (stage === "risk" || stage === "report") {
      const cp = scanChokepoints(cfg.runDir, loadChokeTable(cfg.repoRoot));
      writeChokeFile(cfg.runDir, cp);
      protectedFiles[CHOKE_FILE_REL] = sha256File(path.join(cfg.runDir, CHOKE_FILE_REL));
      manifest.chokepoints = { scanned: cp.scanned, hits: cp.hits.length, by_category: cp.by_category };
      runner.log(stage, "chokepoint.scan", { scanned: cp.scanned, hits: cp.hits.length, by_category: cp.by_category, scripts: cp.scripts });
    }
    // 取数后即刷新权威冲突集(risk / report 阶段的 agent 读 conflicts.json;validator 核对 risk.source_conflicts 覆盖)
    const conf = writeConflicts(cfg);
    protectedFiles["conflicts.json"] = sha256File(path.join(cfg.runDir, "conflicts.json"));
    if (conf.sourceConflicts.length || conf.idConflicts.length) runner.log(stage, "conflicts.updated", { source: conf.sourceConflicts.length, id: conf.idConflicts.length });
    const rec: StageRecord = { stage, status: "failed", attempts: 0, errors: [], validator_ok: false };
    let res: ValidationResult = { ok: false, errors: ["未运行"], warnings: [] };
    let lastErrors: string[] | undefined;
    let turnFailed = false;
    const maxAttempts = cfg.noAgent ? 1 : cfg.maxRetries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      rec.attempts = attempt + 1;
      turnFailed = false;
      if (!cfg.noAgent) {
        const prompt = buildStagePrompt(stage, cfg, { attempt, validatorErrors: lastErrors, stageStatusSoFar: statusSoFar, ledger });
        console.error(`[orchestrator] stage=${stage} attempt=${attempt + 1}/${maxAttempts}`);
        hookCtx(stage, attempt + 1);
        const turn = await runner.runTurn(stage, attempt + 1, prompt, turnReplySchema);
        const stopFail = hookSummary(stage, attempt + 1);
        trace.commands.push(...turn.commands.map((c) => c.command));
        trace.fileChanges.push(...turn.fileChanges);
        if (turn.failed) { turnFailed = true; rec.errors.push(`turn 失败:${turn.failed}`); }
        if (stopFail) { turnFailed = true; rec.errors.push(stopFail); }
      }
      const run = loadRun(cfg.runDir, ledger, planOf);
      res = validateStage(stage, run);
      const behaviour = checkAgentTrace(trace, cfg);
      if (!behaviour.ok) res = { ok: false, errors: [...res.errors, ...behaviour.errors], warnings: res.warnings };
      const prot = validateProtectedArtifacts(cfg.runDir, protectedNow());
      if (!prot.ok) res = { ok: false, errors: [...res.errors, ...prot.errors], warnings: res.warnings };
      if (res.ok && run.calcs.length) {
        const rv = deps.verify(cfg, run);
        if (!rv.ok) res = { ok: false, errors: rv.errors, warnings: res.warnings };
      }
      runner.log(stage, "validator", { attempt: attempt + 1, ok: res.ok, errors: res.errors, warnings: res.warnings });
      if (res.ok && !turnFailed) break; // turn 本身失败(含 Stop 钩子终止)即使产物恰好过校验也要补跑
      lastErrors = res.errors;
      console.error(`[orchestrator] stage=${stage} validator 未通过(${res.errors.length} 条)\n${summarizeErrorsForAgent(res, 6)}`);
    }
    rec.validator_ok = res.ok;
    rec.errors.push(...res.errors);
    rec.status = deriveStageStatus(stage, res.ok, turnFailed, loadRun(cfg.runDir, ledger, planOf));
    stageRecords.push(rec);
    statusSoFar[stage] = rec.status;
    manifest.stages = stageRecords;
    manifest.fetch_ledger = ledgerSummary(ledger);
    manifest.thread_id = runner.threadId;
    persistManifest();
    runner.log(stage, "stage.completed", { stage, status: rec.status, attempts: rec.attempts, validator_ok: rec.validator_ok, errors: rec.errors.length });
  }

  // 合规 gate:报告阶段 validator 已含 gate;这里是独立的最终一道闸 + 重写循环(重写后全量复验 report 阶段)
  const reportPath = path.join(cfg.runDir, "report.md");
  if (cfg.scenario?.force_gate_hit && fs.existsSync(reportPath) && stagesToRun.includes("report")) {
    // 故障注入(仅硬测试):确定性制造一份命中 gate 的报告,验证"gate 拦截 → 重写 → 复验"链路本身(与 agent 是否自律无关)
    fs.appendFileSync(reportPath, "\n- 【硬测试注入文本】建议建仓并设目标价(此行用于触发合规 gate,重写时必须删除)\n");
    runner.log("report", "scenario.gate_hit_injected", {});
  }
  let gate = complianceGate(fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "");
  const reportRec = stageRecords.find((s) => s.stage === "report");
  let rewriteTurnFailed = false;
  if (!gate.ok) runner.log("report", "gate.failed", { hits: gate.hits, will_rewrite: cfg.gateRetries > 0 && !cfg.noAgent && !!reportRec });
  for (let i = 0; i < cfg.gateRetries && !gate.ok && !cfg.noAgent && reportRec; i++) {
    runner.log("report", "gate.rewrite", { attempt: i + 1, hits: gate.hits });
    hookCtx("report", 100 + i);
    const turn = await runner.runTurn("report", 100 + i, buildGateRewritePrompt(cfg, gate.hits), turnReplySchema);
    const stopFail = hookSummary("report", 100 + i);
    trace.commands.push(...turn.commands.map((c) => c.command));
    trace.fileChanges.push(...turn.fileChanges);
    rewriteTurnFailed = !!turn.failed || !!stopFail;
    if (stopFail) reportRec.errors.push(stopFail);
    if (turn.failed) reportRec.errors.push(`gate 重写 turn 失败:${turn.failed}`);
    const run = loadRun(cfg.runDir, ledger, planOf);
    let rv = validateStage("report", run);
    const behaviour = checkAgentTrace(trace, cfg);
    if (!behaviour.ok) rv = { ok: false, errors: [...rv.errors, ...behaviour.errors], warnings: rv.warnings };
    const prot = validateProtectedArtifacts(cfg.runDir, protectedNow());
    if (!prot.ok) rv = { ok: false, errors: [...rv.errors, ...prot.errors], warnings: rv.warnings };
    if (rv.ok && run.calcs.length) { const v = deps.verify(cfg, run); if (!v.ok) rv = v; }
    runner.log("report", "validator", { attempt: 100 + i + 1, ok: rv.ok, errors: rv.errors, warnings: rv.warnings });
    reportRec.validator_ok = rv.ok;
    reportRec.errors = [...reportRec.errors.filter((e) => e.startsWith("gate 重写 turn 失败")), ...rv.errors];
    reportRec.attempts += 1;
    gate = complianceGate(fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "");
    if (!gate.ok) runner.log("report", "gate.failed", { hits: gate.hits, after_rewrite: i + 1 });
  }
  if (reportRec) reportRec.status = deriveStageStatus("report", reportRec.validator_ok && gate.ok, rewriteTurnFailed, loadRun(cfg.runDir, ledger, planOf));

  // 最终状态(确定性)
  const finalRun = loadRun(cfg.runDir, ledger, planOf);
  const qd = deriveQuoteDecision(finalRun);
  const reportInScope = stagesToRun.includes("report");
  let status = deriveRunStatus({ stages: stageRecords, gateOk: gate.ok, reportExists: reportInScope ? !!finalRun.report : true, quoteDecision: qd.decision,
    criticalAllFailed: allCriticalFetchFailed(finalRun) && stagesToRun.includes("estimates"), partial });

  // 报告首行状态归一(不动正文),并核对一致性;最终校验失败 → 进入状态推导(产物不齐 / 校验不过不得宣称完成)
  const finalErrors: string[] = [];
  if (finalRun.report) {
    const n = normalizeReportStatus(finalRun.report, status);
    if (n.changed) { atomicWrite(reportPath, n.text); runner.log("report", "report.status_normalized", { to: status }); }
    const rv = validateReport(loadRun(cfg.runDir, ledger, planOf), status);
    if (!rv.ok) { runner.log("report", "report.final_check", { errors: rv.errors }); finalErrors.push(...rv.errors.map((e) => `report:${e}`)); }
  }
  const integrity = validateFetchIntegrity(loadRun(cfg.runDir, ledger, planOf));
  if (!integrity.ok) finalErrors.push(...integrity.errors.map((e) => `fetch:${e}`));
  const protFinal = validateProtectedArtifacts(cfg.runDir, protectedNow());
  if (!protFinal.ok) finalErrors.push(...protFinal.errors.map((e) => `protected:${e}`));

  const merged = writeMergedArtifacts(cfg);
  const finalCheck = validateFinalArtifacts(cfg.runDir);
  if (!finalCheck.ok) { runner.log("orchestrator", "final_artifacts.invalid", { errors: finalCheck.errors }); finalErrors.push(...finalCheck.errors.map((e) => `artifacts:${e}`)); }
  if (finalErrors.length && status !== "failed") { runner.log("orchestrator", "status.downgraded", { from: status, to: "failed", reason: finalErrors.slice(0, 5) }); status = "failed"; }
  manifest.status = status;
  manifest.finished_at = nowIso();
  manifest.raw_hashes = rawHashes(cfg.runDir);
  manifest.evidence_count = merged.evidence.length;
  manifest.calculation_count = merged.calcs.length;
  manifest.evidence_conflicts = [...merged.idConflicts.map((c) => ({ kind: "id", detail: c })), ...merged.sourceConflicts.map((c) => ({ kind: "source", ...c }))];
  manifest.gate = { ok: gate.ok, hits: gate.hits };
  manifest.exit_code = exitCodeFor(status);
  manifest.thread_id = runner.threadId;
  manifest.fetch_ledger = ledgerSummary(ledger);
  manifest.quote_decision = qd.decision;
  manifest.final_errors = finalErrors;
  const me = validateManifest(manifest);
  if (me.length) {
    runner.log("orchestrator", "manifest.schema_errors", { errors: me });
    manifest.final_errors = [...finalErrors, ...me.map((e) => `manifest:${e}`)];
    if (manifest.status !== "failed") { manifest.status = "failed"; manifest.exit_code = exitCodeFor("failed"); status = "failed"; }
    const me2 = validateManifest(manifest); // 修改后的最终对象再校验一次;仍不过则记录(状态已是 failed)
    if (me2.length) runner.log("orchestrator", "manifest.schema_errors_after_fix", { errors: me2 });
  }
  // 报告首行与最终状态再对齐一次(状态可能在最终校验后被降级)
  if (fs.existsSync(reportPath)) {
    const n2 = normalizeReportStatus(fs.readFileSync(reportPath, "utf8"), status);
    if (n2.changed) atomicWrite(reportPath, n2.text);
  }
  // M2:查看器 / 附录(运行目录内,非受保护文件)+ 知识层归档(.local/knowledge);都在最终状态定下之后,失败只记事件不改状态
  manifest.viewer = null;
  manifest.knowledge_archived = null;
  // 任何 scenario(硬测试旋钮:注入冲突 / 证据 / 帖子、超时、钩子故障…)都意味着产物含合成数据 → 绝不归档进知识层(否则伪造证据会被下次召回)
  const isTestScenario = !!cfg.scenario && Object.values(cfg.scenario).some((v) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0));
  manifest.test_scenario = isTestScenario;
  if (cfg.knowledgeArchive) {
    const viewRun = loadRun(cfg.runDir, ledger, planOf);
    try { const v = writeViewer(cfg, viewRun, manifest); manifest.viewer = { html: v.htmlPath, appendix: v.appendixPath }; runner.log("orchestrator", "viewer.written", { html: v.htmlPath, appendix: v.appendixPath }); }
    catch (e) { runner.log("orchestrator", "viewer.failed", { error: e instanceof Error ? e.message : String(e) }); }
    if (stagesToRun.includes("report") && status !== "failed" && !isTestScenario) {
      try { const a = archiveRun(cfg, viewRun, manifest); manifest.knowledge_archived = { latest: a.latestFile, run_file: a.runFile, gate_removed: a.gateRemoved.length }; runner.log("orchestrator", "knowledge.archived", { latest: a.latestFile, gate_removed: a.gateRemoved.length }); }
      catch (e) { runner.log("orchestrator", "knowledge.archive_failed", { error: e instanceof Error ? e.message : String(e) }); }
    } else runner.log("orchestrator", "knowledge.archive_skipped", { reason: isTestScenario ? "测试场景运行(scenario)含合成数据,不归档" : status === "failed" ? "运行 failed 不归档" : "未含 report 阶段" });
  }
  persistManifest();
  if (fs.existsSync(reportPath)) runner.log("orchestrator", "report.ready", { status, report: reportPath, manifest: path.join(cfg.runDir, "manifest.json"), evidence: path.join(cfg.runDir, "evidence.json"), calculations: path.join(cfg.runDir, "calculations.json") });
  runner.log("orchestrator", "research.finished", { run_id: cfg.runId, status, exit_code: manifest.exit_code, final_errors: finalErrors.length });
  runner.log("orchestrator", "run.done", { status, exit_code: manifest.exit_code, evidence: merged.evidence.length, calculations: merged.calcs.length, conflicts: manifest.evidence_conflicts.length });
  console.error(`[orchestrator] done status=${status} exit=${manifest.exit_code} evidence=${merged.evidence.length} calcs=${merged.calcs.length} conflicts=${manifest.evidence_conflicts.length}`);
  return { status, exitCode: manifest.exit_code, manifest };
}
