/**
 * 取数由编排器执行(取数与解释分阶段,AGENTS.md §5):干净最小环境(无 Codex 凭据)、超时、账本。
 * 权威账本保存在编排器内存(Ledger 对象),同时落盘 fetch/_ledger.json 仅供审计;validator 只信内存账本。
 * 每个脚本执行前后快照 raw/ 目录,新增文件的 sha256 记入账本,使 raw/ 同样受认证。支持故障注入(Scenario)。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fetchEnv, type RunConfig, type Scenario } from "./config.ts";
import { fetchArgv } from "./registry.ts";
import { listFiles, nowIso, readJsonIfExists, sha256File, writeJson } from "./fsutil.ts";

export interface LedgerEntry {
  script: string;
  argv: string[];
  exit_code: number | null;
  duration_ms: number;
  status: "ok" | "partial" | "failed" | "timeout" | "error";
  file: string | null;
  sha256: string | null;
  /** 本次执行新增的 raw 文件 → sha256 */
  raw_files: Record<string, string>;
  started_at: string;
  finished_at: string;
  injected?: string;
  stage: string;
}

export type Ledger = Record<string, LedgerEntry>;

export const LEDGER_REL = path.join("fetch", "_ledger.json");

/** 只用于审计 / --no-agent 复核已有目录;正式运行中 validator 使用编排器内存账本 */
export function loadLedgerFromDisk(runDir: string): Ledger {
  return readJsonIfExists<Ledger>(path.join(runDir, LEDGER_REL)) ?? {};
}

export function saveLedger(runDir: string, ledger: Ledger): void {
  writeJson(path.join(runDir, LEDGER_REL), ledger);
}

export interface FetchExecutor {
  (cfg: RunConfig, stage: string, scripts: string[], log: (type: string, payload: Record<string, unknown>) => void, ledger: Ledger): Ledger;
}

function failedEnvelope(cfg: RunConfig, script: string, reason: string, injected?: string) {
  return { script, symbol: cfg.symbol, market: cfg.market || "", status: "failed", fetched_at: nowIso(), primary_source: null,
    used_sources: [], evidence: [], extra: { degraded: reason, injected: injected ?? null }, errors: [{ source: "orchestrator", endpoint: script, error: reason, at: nowIso() }], missing: [] };
}

function rawSnapshot(runDir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of listFiles(path.join(runDir, "raw"))) if (!fs.lstatSync(f).isSymbolicLink()) m.set(path.basename(f), sha256File(f));
  return m;
}

function newRawFiles(before: Map<string, string>, after: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of after) if (!before.has(k)) out[k] = v;
  return out;
}

