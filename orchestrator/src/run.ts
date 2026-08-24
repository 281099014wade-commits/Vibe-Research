#!/usr/bin/env node
/**
 * 薄编排器 CLI 入口。
 * 用法:node orchestrator/src/run.ts --symbol 300308 [--run-id X] [--python /path/python] [--model m] [--reasoning medium]
 *      [--max-retries 2] [--gate-retries 2] [--turn-timeout-min 20] [--stages profile,financials] [--no-agent] [--overwrite]
 *      [--scenario scenario.json](故障注入:fail_scripts / timeout_scripts / inject_evidence / knowledge / induce_text)
 *      [--config <用户配置.json>] [--codex-path <引擎二进制>] [--codex-home <目录>](默认读 vibe-research.config.json + .local/config.json + 环境变量 VRA_*)
 *      [--no-hooks](不安装 Stop / PreToolUse 钩子;默认安装到产品 CODEX_HOME)
 *      [--endpoints full|core](full = 注册表全部启用端点(默认);core = 仅 Phase 0 的 8 个 legacy 脚本)
 *      [--knowledge on|off](默认 on:召回 .local/knowledge 里该主体的档案注入提示词)[--no-archive](不生成 viewer / 附录、不归档知识层)
 *      [--progress on|off](默认 on:把阶段进度与各阶段 summary 实时打到 **stderr**,首次可读产出 ~80 秒;stdout 的 JSON 契约不变)
 *      [--seed-from <夹具目录>] [--allow-stale-fixture](**仅硬测试用**:播种前几个阶段的产物并跳过它们,省约一半墙钟;播种运行按测试运行隔离,不进知识层,不能替代发布前的完整运行)
 *      [--provider <id>](providers/<id>.json;默认 openai;非 openai 只能 api_key,未显式指定 auth 时自动选模板唯一支持的模式;也可用环境变量 VRA_PROVIDER)
 *      [--auth api_key|chatgpt_login](显式指定认证方式,优先级最高;也可用环境变量 VRA_PROVIDER_AUTH)
 * 退出码:0 complete / 2 incomplete|stale / 3 failed 或编排异常。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeConfig, type RunConfig, type Scenario, type Stage } from "./config.ts";
import { runFetchScripts } from "./fetchrun.ts";
import { ProgressReporter } from "./progress.ts";
import { runResearch } from "./orchestrate.ts";
import { loadProductConfig } from "./productConfig.ts";
import { CodexRunner, sdkCodexVersion } from "./runner.ts";
import { isStage } from "./schemas.ts";
import { verifyCalcs } from "./validator.ts";


// **composition root**:垂类包在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
import "./finance/register.ts";
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** 配置优先级:内置默认 ← 产品配置文件 ← 用户配置文件 ← 环境变量 ← CLI 参数 */
function parseScope(v: string | undefined): "core" | "full" {
  if (v === undefined || v === "full") return "full";
  if (v === "core") return "core";
  throw new Error(`--endpoints 只能是 full 或 core,收到 ${v}`);
}

