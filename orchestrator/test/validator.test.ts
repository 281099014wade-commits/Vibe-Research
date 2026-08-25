import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { makeConfig } from "../src/config.ts";
import { checkAgentTrace, deriveQuoteDecision, deriveStageStatus, loadRun, validateFetchIntegrity, validateStage } from "../src/validator.ts";
import { detectSourceConflicts, mergeEvidence, rawHashes } from "../src/merge.ts";
import { sha256File, writeJson } from "../src/fsutil.ts";
import { validateCalcRecord, validateEvidenceItem, validateFetchEnvelope, validateStageOutput } from "../src/schemas.ts";
import { loadLedgerFromDisk, saveLedger } from "../src/fetchrun.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
function tmpRun(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run-"));
  for (const s of ["raw", "fetch", "calcs", "stages"]) fs.mkdirSync(path.join(d, s), { recursive: true });
  return d;
}

const TS = "2026-08-21T10:00:00+08:00";
function ev(id: string, field: string, value: unknown, extra: Record<string, unknown> = {}) {
  return { id, symbol: "300308", market: "SZ", field, value, unit: "元", currency: "CNY", period: "2026-08-21", as_of: "2026-08-21",
    source: "tencent", endpoint: "qt", fetched_at: TS, adjustment: "none", raw_ref: "raw/fake.json", ...extra };
}
function envelope(script: string, status: "ok" | "partial" | "failed", evidence: unknown[], extra: Record<string, unknown> = {}) {
  return { script, symbol: "300308", market: "SZ", status, fetched_at: TS, primary_source: "tencent", used_sources: ["tencent"], evidence, extra, errors: [], missing: [] };
}
/** 写 fetch 文件并登记账本(模拟编排器执行) */
function putFetch(d: string, script: string, status: "ok" | "partial" | "failed", evidence: unknown[], extra: Record<string, unknown> = {}) {
  const f = path.join(d, "fetch", `${script}.json`);
  writeJson(f, envelope(script, status, evidence, extra));
  const ledger = loadLedgerFromDisk(d);
  // 假 raw:raw/fake.json 由第一个登记它的脚本"取得"(每条证据必有 raw_ref 规则)
  const rawP = path.join(d, "raw", "fake.json");
  const first = !fs.existsSync(rawP);
  if (first) { fs.mkdirSync(path.dirname(rawP), { recursive: true }); fs.writeFileSync(rawP, "{}"); }
  ledger[script] = { script, argv: [], exit_code: status === "ok" ? 0 : status === "partial" ? 2 : 3, duration_ms: 1, status, file: `fetch/${script}.json`, sha256: sha256File(f), raw_files: first ? { "fake.json": sha256File(rawP) } : {}, started_at: TS, finished_at: TS, stage: "x" };
  saveLedger(d, ledger);
}
const CALC_ID = "calc-0123456789abcdef";
const CALC_ID2 = "calc-fedcba9876543210";
function calc(fn: string, refs: { ref_type: "evidence" | "calculation"; ref_id: string }[], id = CALC_ID, status: "ok" | "not_meaningful" = "ok") {
  return { calculation_id: id, function: fn, calc_version: "0.2.0", inputs: { a: 1 }, inputs_resolved: {}, inputs_refs: refs,
    output: { status, value: status === "ok" ? 1.5 : null, unit: "倍", reason: "", details: {} } };
}
const gap = (operation: string, reason_code = "source_failed") => ({ operation, reason_code, detail: "x" });

test("schema:evidence / fetch / calc / 阶段产物(additionalProperties 关闭)", () => {
  assert.deepEqual(validateEvidenceItem(ev("ev-aaaaaa", "price", 943)), []);
  assert.ok(validateEvidenceItem({ ...ev("ev-aaaaaa", "price", 943), market: "XX" }).length > 0); // Phase 1 起 US / HK 为合法市场
  assert.equal(validateEvidenceItem({ ...ev("ev-aaaaaa", "price", 943), market: "US", symbol: "AAPL" }).length, 0);
  assert.ok(validateEvidenceItem({ ...ev("ev-aaaaaa", "price", 943), extra_field: 1 }).length > 0);
  assert.ok(validateEvidenceItem({ ...ev("ev-aaaaaa", "price", 943), as_of: "2026/08/21" }).length > 0);
  assert.deepEqual(validateFetchEnvelope(envelope("fetch_quote", "ok", [ev("ev-aaaaaa", "price", 943)])), []);
  assert.deepEqual(validateCalcRecord(calc("peg", [{ ref_type: "evidence", ref_id: "ev-aaaaaa" }])), []);
  assert.ok(validateCalcRecord({ ...calc("peg", []), calculation_id: "calc-short" }).length > 0);
  assert.ok(validateStageOutput("profile", { stage: "profile", status: "complete", summary: "s", evidence_ids: [], calculation_ids: [], gaps: [{ what: "x" }] }).length > 0);
  assert.deepEqual(validateStageOutput("profile", { stage: "profile", status: "complete", summary: "s", evidence_ids: [], calculation_ids: [], gaps: [gap("fetch_profile")], quote_decision: "normal", quote_decision_reason: "r", moat_tag: "待补" }), []);
});

