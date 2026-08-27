/**
 * **自由对话通道**(Core)。
 *
 * 与「研究运行」是两件事,别混:
 * - 研究运行 = 六阶段状态机,产物带证据 id、可复算,写进知识层
 * - 对话     = 一问一答,**不产出证据、不写台账、不进知识层**
 *
 * 三条硬约束(都不是可选项):
 * ① 沙箱 `read-only` —— 对话线程**只读**。它可以看运行产物与台账来回答,但改不了任何东西。
 * ② 不联网、不联网搜索 —— 数据只能来自已落盘的产物。要新数据就去起一次研究运行,
 *    而不是让对话线程自己去抓(那会绕开整条取数纪律:没有 raw_ref、没有资料期、不可复算)。
 * ③ 回答过**同一套合规 gate** —— 产出红线对对话同样生效。
 *
 * 会话是进程内的:API 重启后对话历史就没了。这是刻意的 ——
 * 把对话落盘等于又建了一份"用户数据",而它的价值远不如研究产物,不值得那份持久化与迁移负担。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Codex, type CodexOptions, type Thread } from "@openai/codex-sdk";

import { gatePatterns, makeConfig, type RunConfig } from "./config.ts";
import { complianceGate } from "./gate.ts";
import { currentPlugin } from "./plugin.ts";
import { loadProductConfig } from "./productConfig.ts";
import { codexOptionsFor } from "./runner.ts";
import { RuntimeProviderError, resolveRuntimeProvider, type LlmOverride, type ResolvedRuntimeProvider } from "./runtime_provider.ts";

export class ChatError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

export interface ChatTurnResult {
  session: string;
  reply: string;
  /** 触发红线被移除的行数;0 = 原样返回 */
  redacted: number;
  duration_ms: number;
}

interface Session {
  thread: Thread;
  dir: string;
  turns: number;
  lastUsed: number;
}

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * 用户手打消息的上限。
 * ⚠️ **内部调用方可以经 `opts.maxMessage` 提高**(如多空辩论要带一份资料包进来)——
 *    `opts` 由服务层从 ctx 构造,**用户请求体到不了这里**,所以提高它不等于放开用户输入。
 */
const MAX_MESSAGE = 4_000;
const MAX_TURNS = 200;
/** 空闲多久回收会话(线程不再复用,下次提问重开) */
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const TURN_TIMEOUT_MS = 180_000;

const sessions = new Map<string, Session>();

function sweep(): void {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) sessions.delete(k);
}

/**
 * 对话线程的开场交代。**不重复宪法** —— AGENTS.md 由引擎按指令根自己加载;
 * 这里只说"这一轮是对话不是研究运行"这件宪法里没有的事。
 */
function preamble(): string {
  const p = currentPlugin();
  return [
    "你现在在**对话模式**,不是研究运行。规则与研究运行不同,请严格照做:",
    "",
    "1. **你没有网络,也不能取数**。能用的只有已经落盘的产物(runs/ 下的报告与证据、ledger/ 下用户自己写的记录)。",
    "   要新数据就告诉用户「去起一次研究运行」,**不要凭记忆报数字** —— 记忆里的行情与财务一律是过期的。",
    "2. **引用任何数字都要说清它从哪来**(哪次运行、哪条证据 id、什么资料期)。说不清出处的数字就别说。",
    "3. 不确定就说不确定。**「我不知道」是合格答案,编一个像样的答案不是。**",
    // 🔴 **别在这里列举禁用词**。实测:让模型复述"不给 XX、不给 YY"时,它照做,
    //    而 gate 是子串匹配 —— 一句"我不给 XX"照样命中 XX 被整行移除,用户看到的是自我介绍缺了半句。
    //    想过在 gate 里加"否定则豁免",**放弃了**:窗口式否定检测会被双重否定绕过
    //    (「不要错过某某机会」这类句子里,动作词前四字含"不",会被误豁免,而它恰恰是建议)。
    //    合规判定只能偏严不能偏松 ⇒ 治因不治症:这里不给它可复述的词表。
    "4. 产出红线照旧:只呈现数据、框架、情景概率与到期要判的点,**不做任何动作层面的建议**。",
    "   讲这条规则本身时,用一句话概括就行,不要逐条复述被禁的说法。",
    `   (机器会复核:命中动作词的行整行移除 —— 共 ${gatePatterns().length} 条规则。)`,
    `5. 这个垂类的阶段是:${p.stages.join(" → ")};用户问"研究流程"时按这个说。`,
    "",
    "回答用中文,简洁,别铺排。",
  ].join("\n");
}