export function configFromArgs(args: Record<string, string | boolean>, env: NodeJS.ProcessEnv = process.env): { cfg: RunConfig; stages?: Stage[]; sources: string[]; progress: boolean } {
  if (!str(args.symbol)) throw new Error("缺少 --symbol");
  let scenario: Scenario | null = null;
  if (str(args.scenario)) scenario = JSON.parse(fs.readFileSync(str(args.scenario)!, "utf8")) as Scenario;
  const repoRoot = str(args["repo-root"]) ?? repoRootFromHere();
  const pc = loadProductConfig(repoRoot, { userConfigPath: str(args.config), env, providerOverride: str(args.provider), authOverride: str(args.auth) });
  const d = pc.defaults;
  const cfg = makeConfig({
    symbol: str(args.symbol)!,
    market: str(args.market) ?? "",
    repoRoot,
    dataRoot: pc.resolved.dataRoot,
    runId: str(args["run-id"]),
    python: str(args.python) ?? pc.python ?? undefined,
    codexPath: str(args["codex-path"]) ?? pc.resolved.codexPath,
    codexHome: str(args["codex-home"]) ?? pc.resolved.codexHome,
    provider: pc.provider,
    providerProfile: pc.providerProfile,
    scriptsRel: pc.resolved.scriptsRel,
    calcCliRel: pc.paths.calc_cli,
    constitutionPath: pc.resolved.constitution,
    model: str(args.model) ?? d.model ?? undefined,
    reasoning: str(args.reasoning) ?? d.reasoning ?? undefined,
    maxRetries: str(args["max-retries"]) !== undefined ? Number(args["max-retries"]) : d.max_retries,
    gateRetries: str(args["gate-retries"]) !== undefined ? Number(args["gate-retries"]) : d.gate_retries,
    turnTimeoutMs: str(args["turn-timeout-min"]) !== undefined ? Number(args["turn-timeout-min"]) * 60_000 : d.turn_timeout_min * 60_000,
    fetchTimeoutMs: d.fetch_timeout_sec * 1000,
    noAgent: args["no-agent"] === true,
    hooksEnabled: args["no-hooks"] !== true,
    overwrite: args.overwrite === true,
    scenario,
    endpointScope: parseScope(str(args.endpoints)),
    knowledgeRecall: str(args.knowledge) === undefined ? true : str(args.knowledge) === "on",
    knowledgeArchive: args["no-archive"] !== true,
    seedFrom: str(args["seed-from"]),
    allowStaleFixture: args["allow-stale-fixture"] === true,
  });
  let stages: Stage[] | undefined;
  if (str(args.stages)) {
    stages = str(args.stages)!.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { if (!isStage(s)) throw new Error(`未知阶段 ${s}`); return s; });
  }
  return { cfg, stages, sources: pc.sources, progress: str(args.progress) !== "off" };
}

async function main(): Promise<number> {
  let cfg: RunConfig, stages: Stage[] | undefined, sources: string[], progress: boolean;
  try { ({ cfg, stages, sources, progress } = configFromArgs(parseArgs(process.argv.slice(2)))); }
  catch (e) { console.error(`参数 / 配置错误:${e instanceof Error ? e.message : String(e)}`); return 3; }
  console.error(`[orchestrator] run ${cfg.runId} → ${cfg.runDir}\n[orchestrator] config sources: ${sources.join(" ← ")}; CODEX_HOME=${cfg.codexHome}; engine=${cfg.codexPath ?? "sdk-bundled"}; provider=${cfg.provider.name}/${cfg.provider.auth}`);
  // 进度只写 stderr:六阶段要跑十几分钟,没有它用户全程看不到任何内容(见 progress.ts 顶部)。
  // **连构造也要保护**:显示层任何环节出问题都只是"没有进度显示",绝不能让一次真实研究起不来(Codex progress-r1 P2)。
  let reporter: ProgressReporter | null = null;
  if (progress) {
    try { reporter = new ProgressReporter({ runDir: cfg.runDir }); }
    catch (e) { console.error(`[orchestrator] 进度显示未启用(不影响研究):${e instanceof Error ? e.message : String(e)}`); }
  }
  const runner = new CodexRunner(cfg, path.join(cfg.runDir, "events.jsonl"), undefined, reporter ? (ev) => reporter.onEvent(ev) : undefined);
  const res = await runResearch(cfg, { runner, fetchRunner: runFetchScripts, verify: verifyCalcs, sdkVersion: () => sdkCodexVersion(cfg.codexPath) }, stages);
  console.log(JSON.stringify({ run_id: cfg.runId, run_dir: cfg.runDir, status: res.status, exit_code: res.exitCode,
    stages: res.manifest.stages.map((s) => ({ stage: s.stage, status: s.status, attempts: s.attempts, validator_ok: s.validator_ok })) }, null, 2));
  return res.exitCode;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(3); });
}