test("取数完整性:无账本 / sha 不符 / raw_ref 越界 / market-symbol 联动", () => {
  const d = tmpRun();
  writeJson(path.join(d, "fetch", "fetch_quote.json"), envelope("fetch_quote", "ok", [ev("ev-aaaaa2", "price", 943)]));
  let r = validateFetchIntegrity(loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("没有编排器账本记录")));
  putFetch(d, "fetch_quote", "ok", [ev("ev-aaaaa2", "price", 943)]);
  assert.deepEqual(validateFetchIntegrity(loadRun(d)).errors, []);
  fs.writeFileSync(path.join(d, "fetch", "fetch_quote.json"), JSON.stringify(envelope("fetch_quote", "ok", [ev("ev-aaaaa2", "price", 1)])));
  r = validateFetchIntegrity(loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("sha256 不一致")));
  putFetch(d, "fetch_x", "ok", [ev("ev-aaaaa3", "f", 1, { raw_ref: "../outside.txt" }), ev("ev-aaaaa4", "g", 1, { raw_ref: "raw/missing.json" }), ev("ev-aaaaa5", "h", 1, { market: "CN" })]);
  r = validateFetchIntegrity(loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("越出 raw/")));
  assert.ok(r.errors.some((e) => e.includes("raw_ref 文件不存在")));
  assert.ok(r.errors.some((e) => e.includes("market/symbol 不匹配")));
});

function profileRun(d: string, quoteExtra: Record<string, unknown>, calExtra: Record<string, unknown>, klineExtra?: Record<string, unknown>) {
  putFetch(d, "fetch_profile", "ok", [ev("ev-aaaaa1", "total_market_cap", 11030)]);
  putFetch(d, "fetch_quote", quoteExtra.is_stale === true || quoteExtra.is_stale === "unknown" ? "partial" : "ok", [ev("ev-aaaaa2", "price", 943)], quoteExtra);
  putFetch(d, "fetch_trade_calendar", "ok", [ev("ev-aaaaa3", "last_trading_day", "2026-08-21", { market: "CN", symbol: "MARKET", currency: "n/a", adjustment: "not_applicable" })], calExtra);
  if (klineExtra) putFetch(d, "fetch_kline", "ok", [], klineExtra);
}

test("确定性报价判定:normal / pre_open / stale / 未来日期 / unknown 二次验证", () => {
  const cal = { session_phase: "non_trading_day", reference_quote_day: "2026-08-21", last_trading_day: "2026-08-21" };
  let d = tmpRun(); profileRun(d, { is_stale: false, quote_date: "2026-08-21" }, cal);
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "normal");
  d = tmpRun(); profileRun(d, { is_stale: true, quote_date: "2026-08-21" }, cal);
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "stale");
  d = tmpRun(); profileRun(d, { is_stale: true, quote_date: "2026-08-21" }, { session_phase: "pre_open", reference_quote_day: "2026-08-21", last_trading_day: "2026-08-22" });
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "pre_open");
  d = tmpRun(); profileRun(d, { is_stale: true, quote_date: "2026-08-22" }, { session_phase: "pre_open", reference_quote_day: "2026-08-21", last_trading_day: "2026-08-22" });
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "pre_open"); // 集合竞价已切到当日
  d = tmpRun(); profileRun(d, { is_stale: false, quote_date: "2026-08-19" }, cal);
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "stale");
  d = tmpRun(); profileRun(d, { is_stale: false, quote_date: "2026-08-25" }, cal);
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "stale");
  d = tmpRun(); profileRun(d, { is_stale: "unknown", quote_date: "2026-08-21" }, cal, { end: "2026-08-21" });
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "normal");
  d = tmpRun(); profileRun(d, { is_stale: "unknown", quote_date: "2026-08-21" }, cal);
  assert.equal(deriveQuoteDecision(loadRun(d)).decision, "unknown_unverified");
});

test("profile 阶段:缺账本 / 缺阶段文件 → 不过;quote_decision 与推导不符 → 不过;齐全 → 过", () => {
  const d = tmpRun();
  let r = validateStage("profile", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("fetch_profile 未被编排器执行")));
  profileRun(d, { is_stale: true, quote_date: "2026-08-21" }, { session_phase: "non_trading_day", reference_quote_day: "2026-08-21", last_trading_day: "2026-08-21" });
  r = validateStage("profile", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("stages/profile.json")));
  writeJson(path.join(d, "stages", "profile.json"), { stage: "profile", status: "complete", summary: "ok", evidence_ids: ["ev-aaaaa1", "ev-aaaaa2"], calculation_ids: [], gaps: [], quote_decision: "normal", quote_decision_reason: "x", moat_tag: "待补" });
  r = validateStage("profile", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("quote_decision 应为 stale")));
  writeJson(path.join(d, "stages", "profile.json"), { stage: "profile", status: "complete", summary: "ok", evidence_ids: ["ev-aaaaa1", "ev-aaaaa2"], calculation_ids: [], gaps: [], quote_decision: "stale", quote_decision_reason: "x", moat_tag: "待补" });
  r = validateStage("profile", loadRun(d));
  assert.deepEqual(r.errors, []);
});

