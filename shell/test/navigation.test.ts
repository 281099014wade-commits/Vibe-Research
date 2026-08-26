import assert from "node:assert/strict";
import { test } from "node:test";

import { decideNavigation } from "../src/navigation.ts";

const SELF = { scheme: "app", host: "vibe" };

test("本应用的页面放行", () => {
  assert.deepEqual(decideNavigation("app://vibe/daily-review", SELF), { action: "allow" });
  assert.deepEqual(decideNavigation("app://vibe/", SELF), { action: "allow" });
});

test("🔴 冒充主机名的挡掉（`app://vibe.evil/` 也以 vibe 开头）", () => {
  assert.equal(decideNavigation("app://vibe.evil/x", SELF).action, "block");
  assert.equal(decideNavigation("app://notvibe/x", SELF).action, "block");
});

test("🔴 别的自定义协议挡掉 —— 它们的 URL.origin 与我们一样都是字符串 \"null\"", () => {
  // 这条正是"照 origin 比"会漏掉的：`new URL("evil://vibe/x").origin === "null"`
  assert.equal(new URL("evil://vibe/x").origin, "null");
  assert.equal(new URL("app://vibe/x").origin, "null");
  assert.equal(decideNavigation("evil://vibe/x", SELF).action, "block");
});

test("http/https 交给系统浏览器", () => {
  assert.deepEqual(decideNavigation("https://example.com/a?b=1", SELF), {
    action: "external",
    url: "https://example.com/a?b=1",
  });
  assert.equal(decideNavigation("http://127.0.0.1:8765/ui", SELF).action, "external");
});

test("危险 scheme 一律挡，绝不交给 openExternal", () => {
  for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<h1>x", "about:blank", "vscode://x"]) {
    assert.equal(decideNavigation(u, SELF).action, "block", u);
  }
});

test("不是合法 URL 也要挡（而不是抛出去把主进程带崩）", () => {
  assert.equal(decideNavigation("", SELF).action, "block");
  assert.equal(decideNavigation("/relative/path", SELF).action, "block");
});
