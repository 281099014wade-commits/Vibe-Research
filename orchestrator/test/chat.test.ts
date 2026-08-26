import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts"; // 测试文件也是入口:插件要先注册
import { ChatError, chatSend, chatSessionCount, resetChatSessions } from "../src/chat.ts";

// ⚠️ 用 fileURLToPath 而不是 new URL(...).pathname —— 本机仓库路径含中文,
//    pathname 会给出百分号编码的路径,子进程与 fs 都找不到(这条坑本仓库踩过)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Cap {
  opts?: Record<string, unknown>;
  prompts: string[];
}

/** 假的 Codex:记录 startThread 的选项与收到的提示词,回放预设回答 —— 不打真模型 */
function fakeCodex(reply: string, cap?: Cap) {
  return () =>
    ({
      startThread(opts: Record<string, unknown>) {
        if (cap) cap.opts = opts;
        return {
          id: "t-fake",
          runStreamed(prompt: string) {
            cap?.prompts.push(prompt);
            return Promise.resolve({
              events: (async function* () {
                yield { type: "item.completed", item: { type: "agent_message", text: reply } };
              })(),
            });
          },
        };
      },
    }) as never;
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vra-chat-"));

test("对话线程的三条硬约束必须真的传给引擎:只读沙箱 / 不联网 / 不联网搜索", async () => {
  resetChatSessions();
  const cap: Cap = { prompts: [] };
  await chatSend({ repoRoot: REPO, dataRoot: tmp() }, { session: "t1", message: "你好" }, fakeCodex("好", cap));
  const o = cap.opts!;
  // 🔴 这三条不是"配置项"是安全边界:任何一条被改松,对话线程就能写文件 / 联网 / 绕开取数纪律
  assert.equal(o.sandboxMode, "read-only");
  assert.equal(o.networkAccessEnabled, false);
  assert.equal(o.webSearchMode, "disabled");
  assert.equal(o.approvalPolicy, "never");
  assert.equal(o.skipGitRepoCheck, true);
});

test("工作目录必须在数据根之下 —— 不在指令根后代里时宪法加载不到,而引擎不报错", async () => {
  resetChatSessions();
  const root = tmp();
  const cap: Cap = { prompts: [] };
  await chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t2", message: "你好" }, fakeCodex("好", cap));
  const wd = String(cap.opts!.workingDirectory);
  assert.ok(wd.startsWith(path.resolve(root) + path.sep), `工作目录应在数据根内:${wd}`);
  assert.ok(fs.existsSync(wd), "工作目录要真的建出来");
});

test("开场交代只在第一轮发,后续轮次不重复(重复既费 token 又稀释指令)", async () => {
  resetChatSessions();
  const cap: Cap = { prompts: [] };
  const root = tmp();
  await chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t3", message: "第一问" }, fakeCodex("好", cap));
  await chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t3", message: "第二问" }, fakeCodex("好", cap));
  assert.ok(cap.prompts[0]!.includes("对话模式"), "第一轮要带开场交代");
  assert.equal(cap.prompts[1], "第二问", "第二轮只发消息本身");
  assert.equal(chatSessionCount(), 1, "同一 session 复用同一条线程");
});

test("开场交代里不许再出现可复述的禁用词 —— 那会让模型复述后被自己的 gate 整行移除", async () => {
  resetChatSessions();
  const cap: Cap = { prompts: [] };
  await chatSend({ repoRoot: REPO, dataRoot: tmp() }, { session: "t4", message: "x" }, fakeCodex("好", cap));
  const p = cap.prompts[0]!;
  // 实测过:preamble 里写"不给目标价",模型照抄一句"我不给目标价",gate 子串匹配命中 → 整行被移除
  for (const w of ["目标价", "买卖时点", "建仓建议"]) {
    assert.ok(!p.includes(w), `开场交代不该出现「${w}」(会被模型复述后误伤)`);
  }
});

test("回答过合规 gate:命中的行被移除并计数,没命中的原样返回", async () => {
  resetChatSessions();
  const root = tmp();
  const clean = await chatSend(
    { repoRoot: REPO, dataRoot: root },
    { session: "g1", message: "x" },
    fakeCodex("这是一段只讲事实的回答。"),
  );
  assert.equal(clean.redacted, 0);
  assert.equal(clean.reply, "这是一段只讲事实的回答。");

  const dirty = await chatSend(
    { repoRoot: REPO, dataRoot: root },
    { session: "g2", message: "x" },
    fakeCodex("第一行是正常内容。\n建议现在建仓。\n第三行也正常。"),
  );
  assert.equal(dirty.redacted, 1, "只移除命中的那一行");
  assert.ok(dirty.reply.includes("第一行是正常内容。"), "干净的行要留着");
  assert.ok(dirty.reply.includes("第三行也正常。"), "命中行之后的内容不能被连累");
  assert.ok(!dirty.reply.includes("建仓"), "命中的动作词必须真的没了");
  assert.ok(dirty.reply.includes("已移除"), "要显式说明这里少了东西");
});

test("输入校验:空消息 / 超长 / 非法会话名一律当场拒绝", async () => {
  resetChatSessions();
  const root = tmp();
  const bad: [{ session: string; message: string }, string][] = [
    [{ session: "ok", message: "   " }, "empty_message"],
    [{ session: "ok", message: "x".repeat(5000) }, "message_too_long"],
    [{ session: "../evil", message: "x" }, "bad_session"],
    [{ session: "", message: "x" }, "bad_session"],
  ];
  for (const [req, code] of bad) {
    await assert.rejects(
      () => chatSend({ repoRoot: REPO, dataRoot: root }, req, fakeCodex("好")),
      (e: unknown) => e instanceof ChatError && e.code === code,
      `应拒绝 ${JSON.stringify(req)}`,
    );
  }
});

test("🔴 会话按「数据根 + 会话名」索引 —— 只按会话名索引会让另一个数据根接上别人的线程", async () => {
  resetChatSessions();
  const a = tmp(), b = tmp();
  const capA: Cap = { prompts: [] }, capB: Cap = { prompts: [] };
  // 两个数据根都用默认会话名(`default` 最容易撞)
  await chatSend({ repoRoot: REPO, dataRoot: a }, { session: "default", message: "甲的第一问" }, fakeCodex("好", capA));
  await chatSend({ repoRoot: REPO, dataRoot: b }, { session: "default", message: "乙的第一问" }, fakeCodex("好", capB));
  assert.equal(chatSessionCount(), 2, "两个数据根必须是两条线程");
  // 乙拿到的是**自己的**开场(说明没有接上甲那条线程),工作目录也在自己的数据根里
  assert.ok(capB.prompts[0]!.includes("对话模式"), "乙应该是新线程的第一轮");
  assert.ok(String(capB.opts!.workingDirectory).startsWith(path.resolve(b) + path.sep));
  // 同一个数据根再来一次才算续上
  await chatSend({ repoRoot: REPO, dataRoot: a }, { session: "default", message: "甲的第二问" }, fakeCodex("好", capA));
  assert.equal(capA.prompts[1], "甲的第二问", "同数据根同会话名 = 同一条线程");
  assert.equal(chatSessionCount(), 2);
});
