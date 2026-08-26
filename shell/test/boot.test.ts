import assert from "node:assert/strict";
import { test } from "node:test";

import { bootHtml, esc, initialBootState, patchState, withStep } from "../src/boot.ts";

test("转义先转 & —— 否则后面几步产生的实体会被自己再转一遍", () => {
  assert.equal(esc("<a>&</a>"), "&lt;a&gt;&amp;&lt;/a&gt;");
  // 如果顺序反了，`&` 会把前面产生的 `&lt;` 变成 `&amp;lt;`
  assert.ok(!esc("<x>").includes("&amp;lt;"));
});

test("withStep 认不出这一步就报错 —— 打错 key 静默不生效等于进度永远不动", () => {
  const s = initialBootState("P");
  assert.throws(() => withStep(s, "nope", { state: "done" }), /没有这一步/);
});

test("每次状态变化 revision 都要涨（启动页靠它判断要不要重画）", () => {
  const a = initialBootState("P");
  const b = withStep(a, "backend", { state: "doing" });
  const c = patchState(b, { phase: "failed" });
  assert.equal(a.revision, 0);
  assert.equal(b.revision, 1);
  assert.equal(c.revision, 2);
  // 不可变：原对象没被改
  assert.equal(a.steps.find((s) => s.key === "backend")!.state, "pending");
});

test("启动页把路径与子进程日志一律转义（它们不是我们写的字面量）", () => {
  const s = patchState(initialBootState("P"), {
    phase: "failed",
    problems: ["<img src=x onerror=alert(1)>"],
    log: "</script><script>alert(2)</script>",
  });
  const html = bootHtml(s, "N0NCE");
  assert.ok(!html.includes("<img src=x"), "problems 没转义");
  assert.ok(!html.includes("<script>alert(2)"), "log 没转义");
  assert.ok(html.includes("&lt;img src=x"));
});

test("失败是终态：不再轮询（否则失败页每 500ms 自我重载一次）", () => {
  const ok = bootHtml(initialBootState("P"), "N");
  const bad = bootHtml(patchState(initialBootState("P"), { phase: "failed" }), "N");
  assert.ok(ok.includes("setInterval"), "启动中应当轮询");
  assert.ok(!bad.includes("setInterval"), "失败后不该再轮询");
});

test("页面里嵌的 revision 就是当前 revision —— 对不上会导致无限重载", () => {
  const s = withStep(initialBootState("P"), "preflight", { state: "done" });
  assert.ok(bootHtml(s, "N").includes(`window.__rev=${s.revision};`));
});

test("🔴 ready 时启动页不再自我重载 —— 主进程正要导航到界面，两条导航会抢同一个窗口", () => {
  const html = bootHtml(initialBootState("P"), "N");
  assert.ok(/if\(s\.phase==="ready"\)return;/.test(html), `轮询脚本缺少 ready 短路：\n${html.slice(-400)}`);
});

test("🔴 读不到状态要出声：连续失败会在页面上写出来，而不是永远停在\"正在启动\"", () => {
  const html = bootHtml(initialBootState("P"), "N");
  assert.ok(html.includes('id="warn"'), "缺少显示位");
  assert.ok(/window\.__bad>=10/.test(html), "缺少连续失败计数");
  assert.ok(/读不到启动状态/.test(html), "缺少人话说明");
});
