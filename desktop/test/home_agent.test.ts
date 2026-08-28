import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const financeAgent = readFileSync(
  new URL("../src/verticals/finance/components/ui/FinanceAiDock.tsx", import.meta.url),
  "utf8",
);
const coreMessages = readFileSync(
  new URL("../src/core/ai/AiMessages.tsx", import.meta.url),
  "utf8",
);

test("首页 Agent 把提醒移到输入区，并保留统一的任务入口", () => {
  assert.doesNotMatch(financeAgent, /notice="直接问市场、公司、行业或研究方法。"/);
  assert.match(financeAgent, /placeholder="输入市场、公司、行业或研究方法…（Shift\+Enter 换行）"/);
  assert.match(financeAgent, /suggestionStyle="tasks"/);
  assert.match(financeAgent, /onPick=\{setDraft\}/);
  assert.doesNotMatch(financeAgent, /onPick=\{\(x\) => void chat\.submit\(x\)\}/);
  assert.match(financeAgent, /<AiComposer[\s\S]*?highlighted[\s\S]*?\/>/);

  for (const prompt of [
    "今日复盘",
    "今日的连板股是什么？分析涨停的原因",
    "调取这家公司今年的所有研报，并进行深度分析",
    "先收集这个行业最近3个月的200份研报，然后分析这个行业",
  ]) {
    assert.ok(financeAgent.includes(prompt), `缺少首页预填任务：${prompt}`);
  }
});

test("Core 只在有说明时渲染提醒框，长任务使用统一卡片样式", () => {
  assert.match(coreMessages, /msgs\.length === 0 && notice &&/);
  assert.match(coreMessages, /suggestionStyle === "tasks" \? "grid gap-2 sm:grid-cols-2"/);
  assert.match(coreMessages, /highlighted \? "border-warning\/30 bg-warning\/\[0\.035\]"/);
  assert.match(coreMessages, /const v = value \?\? ref\.current\?\.value \?\? ""/);
  assert.match(coreMessages, /onValueChange\?\.\(""\)/);
});
