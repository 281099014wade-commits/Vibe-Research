import assert from "node:assert/strict";
import { test } from "node:test";

import { GATE_REGEXPS, gateStagePatterns } from "../src/config.ts";
import { stageComplianceErrors } from "../src/validator.ts";
import { complianceGate, missingSections, normalizeReportStatus, referencedIds, reportStatusToken } from "../src/gate.ts";
import { reportSections } from "../src/config.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
test("合规 gate:命中建仓 / 目标价类词", () => {
  const r = complianceGate("## 结论摘要\n- 建议在 900 元附近建仓\n- 目标价 1200 元");
  assert.equal(r.ok, false);
  assert.deepEqual(r.hits.map((h) => h.pattern).sort(), ["建仓", "目标价"]);
  assert.equal(r.hits[0].line, 2);
});

test("合规 gate:只有整行精确等于固定免责句才豁免;'不构成投资建议,但建议建仓'不放过", () => {
  assert.equal(complianceGate("本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。\n## 事实\n- PE 53.9 倍 ev-aaaaaa").ok, true);
  assert.equal(complianceGate("- 本报告不提供任何投资动作建议。").ok, true); // 列表前缀允许
  const bad = complianceGate("本报告不构成投资建议,但建议建仓。");
  assert.equal(bad.ok, false);
  assert.equal(complianceGate("本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。但目标价 1200").ok, false);
});

test("合规 gate:正常报告通过", () => {
  assert.equal(complianceGate("## 估值\n- 扣非×4 PE = 37.4 倍(calc-0123456789abcdef)\n## 裁决点\n- 若 Q3 单季扣非环比转负,增长加速判断被推翻").ok, true);
});

test("章节缺失检测", () => {
  const report = "# X 研究报告 · 状态:complete\n## 结论摘要\n## 事实\n## 推断\n## 估值\n## 风险与反证\n## 裁决点\n";
  assert.deepEqual(missingSections(report, [...reportSections()]), ["数据缺口"]);
});

test("引用 id 提取去重", () => {
  const r = referencedIds("ev-aaaaaa ev-aaaaaa calc-0123456789abcdef ev-bbbbbb calc-0123456789abcdef");
  assert.deepEqual(r.evidence.sort(), ["ev-aaaaaa", "ev-bbbbbb"]);
  assert.deepEqual(r.calculation, ["calc-0123456789abcdef"]);
});

test("报告状态标记读取与归一", () => {
  const rep = "# X 研究报告 · 状态:complete\n## 结论摘要\n";
  assert.equal(reportStatusToken(rep), "complete");
  const n = normalizeReportStatus(rep, "incomplete");
  assert.equal(n.changed, true);
  assert.equal(reportStatusToken(n.text), "incomplete");
  assert.equal(normalizeReportStatus(n.text, "incomplete").changed, false);
  assert.equal(reportStatusToken("# 无状态"), null);
});

test("gate 正则规则:审计列出的绕过说法必须全拦,真实语料零误报(全审 r3-P1-1)", () => {
  // 旧实现(26 个中文子串)对这些**一条都拦不住**
  const BYPASS = ["当前价格值得买入", "可考虑介入", "建议继续持有", "跌破 50 元离场",
    "合理价格看至 120 元", "BUY, target price RMB 120", "风险收益比合适,可以参与",
    "评级:买入", "越跌越买", "go long here", "stop-loss 设在 80", "long position 建立"];
  for (const s of BYPASS) assert.equal(complianceGate(s).ok, false, `应被拦:${s}`);

  // 🔴 反向同样重要:这些是**合法内容**,拦了就等于拒掉正确的产出
  const LEGIT = [
    "报告不含投资动作建议、目标价、止损位或价格锚。",     // 免责声明里"提到"这些词
    "近一年机构报告 38 篇,其中买入评级 31 篇、增持评级 7 篇;仅作覆盖分布线索。",
    "四锚为 PE 情景,不是目标价或合理价。",
    "margin_financing_buy | 6191310178 | 元",              // 字段名里的 buy 不算
  ];
  for (const s of LEGIT) {
    const r = complianceGate(s, [], [], GATE_REGEXPS);   // 只看正则规则(子串表另有豁免机制)
    assert.equal(r.ok, true, `不该被正则拦:${s} → ${JSON.stringify(r.hits)}`);
  }
});

test("阶段产物 gate:词表收窄后既拦得住建议、又放得过免责与统计(全审 r3-P1-2)", () => {
  const sub = gateStagePatterns();
  assert.ok(!sub.includes("目标价") && !sub.includes("止损"), "会出现在'提及'语境的词必须去掉");
  assert.ok(sub.includes("建仓") && sub.includes("建议买"), "明确动作词必须留着");
  for (const bad of ["建议买入,目标价 120 元", "可考虑介入", "跌破 80 元止损", "建议建仓 30%"]) {
    assert.equal(complianceGate(bad, sub, [], GATE_REGEXPS).ok, false, `应被拦:${bad}`);
  }
  for (const okText of ["报告不含投资动作建议、目标价、止损位。", "买入评级 31 篇、增持评级 7 篇"]) {
    assert.equal(complianceGate(okText, sub, [], GATE_REGEXPS).ok, true, `不该被拦:${okText}`);
  }
  // 递归收集:建议藏在嵌套字段里也要抓到,而 id 类字段不参与
  const rec = { stage: "risk", summary: "正常", gaps: [{ operation: "x", reason_code: "y", detail: "建议加仓至 30%" }],
    evidence_ids: ["ev-abc123"], counter_evidence: [{ claim: "ok", counter: "ok" }] };
  const errs = stageComplianceErrors("risk", rec);
  assert.ok(errs.length >= 1, JSON.stringify(errs));  // 同一行可能同时命中子串与正则,条数不写死
  assert.match(errs[0], /命中投资动作建议/);
  assert.equal(stageComplianceErrors("risk", { ...rec, gaps: [] }).length, 0);
});

test("referencedIds 必须整 token 匹配:伪前缀引用不算(全审 r1-P2-4)", () => {
  const real = "ev-abcdef123456";
  // 有边界:正常引用认得出
  assert.deepEqual(referencedIds(`营收 99 亿元(${real})`).evidence, [real]);
  // 无边界时 `ev-abcdef123456xyz` 会截出合法前缀,伪引用就能满足"引用存在"
  assert.deepEqual(referencedIds(`营收 99 亿元(${real}xyz)`).evidence, []);
  assert.deepEqual(referencedIds(`x${real}`).evidence, []);
  const c = "calc-0123456789abcdef";
  assert.deepEqual(referencedIds(`(${c})`).calculation, [c]);
  assert.deepEqual(referencedIds(`(${c}00)`).calculation, []);
});

test("gaps[].operation 也是自由文本,必须过 gate(修复复审 r1-P1-3)", () => {
  // 🔴 它曾被当成"标识符"排除在 gate 之外 —— 但 schema 上只要求非空字符串,
  //    建议写进去就能绕过阶段 gate 并原样进附录。判断标准是**取值受不受控**,不是名字像不像标识符。
  const rec = { stage: "risk", summary: "正常", gaps: [{ operation: "建议买入并建仓三成", reason_code: "source_failed", detail: "x" }] };
  assert.ok(stageComplianceErrors("risk", rec).length >= 1, JSON.stringify(stageComplianceErrors("risk", rec)));
  // reason_code 是受控枚举,不该被当自由文本
  const ok = { stage: "risk", summary: "正常", gaps: [{ operation: "fetch_x", reason_code: "source_failed", detail: "x" }] };
  assert.deepEqual(stageComplianceErrors("risk", ok), []);
});
