import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SRC = new URL("../src/components/ui/AskAiButton.tsx", import.meta.url);
const source = await readFile(SRC, "utf8");

// 这些断言锁的是 #19 的修复：对话此前只存在组件 useState 里，
// 切页面/刷新就全丢。用户反馈「关闭 AI 就找不回之前的对话」，
// 而每轮对话都花了他自己的 API 额度。

test("Ask AI persists the conversation through the safe storage helper", () => {
  assert.match(source, /from "@\/lib\/storage"/);
  assert.match(source, /storageGet/);
  assert.match(source, /storageSet/);
  // 必须走 storage.ts 的封装：localStorage 在隐私模式/配额写满时会直接抛异常，
  // 裸调会让整个面板崩掉。
  assert.doesNotMatch(source, /(?<!\/\/.*)\blocalStorage\.(get|set|remove)Item\b/);
});

test("conversations are keyed per route, not shared across pages", () => {
  assert.match(source, /useLocation/);
  assert.match(source, /CHAT_KEY_PREFIX\s*\+\s*pathname/);
});

test("persisted history is capped so localStorage cannot be blown out", () => {
  assert.match(source, /MAX_PERSISTED_MSGS\s*=\s*\d+/);
  assert.match(source, /slice\(-MAX_PERSISTED_MSGS\)/);
});

test("malformed stored data is ignored instead of crashing the panel", () => {
  // 存量数据可能来自旧版本或被手工改坏；JSON.parse 必须包 try/catch，
  // 且要校验形状，否则脏数据会让页面白屏。
  assert.match(source, /try\s*\{[\s\S]*JSON\.parse[\s\S]*\}\s*catch/);
  assert.match(source, /Array\.isArray\(parsed\)/);
});

test("there is a way to clear a stored conversation", () => {
  assert.match(source, /storageRemove/);
  assert.match(source, /clearChat/);
});

test("emptying the conversation removes the key rather than storing an empty shell", () => {
  assert.match(source, /if \(!msgs\.length\)\s*\{\s*\n?\s*storageRemove\(key\)/);
});