test("financials 阶段:必需 calc 以 calculation_ids + operation 精确匹配;自由文本不放行;无 inputs_refs 不过", () => {
  const d = tmpRun();
  putFetch(d, "fetch_financials", "ok", [ev("ev-bbbbb1", "net_profit_deducted_cum", 1e9)]);
  writeJson(path.join(d, "stages", "financials.json"), { stage: "financials", status: "complete", summary: "ok", evidence_ids: ["ev-bbbbb1"], calculation_ids: [], gaps: [] });
  let r = validateStage("financials", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("缺少 calc quarterize")));
  writeJson(path.join(d, "calcs", "01_quarterize.json"), calc("quarterize", [{ ref_type: "evidence", ref_id: "ev-bbbbb1" }]));
  r = validateStage("financials", loadRun(d)); // calc 存在但未列入 calculation_ids → 仍不过
  assert.ok(r.errors.some((e) => e.includes("缺少 calc quarterize")));
  writeJson(path.join(d, "stages", "financials.json"), { stage: "financials", status: "incomplete", summary: "ok", evidence_ids: ["ev-bbbbb1"], calculation_ids: [CALC_ID],
    gaps: [gap("latest_quarter", "insufficient_periods"), gap("ttm_sum", "insufficient_periods"), gap("ttm_yoy", "insufficient_periods"), gap("qoq", "insufficient_periods")] });
  r = validateStage("financials", loadRun(d)); // 槽位:营收 / 归母的 quarterize 既没做也没写 gaps → 不过
  assert.ok(r.errors.some((e) => e.includes("缺少对 revenue_cum 的 quarterize")));
  writeJson(path.join(d, "stages", "financials.json"), { stage: "financials", status: "incomplete", summary: "ok", evidence_ids: ["ev-bbbbb1"], calculation_ids: [CALC_ID],
    gaps: [gap("latest_quarter", "insufficient_periods"), gap("ttm_sum", "insufficient_periods"), gap("ttm_yoy", "insufficient_periods"), gap("qoq", "insufficient_periods"),
      gap("quarterize:revenue_cum", "source_partial"), gap("quarterize:net_profit_parent_cum", "source_partial")] });
  r = validateStage("financials", loadRun(d));
  assert.deepEqual(r.errors, []);
  writeJson(path.join(d, "calcs", "03_bad.json"), { ...calc("ttm_yoy", []), calculation_id: CALC_ID2 });
  r = validateStage("financials", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("没有 inputs_refs")));
});

test("必需取数 failed:合法缺口但阶段不得 complete,且 gaps 需 operation=脚本名", () => {
  const d = tmpRun();
  putFetch(d, "fetch_estimates", "failed", []);
  writeJson(path.join(d, "stages", "estimates.json"), { stage: "estimates", status: "complete", summary: "ok", evidence_ids: [], calculation_ids: [], gaps: [gap("forward_cagr"), gap("consensus_dispersion")] });
  let r = validateStage("estimates", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("不得标 complete")));
  assert.ok(r.errors.some((e) => e.includes("operation=fetch_estimates")));
  writeJson(path.join(d, "stages", "estimates.json"), { stage: "estimates", status: "incomplete", summary: "ok", evidence_ids: [], calculation_ids: [], gaps: [gap("fetch_estimates"), gap("forward_cagr"), gap("consensus_dispersion")] });
  r = validateStage("estimates", loadRun(d));
  assert.deepEqual(r.errors, []);
  assert.equal(deriveStageStatus("estimates", true, false, loadRun(d)), "incomplete");
  assert.equal(deriveStageStatus("estimates", false, false, loadRun(d)), "failed");
});

