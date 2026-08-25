import assert from "node:assert/strict";
import { test } from "node:test";

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
