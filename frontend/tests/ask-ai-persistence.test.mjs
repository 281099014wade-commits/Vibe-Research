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

test("saving is gated on the key the current messages belong to", () => {
  // key 变化那一帧两个 effect 都会跑，而 msgs 还是上一个 key 的内容
  // （setMsgs 下一帧才生效）。不校验就会把来源页对话写进目标 key，
  // 覆盖掉目标页已存的对话 —— 静默数据丢失。
  assert.match(source, /loadedKeyRef/);
  assert.match(source, /if \(loadedKeyRef\.current !== chatKey\) return;/);
  // 载入时必须先更新 ref，再 setMsgs
  assert.match(source, /loadedKeyRef\.current = chatKey;\s*\n\s*setMsgs\(loadChat\(chatKey\)\)/);
});

test("callers can scope a conversation below the route level", () => {
  // 个股页不换路由就能换标的：只按 pathname 分 key 会让 A 股票的历史
  // 作为 history 发给正在问 B 股票的模型。
  assert.match(source, /scopeKey\?: string/);
  assert.match(source, /CHAT_KEY_PREFIX \+ pathname \+ \(scopeKey \? `#\$\{scopeKey\}` : ""\)/);
});

test("the stock page actually passes a per-symbol scope", async () => {
  const page = await readFile(
    new URL("../src/pages/StockData.tsx", import.meta.url), "utf8",
  );
  assert.match(page, /<AskAiButton[\s\S]*?scopeKey=/);
});