test("语义槽位:quarterize 引用多字段 → 不过;PE 实参与所引用市值证据不一致 / 单位不一致 → 不过;上游缺引用 → 不过", () => {
  const d = tmpRun();
  putFetch(d, "fetch_financials", "ok", [ev("ev-bbbbb1", "net_profit_deducted_cum", 1e9), ev("ev-bbbbb2", "revenue_cum", 5e9), ev("ev-bbbbb3", "net_profit_parent_cum", 1.1e9)]);
  writeJson(path.join(d, "calcs", "01_q.json"), calc("quarterize", [{ ref_type: "evidence", ref_id: "ev-bbbbb1" }, { ref_type: "evidence", ref_id: "ev-bbbbb2" }]));
  writeJson(path.join(d, "stages", "financials.json"), { stage: "financials", status: "incomplete", summary: "ok", evidence_ids: [], calculation_ids: [CALC_ID],
    gaps: ["latest_quarter", "ttm_sum", "ttm_yoy", "qoq", "quarterize:net_profit_parent_cum"].map((o) => gap(o, "insufficient_periods")) });
  let r = validateStage("financials", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("引用的证据字段不唯一")));
  // valuation:pe_deducted_annualized 实参市值 ≠ 引用证据值
  const d2 = tmpRun();
  putFetch(d2, "fetch_quote", "ok", [ev("ev-cccc01", "total_market_cap", 1.2e12), ev("ev-cccc02", "price", 900), ev("ev-cccc03", "pe_ttm", 50), ev("ev-cccc09", "net_profit_deducted_cum", 1e9, { period: "2026Q2" })]);
  const qz = { ...calc("quarterize", [{ ref_type: "evidence", ref_id: "ev-cccc09" }]), calculation_id: "calc-00000000000000c9" };
  const lq = { ...calc("latest_quarter", [{ ref_type: "calculation", ref_id: qz.calculation_id }]), calculation_id: CALC_ID2, output: { status: "ok", value: 1, unit: "元", reason: "", details: {} } };
  writeJson(path.join(d2, "calcs", "00_qz.json"), qz);
  writeJson(path.join(d2, "calcs", "01_lq.json"), lq);
  const pe = { ...calc("pe_deducted_annualized", [{ ref_type: "evidence", ref_id: "ev-cccc01" }, { ref_type: "calculation", ref_id: CALC_ID2 }]), inputs: { total_market_cap: 9.9e11, cap_unit: "元", latest_quarter_deducted_profit: 1, profit_unit: "元" } };
  writeJson(path.join(d2, "calcs", "02_pe.json"), pe);
  const cols = { pe_deducted_x4: CALC_ID, forward_pe: "未获取:x", pe_ttm_percentile: "未获取:x", peg: "未获取:x", forward_cagr: "未获取:x", ttm_yoy: "未获取:x", qoq: "未获取:x" };
  const gaps = ["forward_pe", "pe_ttm_from_parts", "percentile_rank", "peg", "pe_digestion_scenarios", "forward_vs_ttm_judgement"].map((o) => gap(o, "upstream_missing"));
  writeJson(path.join(d2, "stages", "valuation.json"), { stage: "valuation", status: "incomplete", summary: "ok", evidence_ids: [], calculation_ids: [CALC_ID], gaps, standard_columns: cols });
  r = validateStage("valuation", loadRun(d2));
  assert.ok(r.errors.some((e) => e.includes("实参 total_market_cap") && e.includes("不一致")), r.errors.join("\n"));
  writeJson(path.join(d2, "calcs", "02_pe.json"), { ...pe, inputs: { ...pe.inputs, total_market_cap: 1.2e12, cap_unit: "亿元" } });
  r = validateStage("valuation", loadRun(d2));
  assert.ok(r.errors.some((e) => e.includes("单位参数 cap_unit")), r.errors.join("\n"));
  writeJson(path.join(d2, "calcs", "02_pe.json"), { ...pe, inputs: { ...pe.inputs, total_market_cap: 1.2e12, cap_unit: "元" }, inputs_refs: [{ ref_type: "evidence", ref_id: "ev-cccc01" }] });
  r = validateStage("valuation", loadRun(d2));
  assert.ok(r.errors.some((e) => e.includes("没有引用上游 latest_quarter")), r.errors.join("\n"));
  writeJson(path.join(d2, "calcs", "02_pe.json"), { ...pe, inputs: { ...pe.inputs, total_market_cap: 1.2e12, cap_unit: "元" } });
  r = validateStage("valuation", loadRun(d2));
  assert.deepEqual(r.errors.filter((e) => e.includes("pe_deducted_annualized")), []);
});