/** 顺序执行脚本(内存账本里已执行过的不重复);返回(并就地更新)账本。 */
export const runFetchScripts: FetchExecutor = (cfg, stage, scripts, log, ledger) => {
  const scenario: Scenario = cfg.scenario ?? {};
  for (const script of scripts) {
    if (ledger[script]) continue; // 本次运行已由编排器执行
    const file = path.join(cfg.runDir, "fetch", `${script}.json`);
    const argv = fetchArgv(cfg.endpoints?.[script], script, { scriptsDir: path.join(cfg.repoRoot, cfg.scriptsRel), symbol: cfg.symbol, runDir: cfg.runDir });
    const started = nowIso();
    const t0 = Date.now();
    const before = rawSnapshot(cfg.runDir);
    let entry: LedgerEntry;
    if (scenario.fail_scripts?.includes(script)) {
      writeJson(file, failedEnvelope(cfg, script, "注入:端点不可用", "fail"));
      entry = { script, argv: [], exit_code: 3, duration_ms: 0, status: "failed", file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), injected: "fail_scripts", stage };
    } else {
      // 超时注入:确定性——换成一个必然睡过时限的 fixture 进程(不跑真脚本,不依赖调度竞态),仍走真实的 spawn 超时路径
      const injectTimeout = scenario.timeout_scripts?.includes(script) ?? false;
      const timeout = injectTimeout ? 300 : cfg.fetchTimeoutMs;
      const realArgv = injectTimeout ? ["-c", "import time; time.sleep(30)"] : argv;
      const p = spawnSync(cfg.python, realArgv, { cwd: cfg.repoRoot, env: fetchEnv(), encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
      const dur = Date.now() - t0;
      const injected = scenario.timeout_scripts?.includes(script) ? "timeout_scripts" : undefined;
      if (p.error && (p.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        writeJson(file, failedEnvelope(cfg, script, `脚本超时(${timeout} ms)`, injected));
        entry = { script, argv, exit_code: null, duration_ms: dur, status: "timeout", file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), stage, ...(injected ? { injected } : {}) };
      } else if (p.error) {
        writeJson(file, failedEnvelope(cfg, script, `脚本无法启动:${p.error.message}`));
        entry = { script, argv, exit_code: null, duration_ms: dur, status: "error", file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), stage };
      } else {
        if (!fs.existsSync(file)) writeJson(file, failedEnvelope(cfg, script, `脚本退出码 ${p.status} 且未落盘:${(p.stderr || "").slice(-300)}`));
        const st = p.status === 0 ? "ok" : p.status === 2 ? "partial" : "failed";
        entry = { script, argv, exit_code: p.status, duration_ms: dur, status: st, file: `fetch/${script}.json`, sha256: sha256File(file), raw_files: {}, started_at: started, finished_at: nowIso(), stage };
      }
    }
    entry.raw_files = newRawFiles(before, rawSnapshot(cfg.runDir));
    ledger[script] = entry;
    log("fetch.executed", { script, status: entry.status, exit_code: entry.exit_code, duration_ms: entry.duration_ms, sha256: entry.sha256, raw_files: Object.keys(entry.raw_files).length, injected: entry.injected ?? null });
  }
  // 动态冲突注入:在已取到的真实证据里找该 field 的最新一条,克隆其完整事实键(symbol/market/field/period/unit/adjustment/record_key),只改 id / source / value
  if (scenario.inject_conflict && !ledger["fetch_injected"]) {
    const { field, factor } = scenario.inject_conflict;
    const candidates: Record<string, unknown>[] = [];
    for (const f of listFiles(path.join(cfg.runDir, "fetch"), ".json")) {
      if (path.basename(f).startsWith("_")) continue;
      const env = readJsonIfExists<{ evidence?: Record<string, unknown>[] }>(f);
      for (const e of env?.evidence ?? []) if (e.field === field && typeof e.value === "number") candidates.push(e);
    }
    candidates.sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const base = candidates[0];
    if (base) {
      const clone = { ...base, id: `ev-${crypto.createHash("sha256").update(`injected|${String(base.id)}`).digest("hex").slice(0, 12)}`, source: "injected", endpoint: "hardtest.inject_conflict", value: Number((Number(base.value) * factor).toFixed(2)), raw_ref: null, note: `硬测试注入:克隆 ${String(base.id)} 的事实键,值 ×${factor}` };
      const file = path.join(cfg.runDir, "fetch", "fetch_injected.json");
      writeJson(file, { script: "fetch_injected", symbol: cfg.symbol, market: cfg.market || "", status: "ok", fetched_at: nowIso(), primary_source: "injected", used_sources: ["injected"], evidence: [clone], extra: { injected: "inject_conflict", base_id: base.id }, errors: [], missing: [] });
      ledger["fetch_injected"] = { script: "fetch_injected", argv: [], exit_code: 0, duration_ms: 0, status: "ok", file: "fetch/fetch_injected.json", sha256: sha256File(file), raw_files: {}, started_at: nowIso(), finished_at: nowIso(), injected: "inject_conflict", stage };
      log("fetch.injected", { kind: "inject_conflict", field, base_id: base.id, injected_id: clone.id });
    } else {
      log("fetch.inject_skipped", { kind: "inject_conflict", field, reason: "本阶段尚无该 field 的真实证据,待后续阶段" });
    }
  }
  if (scenario.inject_evidence?.length && !ledger["fetch_injected"]) {
    const file = path.join(cfg.runDir, "fetch", "fetch_injected.json");
    writeJson(file, { script: "fetch_injected", symbol: cfg.symbol, market: cfg.market || "", status: "ok", fetched_at: nowIso(), primary_source: "injected",
      used_sources: ["injected"], evidence: scenario.inject_evidence, extra: { injected: "inject_evidence" }, errors: [], missing: [] });
    ledger["fetch_injected"] = { script: "fetch_injected", argv: [], exit_code: 0, duration_ms: 0, status: "ok", file: "fetch/fetch_injected.json", sha256: sha256File(file), raw_files: {}, started_at: nowIso(), finished_at: nowIso(), injected: "inject_evidence", stage };
    log("fetch.injected", { count: scenario.inject_evidence.length });
  }
  saveLedger(cfg.runDir, ledger);
  return ledger;
};

/** 账本摘要(写入 manifest) */
export function ledgerSummary(ledger: Ledger): Record<string, { status: string; exit_code: number | null; sha256: string | null; raw_files: number; injected?: string }> {
  const out: Record<string, { status: string; exit_code: number | null; sha256: string | null; raw_files: number; injected?: string }> = {};
  for (const [k, v] of Object.entries(ledger)) out[k] = { status: v.status, exit_code: v.exit_code, sha256: v.sha256, raw_files: Object.keys(v.raw_files ?? {}).length, ...(v.injected ? { injected: v.injected } : {}) };
  return out;
}
