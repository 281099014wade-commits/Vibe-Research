import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts"; // 测试文件也是入口:插件要先注册
import { ChatError, chatSend, chatSessionCount, resetChatSessions } from "../src/chat.ts";
import type { LlmOverride } from "../src/runtime_provider.ts";

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

test("🔴 换了 provider 就不能再复用旧线程 —— 线程把端点/认证/模型全绑死了,复用等于「配置改了但没生效」", async () => {
  resetChatSessions();
  const root = tmp();
  const capA: Cap = { prompts: [] }, capB: Cap = { prompts: [] };
  const cfgFile = path.join(root, "config.json");

  await chatSend({ repoRoot: REPO, dataRoot: root }, { session: "default", message: "第一问" }, fakeCodex("好", capA));
  assert.equal(chatSessionCount(), 1);

  // 用户改配置换成 mimo(它有自己的 base_url / 默认模型)
  fs.writeFileSync(cfgFile, JSON.stringify({ provider: { profile: "mimo", auth: "api_key" } }));
  process.env.MIMO_API_KEY = "k-for-test-0123456789";
  try {
    await chatSend({ repoRoot: REPO, dataRoot: root }, { session: "default", message: "第二问" }, fakeCodex("好", capB));
  } finally {
    delete process.env.MIMO_API_KEY;
  }
  assert.equal(chatSessionCount(), 2, "换 provider 必须是一条新线程,不能续用旧的");
  assert.equal(capB.opts!.model, "mimo-v2.5", "新线程要用新 provider 的模型");
  assert.ok(capB.prompts[0]!.includes("对话模式"), "新线程从第一轮开始(说明没有接上旧线程)");
});

test("🔴 指纹要覆盖**真正传给引擎的整份配置** —— 手挑几个字段会漏掉轮换密钥这种情况", async () => {
  resetChatSessions();
  const root = tmp();
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: { profile: "mimo", auth: "api_key" } }));
  const send = (cap: Cap) => chatSend({ repoRoot: REPO, dataRoot: root }, { session: "default", message: "问" }, fakeCodex("好", cap));

  process.env.MIMO_API_KEY = "key-AAAAAAAAAAAAAAAA";
  try {
    await send({ prompts: [] });
    assert.equal(chatSessionCount(), 1);
    await send({ prompts: [] });
    assert.equal(chatSessionCount(), 1, "同样配置要复用同一条线程");
    // 轮换密钥:name / base_url / auth / model 一个都没变 —— 手挑字段的指纹在这里完全看不出区别
    process.env.MIMO_API_KEY = "key-BBBBBBBBBBBBBBBB";
    await send({ prompts: [] });
    assert.equal(chatSessionCount(), 2, "换了密钥必须重开线程,否则继续按旧凭据计费");
  } finally {
    delete process.env.MIMO_API_KEY;
  }
});

// ── 用户在界面上自己配的模型（按请求带下来的 llm） ─────────────────────────

test("llm 覆盖:换 key / 换 provider 都要重开线程 —— 同一份配置才复用", async () => {
  resetChatSessions();
  const root = tmp();
  const send = (llm: LlmOverride) =>
    chatSend({ repoRoot: REPO, dataRoot: root }, { session: "default", message: "问", llm }, fakeCodex("好", { prompts: [] }));

  const mimo = { provider: "mimo", apiKey: "key-AAAAAAAAAAAA", baseURL: "https://gw.example.com/v1", model: "mimo-v2.5" };
  await send(mimo);
  assert.equal(chatSessionCount(), 1);
  await send(mimo);
  assert.equal(chatSessionCount(), 1, "同样配置要复用同一条线程");

  // 🔴 只换 key:provider / 端点 / 模型全没变。指纹要是没覆盖到密钥,
  //    这里会**静默复用旧线程、继续按旧凭据计费**,而且请求正常返回、不报错。
  await send({ ...mimo, apiKey: "key-BBBBBBBBBBBB" });
  assert.equal(chatSessionCount(), 2, "换了 key 必须重开线程");

  await send({ ...mimo, provider: "deepseek" });
  assert.equal(chatSessionCount(), 3, "换了 provider 必须重开线程");
});

test("llm 覆盖:key 只进引擎的临时 env,不改动本进程环境", async () => {
  resetChatSessions();
  const before = process.env.DEEPSEEK_API_KEY;
  await chatSend(
    { repoRoot: REPO, dataRoot: tmp() },
    { session: "t-env", message: "问", llm: { provider: "deepseek", apiKey: "sk-user-supplied-000" } },
    fakeCodex("好", { prompts: [] }),
  );
  // 🔴 用户的 key 是**一次性**的:落进 process.env 就等于泄漏给同进程里所有别的活
  assert.equal(process.env.DEEPSEEK_API_KEY, before, "不许把用户的 key 写进本进程环境");
});