test("语义槽位 v2:口径角色 / 财年 / 上游输出值绑定", () => {
  const d = tmpRun();
  putFetch(d, "fetch_financials", "ok", [ev("ev-bbbbb1", "net_profit_deducted_cum", 1e9, { period: "2026Q2" }), ev("ev-bbbbb2", "revenue_cum", 5e9, { period: "2026Q2" }), ev("ev-bbbbb3", "net_profit_parent_cum", 1.1e9, { period: "2026Q2" })]);
  const q1 = { ...calc("quarterize", [{ ref_type: "evidence", ref_id: "ev-bbbbb1" }]), calculation_id: "calc-0000000000000001" };
  const q2 = { ...calc("quarterize", [{ ref_type: "evidence", ref_id: "ev-bbbbb2" }]), calculation_id: "calc-0000000000000002" };
  const q3 = { ...calc("quarterize", [{ ref_type: "evidence", ref_id: "ev-bbbbb3" }]), calculation_id: "calc-0000000000000003" };
  // latest_quarter 基于营收(错口径)→ 缺扣非的 latest_quarter
  const lq = { ...calc("latest_quarter", [{ ref_type: "calculation", ref_id: "calc-0000000000000002" }]), calculation_id: "calc-0000000000000004", output: { status: "ok", value: 2.5e8, unit: "元", reason: "", details: {} } };
  for (const [n, c] of [["01", q1], ["02", q2], ["03", q3], ["04", lq]] as const) writeJson(path.join(d, "calcs", `${n}.json`), c);
  writeJson(path.join(d, "stages", "financials.json"), { stage: "financials", status: "incomplete", summary: "ok", evidence_ids: [], calculation_ids: [q1.calculation_id, q2.calculation_id, q3.calculation_id, lq.calculation_id],
    gaps: ["ttm_sum", "ttm_yoy", "qoq"].map((o) => gap(o, "insufficient_periods")) });
  let r = validateStage("financials", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("缺少基于 net_profit_deducted_cum 的 latest_quarter")), r.errors.join("\n"));
  // 改为扣非 → 过
  writeJson(path.join(d, "calcs", "04.json"), { ...lq, inputs_refs: [{ ref_type: "calculation", ref_id: "calc-0000000000000001" }] });
  r = validateStage("financials", loadRun(d));
  assert.deepEqual(r.errors, []);
  // estimates:forward_cagr 财年对调 / years≠2;dispersion 不同财年
  const d2 = tmpRun();
  putFetch(d2, "fetch_estimates", "ok", [ev("ev-eeee26", "eps_consensus_mean", 10, { period: "FY2026" }), ev("ev-eeee28", "eps_consensus_mean", 20, { period: "FY2028" }),
    ev("ev-eeee27", "eps_consensus_mean", 15, { period: "FY2027" }), ev("ev-eeeemn", "eps_consensus_min", 5, { period: "FY2028" }), ev("ev-eeeemx", "eps_consensus_max", 30, { period: "FY2028" }), ev("ev-eeeem7", "eps_consensus_min", 7, { period: "FY2027" })], { current_fy: "FY2026" });
  const cg = { ...calc("forward_cagr", [{ ref_type: "evidence", ref_id: "ev-eeee26" }, { ref_type: "evidence", ref_id: "ev-eeee28" }]), inputs: { eps_t: 20, eps_t_plus_n: 10, years: 2 } };
  const dp = { ...calc("consensus_dispersion", [{ ref_type: "evidence", ref_id: "ev-eeeem7" }, { ref_type: "evidence", ref_id: "ev-eeee28" }, { ref_type: "evidence", ref_id: "ev-eeeemx" }]), calculation_id: CALC_ID2, inputs: { low: 7, mean: 20, high: 30 } };
  writeJson(path.join(d2, "calcs", "10.json"), cg); writeJson(path.join(d2, "calcs", "11.json"), dp);
  writeJson(path.join(d2, "stages", "estimates.json"), { stage: "estimates", status: "complete", summary: "ok", evidence_ids: [], calculation_ids: [CALC_ID, CALC_ID2], gaps: [] });
  r = validateStage("estimates", loadRun(d2));
  assert.ok(r.errors.some((e) => e.includes("eps_t=20") && e.includes("FY2026")), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => e.includes("必须引用 FY2028 的 eps_consensus_min")), r.errors.join("\n"));
  writeJson(path.join(d2, "calcs", "10.json"), { ...cg, inputs: { eps_t: 10, eps_t_plus_n: 15, years: 1 }, inputs_refs: [{ ref_type: "evidence", ref_id: "ev-eeee26" }, { ref_type: "evidence", ref_id: "ev-eeee27" }] });
  r = validateStage("estimates", loadRun(d2));
  assert.ok(r.errors.some((e) => e.includes("实参 years 必须为 2")), r.errors.join("\n"));
  // valuation:peg 实参 ≠ 上游 output
  const d3 = tmpRun();
  putFetch(d3, "fetch_quote", "ok", [ev("ev-cccc01", "total_market_cap", 1.2e12)]);
  const pe = { ...calc("pe_deducted_annualized", []), calculation_id: "calc-00000000000000aa", output: { status: "ok", value: 37.4, unit: "倍", reason: "", details: {} } };
  const cagr = { ...calc("forward_cagr", []), calculation_id: "calc-00000000000000bb", output: { status: "ok", value: 0.59, unit: "小数", reason: "", details: {} } };
  const peg = { ...calc("peg", [{ ref_type: "calculation", ref_id: pe.calculation_id }, { ref_type: "calculation", ref_id: cagr.calculation_id }]), inputs: { pe: 37.4, cagr: 0.5 } };
  writeJson(path.join(d3, "calcs", "a.json"), pe); writeJson(path.join(d3, "calcs", "b.json"), cagr); writeJson(path.join(d3, "calcs", "c.json"), peg);
  const cols = { pe_deducted_x4: pe.calculation_id, forward_pe: "未获取:x", pe_ttm_percentile: "未获取:x", peg: CALC_ID, forward_cagr: cagr.calculation_id, ttm_yoy: "未获取:x", qoq: "未获取:x" };
  writeJson(path.join(d3, "stages", "valuation.json"), { stage: "valuation", status: "incomplete", summary: "ok", evidence_ids: [], calculation_ids: [CALC_ID],
    gaps: ["pe_deducted_annualized", "forward_pe", "pe_ttm_from_parts", "percentile_rank", "pe_digestion_scenarios", "forward_vs_ttm_judgement"].map((o) => gap(o, "upstream_missing")), standard_columns: cols });
  r = validateStage("valuation", loadRun(d3));
  assert.ok(r.errors.some((e) => e.includes("cagr=0.5") && e.includes("output.value=0.59")), r.errors.join("\n"));
});