function sessionDir(cfg: RunConfig, session: string): string {
  const dir = path.join(cfg.dataRoot, "chat", session);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 发一条消息,拿回答。
 * @param codexFactory 测试注入用;生产走真实 SDK
 */
export async function chatSend(
  opts: { repoRoot: string; dataRoot?: string; python?: string; maxMessage?: number },
  req: { session?: string; message: string; llm?: LlmOverride },
  codexFactory: (o: CodexOptions) => Codex = (o) => new Codex(o),
): Promise<ChatTurnResult> {
  const session = String(req.session ?? "default");
  if (!SESSION_RE.test(session)) throw new ChatError("bad_session", `非法会话名 ${JSON.stringify(session).slice(0, 40)}`);
  const message = String(req.message ?? "").trim();
  if (!message) throw new ChatError("empty_message", "消息不能为空");
  const maxMessage = Math.max(1, Math.min(Number(opts.maxMessage) || MAX_MESSAGE, 64_000));
  if (message.length > maxMessage) throw new ChatError("message_too_long", `消息过长(> ${maxMessage} 字符)`);

  sweep();

  // 🔴 **必须走 loadProductConfig,和 run.ts 同一条路**。
  //    直接 makeConfig 会拿 provider 的内置默认(openai)、providerProfile 恒为 null ⇒
  //    用户配了 DeepSeek / MiMo,研究运行认,而这条路**不认**:照样去打 OpenAI。
  //    表现是"研究能跑,对话报错",而且报的是别人家的错 —— 极难往配置上想。
  // ⚠️ 调用方给了 dataRoot 就整个按它走(用户配置 + provider 覆盖模板 + 数据根):
  //    只塞 userConfigPath 的话,配置从这个根读、模板却从 repoRoot 推的根找 —— 两套口径,静默不一致。
  // 🔴 请求自带 llm 时**不校验后端默认那份凭据**（`requireAuth: false`）：
  //    我们马上就要整份换掉 provider，后端默认有没有 key 与这一轮无关。
  //    不这么做的话，装机版用户（访达双击 ⇒ 没有 shell 环境 ⇒ 后端默认永远缺 key）
  //    即使在界面上填好了自己的 key，也会被一句"环境变量 MIMO_API_KEY 未设置"挡在门外 ——
  //    而这个功能存在的理由，正是让这种用户能把产品用起来。
  const pc = loadProductConfig(opts.repoRoot, {
    env: process.env,
    ...(opts.dataRoot ? { dataRootOverride: opts.dataRoot } : {}),
    ...(req.llm ? { requireAuth: false as const } : {}),
  });
  // 🔴 界面上选的那一份**覆盖**后端默认。key 只拼进一个临时 env 对象,
  //    配置文件 / 日志 / 账本一个字节都碰不到。
  // ⚠️ 解析失败要**当场抛**,不能悄悄回落到后端默认 —— 那会让用户以为在用自己选的模型,
  //    而账单和产出来自别处,且不会有任何提示。
  // 🔴 判据是"**传没传 llm**",不是"provider 填没填"。
  //    按 provider 非空来判的话,`{provider:"", apiKey:"…", baseURL:"…"}` 会**静默回落到后端默认** ——
  //    用户配了、界面显示已配置,请求却打到另一家,连 bad_provider 都收不到
  //    (Codex 审计 r1 P2;实测确认前端的有效性判定放得过这种形状)。
  //    provider 为空该由 resolveRuntimeProvider 抛 bad_provider,不由这里吞掉。
  let rt: ResolvedRuntimeProvider | null = null;
  if (req.llm) {
    try {
      rt = resolveRuntimeProvider(opts.repoRoot, opts.dataRoot ?? pc.resolved.dataRoot, req.llm);
    } catch (e) {
      throw new ChatError(
        e instanceof RuntimeProviderError ? e.code : "bad_llm",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const engineEnv = rt?.env ?? process.env;

  const cfg = makeConfig({
    symbol: "CHAT",
    repoRoot: opts.repoRoot,
    dataRoot: opts.dataRoot ?? pc.resolved.dataRoot,
    python: opts.python ?? pc.python ?? undefined,
    codexPath: pc.resolved.codexPath,
    codexHome: pc.resolved.codexHome,
    provider: rt ? { ...pc.provider, auth: rt.auth, env_key: rt.profile.env_key, name: rt.profile.id } : pc.provider,
    providerProfile: rt ? rt.profile : pc.providerProfile,
    // 🔴 用户配了自己的 provider 时，**绝不回落到后端默认模型** —— 那个模型名属于另一家
    //    （后端默认 mimo-v2.5 配上订阅档的登录态 = 一个根本不存在的组合）。
    //    用户没指定模型就什么都不传，让引擎按它自己的默认来。
    ...(rt ? (rt.model ? { model: rt.model } : {}) : pc.defaults.model ? { model: pc.defaults.model } : {}),
    runId: `chat-${session}`,
  });

  // 🔴 会话表的键必须带上**真实数据根**,不能只用客户端给的会话名。
  //    线程一建好就绑定了某个数据根下的工作目录;只按会话名索引的话,
  //    另一个数据根用同名会话(`default` 尤其容易撞)会拿到上一条线程 ——
  //    既接着别人的上下文往下说,又在**别人的数据目录**里读文件。
  //    ⚠️ 用 `cfg.dataRoot` 而不是 `opts.dataRoot`:后者可以不传(由 makeConfig 兜底),
  //       拿没兜底的值组键,两次同义的调用会算出两把不同的键。
  //    分隔符用 NUL:会话名的字符集(SESSION_RE)不含它,拼不出歧义键。
  // 🔴 键里还要带上**provider 指纹**。线程一建好,provider / 端点 / 认证 / 模型就全绑死在它上面了;
  //    用户中途改配置换成别家,只按"数据根+会话名"索引会**继续复用旧线程** ——
  //    请求正常返回,用户以为新配置生效了,实际还在打旧的那家,而且不会有任何报错
  //    (Codex 审计 mimo-r1 P1)。把指纹并进键里,配置一变自然就是新线程。
  // 🔴 指纹要对**真正传给引擎的那份东西**取哈希,不能手挑几个字段。
  //    手挑过一版(name|base_url|auth|model),漏了 wire_api / env_key / query_params /
  //    http_headers,连**轮换 API key** 都不体现 ⇒ 换了凭据仍复用旧线程、继续按旧身份计费
  //    (Codex 复审 mimo-r2 P1)。`codexOptionsFor(cfg)` 就是 `new Codex(...)` 收到的原物,
  //    它一变,线程就必须重开。
  // ⚠️ 这个哈希里含密钥派生值 ⇒ **只留在内存里当 Map 的键,永不落盘、永不进日志**。
  const providerFingerprint = crypto
    .createHash("sha256")
    // ⚠️ 指纹与下面建实例**必须用同一份 env**:只给其中一处传,
    //    换了 key 指纹却不变 ⇒ 继续复用旧线程、按旧凭据计费,而且不报错。
    .update(JSON.stringify(codexOptionsFor(cfg, engineEnv)))
    .digest("hex")
    .slice(0, 16);
  const sessionKey = `${path.resolve(cfg.dataRoot)}\u0000${providerFingerprint}\u0000${session}`;
  let s = sessions.get(sessionKey);
  if (s && s.turns >= MAX_TURNS) {
    // 线程越长越贵、也越容易漂;到上限换一条新的
    sessions.delete(sessionKey);
    s = undefined;
  }

  if (!s) {
    const dir = sessionDir(cfg, session);
    const codex = codexFactory(codexOptionsFor(cfg, engineEnv));
    const thread = codex.startThread({
      // 工作目录必须在**指令根**之下,否则宪法与 skills 加载不到 —— 而引擎**不会报错**(见 instructions_root.ts)
      workingDirectory: dir,
      sandboxMode: "read-only", // 🔴 对话只读:它能看产物,改不了任何东西
      skipGitRepoCheck: true, // 数据目录不是 git 仓库;这道门保护不到任何东西(同 runner.ts 的说明)
      networkAccessEnabled: false, // 🔴 不联网:数据只能来自已落盘产物,别绕开取数纪律
      approvalPolicy: "never",
      webSearchMode: "disabled",
      model: cfg.model ?? cfg.providerProfile?.default_model ?? undefined,
    });
    s = { thread, dir, turns: 0, lastUsed: Date.now() };
    sessions.set(sessionKey, s);
  }

  const prompt = s.turns === 0 ? `${preamble()}\n\n---\n\n${message}` : message;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);
  let raw = "";
  try {
    const { events } = await s.thread.runStreamed(prompt, { signal: ac.signal });
    for await (const ev of events) {
      if (ev.type === "item.completed" && ev.item.type === "agent_message") raw = ev.item.text ?? raw;
      // ⚠️ 引擎的报错会把请求细节带回来（实测见过整条端点 URL）。**报错路径也要抹 key**：
      //    只抹回答不抹报错，等于留了一条同样通向界面与日志的口子。
      if (ev.type === "turn.failed") throw new ChatError("turn_failed", scrubKey(ev.error?.message ?? "对话失败", rt));
      if (ev.type === "error") throw new ChatError("turn_failed", scrubKey(ev.message, rt));
    }
  } catch (e) {
    if (e instanceof ChatError) throw e;
    if (ac.signal.aborted) throw new ChatError("timeout", `对话超时(${TURN_TIMEOUT_MS / 1000} 秒)`);
    throw new ChatError("turn_failed", scrubKey(e instanceof Error ? e.message : String(e), rt));
  } finally {
    clearTimeout(timer);
  }
  s.turns += 1;
  s.lastUsed = Date.now();

  const { reply, redacted } = applyGate(scrubKey(raw, rt));
  return { session, reply, redacted, duration_ms: Date.now() - t0 };
}

/**
 * 把用户这次给的 key 从**要送出去的文本**里抹掉。
 *
 * 🔴 界面上写着"不进日志、不入台账"。对话线程不联网，所以 key 出不了这台机器；
 *    但它**能被写进回答**（提示注入让它 `env` 一下就够了），而回答上有个「存入沉淀」按钮
 *    —— 一点就落进台账文件。那条承诺就是在这里破的。
 * ⚠️ 只抹这次请求带来的那一份：不做通用 `sk-\w+` 之类的猜测式匹配，
 *    那会把用户正常讨论的内容也抹掉，还给人一种"什么密钥都拦得住"的错觉。
 */
function scrubKey(text: string, rt: ResolvedRuntimeProvider | null): string {
  const key = rt ? String(rt.env[rt.profile.env_key] ?? "") : "";
  // 太短的当没有:极短字符串会在正常文本里到处误命中
  if (key.length < 8 || !text.includes(key)) return text;
  return text.split(key).join("[已移除:你的 API key]");
}

/**
 * 合规 gate。
 * 🔴 命中时**只移除那几行**,不整段丢弃 —— gate 是子串匹配、有已知误判
 *    (陈述别人的动作、或声明"本产品不做某事",都可能命中同一个词)。
 *    整段拦下会把一个有用的回答变成一句空话,而用户看不出是误判还是真违规。
 *    被移除的行**显式标出来**,让用户知道这里少了东西、以及为什么。
 */
function applyGate(text: string): { reply: string; redacted: number } {
  if (!text.trim()) return { reply: "(没有拿到回答)", redacted: 0 };
  const g = complianceGate(text);
  if (g.ok) return { reply: text, redacted: 0 };
  const bad = new Map<number, string>();
  for (const h of g.hits) bad.set(h.line, h.pattern);
  // 🔴 **提示里不能回显命中的动作词** —— 我第一版写成"已移除(某动作词)",
  //    那等于把 gate 刚挡掉的词原样放回输出(自己的测试当场抓到)。
  //    命中详情只进服务端日志,给排查用;用户看到的是"这里少了一行、以及为什么"。
  //    仓库里 fetchrun.ts 早有同样做法:替换成〔动作词〕而不是原词。
  if (bad.size) {
    console.error(`[chat] 合规 gate 移除 ${bad.size} 行:${[...bad.entries()].map(([ln, p]) => `L${ln}=${p}`).join(", ")}`);
  }
  const lines = text.split(/\r?\n/).map((l, i) =>
    bad.has(i + 1) ? "〔该行触发产出红线,已移除〕" : l,
  );
  return { reply: lines.join("\n"), redacted: bad.size };
}

/** 诊断用:当前有几个活动会话 */
export function chatSessionCount(): number {
  sweep();
  return sessions.size;
}

/** 测试用:清空会话 */
export function resetChatSessions(): void {
  sessions.clear();
}