test("🔴 用户配了自己的 provider 时,绝不回落到后端默认模型（那是另一家的模型名）", async () => {
  resetChatSessions();
  const root = tmp();
  // 后端默认 = mimo-v2.5
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ defaults: { model: "mimo-v2.5" } }));

  const capCli: Cap = { prompts: [] };
  await chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t-cli", message: "问", llm: { provider: "cli-codex", model: "随便写的名字" } }, fakeCodex("好", capCli));
  // 订阅档的模型由登录态决定。把界面上那个 id 当模型名发出去,真实报错是
  // "The 'x' model is not supported when using Codex with a ChatGPT account"（实测撞过）；
  // 回落到后端默认的 mimo-v2.5 更糟 —— 那是另一家的模型名配上订阅登录态。
  assert.equal(capCli.opts!.model, undefined, "订阅档不该带任何模型名");

  const capApi: Cap = { prompts: [] };
  await chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t-api", message: "问", llm: { provider: "deepseek", apiKey: "k" } }, fakeCodex("好", capApi));
  assert.equal(capApi.opts!.model, "deepseek-v4-flash", "没指定模型时用**该 provider 模板**的默认模型,不是后端默认");
});

test("llm 覆盖:配置不对时报出可行动的错误码,而不是悄悄换一家去打", async () => {
  const root = tmp();
  const bad = async (llm: LlmOverride, want: string) => {
    resetChatSessions();
    await assert.rejects(
      () => chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t-bad", message: "问", llm }, fakeCodex("好", { prompts: [] })),
      (e: unknown) => e instanceof ChatError && e.code === want,
      `${JSON.stringify(llm)} 应报 ${want}`,
    );
  };
  await bad({ provider: "cli-claude" }, "unsupported_cli");
  await bad({ provider: "nosuchvendor", apiKey: "k" }, "unknown_provider");
  await bad({ provider: "deepseek" }, "missing_key");
  await bad({ provider: "qwen", apiKey: "k" }, "needs_base_url");
  await bad({ provider: "custom", apiKey: "k", baseURL: "file:///etc/passwd" }, "bad_base_url");
});

test("🔴 传了 llm 但 provider 为空 —— 必须报错，不许静默回落到后端默认", async () => {
  resetChatSessions();
  const root = tmp();
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: { profile: "mimo", auth: "api_key" } }));
  // 前端的有效性判定放得过这种形状（provider 空 + baseURL/key/model 齐全），
  // 按"provider 填没填"来判的话，这里会悄悄用后端默认那家去打 —— 界面上显示"已配置"，
  // 请求却落到别处，连 bad_provider 都收不到。
  for (const p of ["", "   "]) {
    await assert.rejects(
      () => chatSend(
        { repoRoot: REPO, dataRoot: root },
        { session: "t-empty", message: "问", llm: { provider: p, apiKey: "k", baseURL: "https://x.example.com/v1", model: "m" } },
        fakeCodex("好", { prompts: [] }),
      ),
      (e: unknown) => e instanceof ChatError && e.code === "bad_provider",
      `provider=${JSON.stringify(p)} 应报 bad_provider`,
    );
  }
});

test("🔴 用户的 key 不许出现在回答或报错里 —— 回答上有「存入沉淀」，一点就落盘", async () => {
  const root = tmp();
  const KEY = "sk-user-secret-1234567890";
  const llm = { provider: "deepseek", apiKey: KEY, model: "deepseek-v4-flash" };

  resetChatSessions();
  // 模型把 key 念了出来（提示注入让它 `env` 一下就够了）
  const r = await chatSend(
    { repoRoot: REPO, dataRoot: root },
    { session: "t-scrub", message: "问", llm },
    fakeCodex(`你的密钥是 ${KEY} 哦`, { prompts: [] }),
  );
  assert.ok(!r.reply.includes(KEY), `回答里还有 key：${r.reply}`);
  assert.ok(r.reply.includes("已移除"), "抹掉了要留个痕，别让人以为模型没说");

  resetChatSessions();
  // 报错路径同样要抹 —— 只抹回答不抹报错，等于留了条同样通向界面与日志的口子
  const boom = () =>
    ({
      startThread: () => ({
        id: "t",
        runStreamed: () => Promise.reject(new Error(`401 Unauthorized key=${KEY}`)),
      }),
    }) as never;
  await assert.rejects(
    () => chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t-scrub2", message: "问", llm }, boom),
    (e: unknown) => e instanceof ChatError && !e.message.includes(KEY),
    "报错消息里不许带 key",
  );
});

test("🔴 装机版场景：后端默认缺 key，但用户自己配了 —— 必须能用", async () => {
  resetChatSessions();
  const root = tmp();
  // 访达双击启动的 App 没有 shell 环境 ⇒ 后端默认那份 api_key 永远缺席
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: { profile: "mimo", auth: "api_key" } }));
  const before = process.env.MIMO_API_KEY;
  delete process.env.MIMO_API_KEY;
  try {
    // 不带 llm：照旧应当拒绝（这条路本来就要求环境变量）
    await assert.rejects(
      () => chatSend({ repoRoot: REPO, dataRoot: root }, { session: "t-noenv", message: "问" }, fakeCodex("好", { prompts: [] })),
      /MIMO_API_KEY 未设置/,
    );
    // 带 llm：后端默认缺不缺 key 与这一轮无关，必须放行
    const r = await chatSend(
      { repoRoot: REPO, dataRoot: root },
      { session: "t-own", message: "问", llm: { provider: "deepseek", apiKey: "sk-mine-000000", model: "deepseek-v4-flash" } },
      fakeCodex("好", { prompts: [] }),
    );
    assert.equal(r.reply, "好");
  } finally {
    if (before === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = before;
  }
});