test("risk 阶段:权威冲突必须以 ref_id 全覆盖;空壳条目不过", () => {
  const d = tmpRun();
  putFetch(d, "fetch_quote", "ok", [ev("ev-aaaa01", "total_market_cap", 100, { unit: "亿元" })]);
  putFetch(d, "fetch_profile", "ok", [ev("ev-aaaa02", "total_market_cap", 120, { unit: "亿元", source: "eastmoney" })]);
  const base = { stage: "risk", status: "complete", summary: "ok", evidence_ids: [], calculation_ids: [], gaps: [], counter_evidence: [{ claim: "c", counter: "x" }],
    decision_points: [{ what_would_change: "a", next_data_point: "b" }, { what_would_change: "a", next_data_point: "b" }, { what_would_change: "a", next_data_point: "b" }] };
  writeJson(path.join(d, "stages", "risk.json"), { ...base, source_conflicts: [] });
  let r = validateStage("risk", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("未覆盖权威冲突 total_market_cap")));
  writeJson(path.join(d, "stages", "risk.json"), { ...base, source_conflicts: [{ field: "total_market_cap", period: "2026-08-21", kind: "source", values: [{ source: "tencent", value: 100, ref_id: "ev-aaaa01" }, { source: "x", value: 1, ref_id: "ev-aaaa01" }] }] });
  r = validateStage("risk", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("未列出权威冲突全部证据 id")), r.errors.join("\n"));
  // 省略 kind → schema 不过;权威冲突标成 cross_check → 不过
  writeJson(path.join(d, "stages", "risk.json"), { ...base, source_conflicts: [{ field: "total_market_cap", period: "2026-08-21", values: [{ source: "tencent", value: 100, ref_id: "ev-aaaa01" }, { source: "eastmoney", value: 120, ref_id: "ev-aaaa02" }] }] });
  r = validateStage("risk", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("kind")), r.errors.join("\n"));
  writeJson(path.join(d, "stages", "risk.json"), { ...base, source_conflicts: [{ field: "total_market_cap", period: "2026-08-21", kind: "cross_check", values: [{ source: "tencent", value: 100, ref_id: "ev-aaaa01" }, { source: "eastmoney", value: 120, ref_id: "ev-aaaa02" }] }] });
  r = validateStage("risk", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes('kind 必须为 "source"')), r.errors.join("\n"));
  writeJson(path.join(d, "stages", "risk.json"), { ...base, source_conflicts: [{ field: "total_market_cap", period: "2026-08-21", kind: "source", values: [{ source: "tencent", value: 100, ref_id: "ev-aaaa01" }, { source: "eastmoney", value: 120, ref_id: "ev-aaaa02" }] }] });
  r = validateStage("risk", loadRun(d));
  assert.deepEqual(r.errors, []);
});

test("账本认证:agent 同时改写 fetch 文件与磁盘账本 → 内存账本仍判不一致;未登记的 fetch / raw 文件 → 不过;agent 改动 fetch/ raw/ 轨迹 → 违规", () => {
  const d = tmpRun();
  putFetch(d, "fetch_quote", "ok", [ev("ev-aaaaaa", "price", 943)]);
  const memLedger = structuredClone(loadLedgerFromDisk(d)); // 编排器内存账本
  // agent 改写 fetch 文件,并把磁盘账本的 sha 一起改成新的
  const f = path.join(d, "fetch", "fetch_quote.json");
  writeJson(f, envelope("fetch_quote", "ok", [ev("ev-aaaaaa", "price", 1)]));
  const disk = loadLedgerFromDisk(d); disk["fetch_quote"].sha256 = sha256File(f); saveLedger(d, disk);
  assert.deepEqual(validateFetchIntegrity(loadRun(d)).errors, []); // 只看磁盘账本会被骗
  assert.ok(validateFetchIntegrity(loadRun(d, memLedger)).errors.some((e) => e.includes("sha256 不一致"))); // 内存账本不会
  // 未登记文件
  const d2 = tmpRun();
  putFetch(d2, "fetch_quote", "ok", [ev("ev-aaaaaa", "price", 943)]);
  fs.writeFileSync(path.join(d2, "fetch", "fetch_fake.json"), "{not json");
  fs.writeFileSync(path.join(d2, "raw", "evil.json"), "{}");
  const errs = validateFetchIntegrity(loadRun(d2)).errors;
  assert.ok(errs.some((e) => e.includes("fetch/fetch_fake.json 没有编排器账本记录")));
  assert.ok(errs.some((e) => e.includes("raw/evil.json 未经编排器取数记录")));
  // 轨迹
  const cfg = makeConfig({ symbol: "300308", repoRoot: path.dirname(path.dirname(path.dirname(d))), runDir: d, python: "python3" });
  assert.ok(!checkAgentTrace({ commands: [], fileChanges: [path.join(d, "fetch", "fetch_quote.json")] }, cfg).ok);
  assert.ok(!checkAgentTrace({ commands: [], fileChanges: [path.join(d, "raw", "x.json")] }, cfg).ok);
  assert.ok(!checkAgentTrace({ commands: [`python3 - <<'EOF'\nopen('${d}/fetch/_ledger.json','w')\nEOF`], fileChanges: [] }, cfg).ok);
  assert.ok(checkAgentTrace({ commands: [`cat ${d}/fetch/fetch_quote.json | jq .`], fileChanges: [path.join(d, "calcs", "01_x.json")] }, cfg).ok);
});

