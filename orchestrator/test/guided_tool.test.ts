import assert from "node:assert/strict";
import test from "node:test";

import "../src/finance/register.ts";
import { GuidedToolError, guidedToolTurn, type GuidedToolDeps } from "../src/guided_tool.ts";

const opts = { repoRoot: process.cwd(), dataRoot: process.cwd() };
const req = { name: "sample", label: "样例任务", session: "s1", message: "请验证这个想法" };

function model(status: "needs_input" | "ready" | "complete", over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status,
    message: status === "needs_input" ? "还需要时间范围。" : status === "ready" ? "条件齐了，开始执行。" : "已经完成并形成报告。",
    title: status === "needs_input" ? "" : "验证主题",
    question: status === "needs_input" ? "" : "这个想法是否成立？",
    hypothesis: status === "needs_input" ? "" : "历史样本可以验证该想法。",
    logic: status === "needs_input" ? [] : ["按时间范围取样", "比较结果与基准"],
    tool_args_json: status === "ready" ? '{"start":"2020-01-01"}' : "",
    document: status === "complete" ? "## 核心结果\n\n真实工具返回显示验证完成。\n\n## 限制\n\n仅覆盖现有样本。" : "",
    ...over,
  });
}

test("信息不足时只追问，不调用正式工具", async () => {
  const calls: unknown[] = [];
  const deps: GuidedToolDeps = {
    chat: async () => ({ session: "x", reply: model("needs_input"), redacted: 0, duration_ms: 1 }),
    runTool: async (_name, body) => { calls.push(body); return { ok: true, catalog: { choices: ["a"] } }; },
  };
  const out = await guidedToolTurn(opts, req, deps);
  assert.deepEqual(out, { status: "needs_input", message: "还需要时间范围。" });
  assert.deepEqual(calls, [{ action: "catalog" }], "不能在参数不足时偷偷跑正式任务");
});

test("条件齐备后真实调用工具，并用工具返回生成完整报告", async () => {
  const chats = [model("ready"), model("complete")];
  const calls: unknown[] = [];
  const deps: GuidedToolDeps = {
    chat: async (o, r) => {
      assert.ok(o.outputSchema, "每轮都必须带结构化输出约束");
      assert.match(String(o.developerInstructions), /追问/);
      assert.match(String(o.contextText), /真实能力说明/);
      if (chats.length === 1) assert.match(r.message, /唯一可用的真实结果/);
      return { session: "x", reply: chats.shift()!, redacted: 0, duration_ms: 1 };
    },
    runTool: async (_name, body) => {
      calls.push(body);
      if ((body as { action?: string }).action === "catalog") return { ok: true, catalog: { choices: ["a"] } };
      return { ok: true, result: { score: 0.42 } };
    },
  };
  const out = await guidedToolTurn(opts, req, deps);
  assert.equal(out.status, "complete");
  assert.equal(out.hypothesis, "历史样本可以验证该想法。");
  assert.match(out.report ?? "", /核心结果/);
  assert.deepEqual(calls, [{ action: "catalog" }, { start: "2020-01-01" }]);
});

test("工具拒绝时回到补问，不伪装成完成", async () => {
  const chats = [model("ready"), model("needs_input", { message: "样本太短，请扩大时间范围。" })];
  const deps: GuidedToolDeps = {
    chat: async () => ({ session: "x", reply: chats.shift()!, redacted: 0, duration_ms: 1 }),
    runTool: async (_name, body) => (body as { action?: string }).action === "catalog"
      ? { ok: true, catalog: {} }
      : { ok: false, refused: { reason: "样本太短", remedy: "扩大时间范围" } },
  };
  assert.deepEqual(await guidedToolTurn(opts, req, deps), { status: "needs_input", message: "样本太短，请扩大时间范围。" });
});

test("Agent 不能用 action 覆盖能力说明入口，也不能在未执行时声称完成", async () => {
  const runTool = async (_name: string, body: unknown) => (body as { action?: string }).action === "catalog" ? { ok: true } : { ok: true };
  await assert.rejects(
    () => guidedToolTurn(opts, req, { chat: async () => ({ session: "x", reply: model("ready", { tool_args_json: '{"action":"catalog"}' }), redacted: 0, duration_ms: 1 }), runTool }),
    (e: unknown) => e instanceof GuidedToolError && e.code === "bad_tool_args",
  );
  await assert.rejects(
    () => guidedToolTurn(opts, req, { chat: async () => ({ session: "x", reply: model("complete"), redacted: 0, duration_ms: 1 }), runTool }),
    (e: unknown) => e instanceof GuidedToolError && e.code === "bad_agent_state",
  );
});