test("report 阶段:章节 / 引用 / 状态 / gate", () => {
  const d = tmpRun();
  putFetch(d, "fetch_quote", "ok", [ev("ev-aaaaa2", "price", 943)]);
  writeJson(path.join(d, "calcs", "01_peg.json"), calc("peg", [{ ref_type: "evidence", ref_id: "ev-aaaaa2" }]));
  writeJson(path.join(d, "stages", "report.json"), { stage: "report", status: "complete", summary: "ok", evidence_ids: [], calculation_ids: [], gaps: [] });
  const good = "# X 研究报告 · 状态:complete\n## 结论摘要\n- 增长已兑现\n## 事实\n- 现价 943 元(ev-aaaaa2)\n## 推断\n## 估值\n- PEG 1.5(calc-0123456789abcdef)\n## 风险与反证\n## 裁决点\n## 数据缺口\n";
  fs.writeFileSync(path.join(d, "report.md"), good.replace("- 增长已兑现", "- 建议建仓"));
  let r = validateStage("report", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("合规 gate")));
  fs.writeFileSync(path.join(d, "report.md"), good);
  r = validateStage("report", loadRun(d));
  assert.deepEqual(r.errors, []);
  fs.writeFileSync(path.join(d, "report.md"), "# X 研究报告\n## 结论摘要\n- 引用 ev-abcdef\n");
  r = validateStage("report", loadRun(d));
  assert.ok(r.errors.some((e) => e.includes("缺少章节")) && r.errors.some((e) => e.includes("ev-abcdef")) && r.errors.some((e) => e.includes("缺少状态标记")));
});

test("agent 行为检查:关键词 / 主目录外路径 / 自跑取数脚本 / 写入运行目录外;shell 变量与仓库内路径不误报", () => {
  const cfg = { scriptsRel: ".agents/skills/data-access/scripts", forbiddenPathPatterns: ["交接资料", "../"], allowedPathPrefixes: ["/Users/u/repo", "/Users/u/.venv", "/bin", "/usr"], runDir: "/Users/u/repo/.local/runs/x" };
  const okTrace = { commands: [
    "/Users/u/.venv/bin/python /Users/u/repo/calc/cli.py peg --args '{}' > ${RUN}/calcs/01_peg.json",
    "/bin/zsh -lc 'jq . /Users/u/repo/.local/runs/x/fetch/a.json'", "cat \"$RUN\"/fetch/fetch_quote.json | jq .extra"], fileChanges: ["/Users/u/repo/.local/runs/x/stages/profile.json"] };
  assert.deepEqual(checkAgentTrace(okTrace, cfg).errors, []);
  const bad = checkAgentTrace({ commands: ["cat ../交接资料/x.md", "ls /Users/someone/Desktop", "python3 .agents/skills/data-access/scripts/fetch_quote.py --symbol 1"], fileChanges: ["/Users/u/repo/AGENTS.md"] }, cfg);
  assert.ok(bad.errors.some((e) => e.includes("交接资料")));
  assert.ok(bad.errors.some((e) => e.includes("仓库外路径:/Users/someone/Desktop")));
  assert.ok(bad.errors.some((e) => e.includes("自行运行了取数脚本")));
  assert.ok(bad.errors.some((e) => e.includes("运行目录之外")));
});

test("合并证据:同 id 去重 / 跨源冲突(同事实键同单位异值)/ 单位不同不比较 / raw_hashes", () => {
  const d = tmpRun();
  fs.writeFileSync(path.join(d, "raw", "a.txt"), "hello");
  const a = envelope("fetch_quote", "ok", [ev("ev-aaaaa1", "pe_ttm", 53.93, { unit: "倍", source: "tencent" })]);
  const b = envelope("fetch_pe_history", "ok", [ev("ev-bbbbb1", "pe_ttm", 54.2, { unit: "倍", source: "baostock" }), ev("ev-aaaaa1", "pe_ttm", 53.93, { unit: "倍" })]);
  const c = envelope("fetch_x", "ok", [ev("ev-ccccc1", "pe_ttm", 53.93, { unit: "元" })]);
  const m = mergeEvidence({ fetch_quote: a, fetch_pe_history: b, fetch_x: c } as never);
  assert.equal(m.evidence.length, 3);
  assert.equal(m.idConflicts.length, 0);
  const sc = detectSourceConflicts({ fetch_quote: a, fetch_pe_history: b, fetch_x: c } as never);
  assert.equal(sc.length, 1);
  assert.equal(sc[0].field, "pe_ttm");
  assert.equal(sc[0].values.length, 2);
  assert.equal(Object.keys(rawHashes(d)).length, 1);
});

test("复算:history_json 计算记录可由 validator 经 calc CLI 复算;raw 内容变化 → inputs_resolved / id 不一致", async () => {
  const { spawnSync } = await import("node:child_process");
  const { makeConfig } = await import("../src/config.ts");
  const { verifyCalcs, loadRun } = await import("../src/validator.ts");
  const { loadProductConfig } = await import("../src/productConfig.ts");
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  // 解释器:产品配置链(vibe-research.config.json ← .local/config.json ← VRA_PYTHON)→ 否则 python3;calc 只依赖标准库
  const PY = loadProductConfig(REPO, { env: process.env }).python ?? process.env.VRA_PYTHON ?? "python3";
  const probe = spawnSync(PY, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
  assert.equal(probe.status, 0, `解释器不可用:${PY} ${probe.error?.message ?? probe.stderr}`);
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: REPO, runId: "t-calc-hj", python: PY, runDir: fs.mkdtempSync(path.join(os.tmpdir(), "vra-hj-")) });
  for (const d of ["raw", "calcs", "fetch", "stages"]) fs.mkdirSync(path.join(cfg.runDir, d), { recursive: true });
  const rows = Array.from({ length: 40 }, (_, i) => { const dt = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10); return [dt, String(1 + i), String(1 + i), String(1.5 + i), String(0.5 + i), "100"]; });
  fs.writeFileSync(path.join(cfg.runDir, "raw", "tx.js"), "cb(" + JSON.stringify({ data: { sz300308: { qfqday: rows } } }) + ");");
  const args = { klines: { history_json: { raw_ref: "raw/tx.js", rows_path: "data.sz300308.qfqday", columns: { date: 0, open: 1, close: 2, high: 3, low: 4 } } } };
  const p = spawnSync(PY, [path.join(REPO, "calc", "cli.py"), "technical_indicators", "--args", JSON.stringify(args), "--run-dir", cfg.runDir, "--evidence", "ev-aaaaaa"], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  const rec = JSON.parse(p.stdout);
  assert.equal(rec.calc_version, "0.3.2");
  fs.writeFileSync(path.join(cfg.runDir, "calcs", "01_technical_indicators.json"), JSON.stringify(rec));
  let r = verifyCalcs(cfg, loadRun(cfg.runDir, {}));
  assert.ok(r.ok, r.errors.join("|"));
  // 篡改 raw(少一行)→ sha256 / rows_used 变 → id 与 inputs_resolved 都不一致
  fs.writeFileSync(path.join(cfg.runDir, "raw", "tx.js"), "cb(" + JSON.stringify({ data: { sz300308: { qfqday: rows.slice(0, -1) } } }) + ");");
  r = verifyCalcs(cfg, loadRun(cfg.runDir, {}));
  assert.ok(!r.ok && r.errors.some((e) => e.includes("calculation_id 不一致")) && r.errors.some((e) => e.includes("inputs_resolved")), r.errors.join("|"));
});

test("displayProjection / verifyCalcs:details 里结果形子对象的 display 进入复算闭环;篡改四锚子 display 或删顶层 display 都判不一致;旧记录(无 display)不误报", async () => {
  const { spawnSync } = await import("node:child_process");
  const { makeConfig } = await import("../src/config.ts");
  const { verifyCalcs, loadRun, displayProjection } = await import("../src/validator.ts");
  const { loadProductConfig } = await import("../src/productConfig.ts");
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const PY = loadProductConfig(REPO, { env: process.env }).python ?? process.env.VRA_PYTHON ?? "python3";
  const probe = spawnSync(PY, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
  assert.equal(probe.status, 0, `解释器不可用:${PY}`);
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: REPO, runId: "t-disp", python: PY, runDir: fs.mkdtempSync(path.join(os.tmpdir(), "vra-disp-")) });
  for (const d of ["raw", "calcs", "fetch", "stages"]) fs.mkdirSync(path.join(cfg.runDir, d), { recursive: true });
  const p = spawnSync(PY, [path.join(REPO, "calc", "cli.py"), "pe_digestion_scenarios", "--args", JSON.stringify({ pe: 37.4, cagr: 0.59 }), "--run-dir", cfg.runDir, "--calc", "calc-0123456789abcdef", "calc-fedcba9876543210"], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  const rec = JSON.parse(p.stdout);
  assert.equal(rec.output.display, null);
  const proj = displayProjection(rec.output);
  assert.ok(proj.length >= 5 && proj.some(([k, d]) => k.startsWith("details.scenarios.") && typeof d === "string" && /年$/.test(d)), JSON.stringify(proj));
  const file = path.join(cfg.runDir, "calcs", "01_pe_digestion_scenarios.json");
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(verifyCalcs(cfg, loadRun(cfg.runDir)).ok, true);
  const tampered = JSON.parse(JSON.stringify(rec)); const k = Object.keys(tampered.output.details.scenarios)[0]; tampered.output.details.scenarios[k].display = "0.10 年";
  fs.writeFileSync(file, JSON.stringify(tampered));
  const r1 = verifyCalcs(cfg, loadRun(cfg.runDir)); assert.equal(r1.ok, false); assert.match(r1.errors.join("\n"), /结果投影不一致.*display|display 不一致/);
  const del = JSON.parse(JSON.stringify(rec)); delete del.output.display; fs.writeFileSync(file, JSON.stringify(del));
  assert.equal(verifyCalcs(cfg, loadRun(cfg.runDir)).ok, false);
  // 子结果 value 被改而 display 保留(r4):结果投影整体比对必须抓到
  const tv = JSON.parse(JSON.stringify(rec)); tv.output.details.scenarios[k].value = 9.99; fs.writeFileSync(file, JSON.stringify(tv));
  const r2 = verifyCalcs(cfg, loadRun(cfg.runDir)); assert.equal(r2.ok, false); assert.match(r2.errors.join("\\n"), /结果投影不一致/);
  fs.writeFileSync(file, JSON.stringify(rec)); assert.equal(verifyCalcs(cfg, loadRun(cfg.runDir)).ok, true);
  assert.deepEqual(displayProjection({ status: "ok", value: 1, unit: "倍", reason: "", details: {} }), []);
});
