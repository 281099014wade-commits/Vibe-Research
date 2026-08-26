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
import fs from "node:fs";
import path from "node:path";

import { Codex, type CodexOptions, type Thread } from "@openai/codex-sdk";

import { GATE_PATTERNS, makeConfig, type RunConfig } from "./config.ts";
import { complianceGate } from "./gate.ts";
import { currentPlugin } from "./plugin.ts";
import { codexOptionsFor } from "./runner.ts";

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
    //    (「不要错过建仓机会」里"建仓"前四字含"不",会被误豁免,而那恰恰是建议)。
    //    合规判定只能偏严不能偏松 ⇒ 治因不治症:这里不给它可复述的词表。
    "4. 产出红线照旧:只呈现数据、框架、情景概率与裁决点,**不做任何交易动作层面的建议**。",
    "   讲这条规则本身时,用一句话概括就行,不要逐条复述被禁的说法。",
    `   (机器会复核:命中动作词的行整行移除 —— 共 ${GATE_PATTERNS.length} 条规则。)`,
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
  opts: { repoRoot: string; dataRoot?: string; python?: string },
  req: { session?: string; message: string },
  codexFactory: (o: CodexOptions) => Codex = (o) => new Codex(o),
): Promise<ChatTurnResult> {
  const session = String(req.session ?? "default");
  if (!SESSION_RE.test(session)) throw new ChatError("bad_session", `非法会话名 ${JSON.stringify(session).slice(0, 40)}`);
  const message = String(req.message ?? "").trim();
  if (!message) throw new ChatError("empty_message", "消息不能为空");
  if (message.length > MAX_MESSAGE) throw new ChatError("message_too_long", `消息过长(> ${MAX_MESSAGE} 字符)`);

  sweep();

  const cfg = makeConfig({
    symbol: "CHAT",
    repoRoot: opts.repoRoot,
    ...(opts.dataRoot ? { dataRoot: opts.dataRoot } : {}),
    ...(opts.python ? { python: opts.python } : {}),
    runId: `chat-${session}`,
  });

  // 🔴 会话表的键必须带上**真实数据根**,不能只用客户端给的会话名。
  //    线程一建好就绑定了某个数据根下的工作目录;只按会话名索引的话,
  //    另一个数据根用同名会话(`default` 尤其容易撞)会拿到上一条线程 ——
  //    既接着别人的上下文往下说,又在**别人的数据目录**里读文件。
  //    ⚠️ 用 `cfg.dataRoot` 而不是 `opts.dataRoot`:后者可以不传(由 makeConfig 兜底),
  //       拿没兜底的值组键,两次同义的调用会算出两把不同的键。
  //    分隔符用 NUL:会话名的字符集(SESSION_RE)不含它,拼不出歧义键。
  const sessionKey = `${path.resolve(cfg.dataRoot)}\u0000${session}`;
  let s = sessions.get(sessionKey);
  if (s && s.turns >= MAX_TURNS) {
    // 线程越长越贵、也越容易漂;到上限换一条新的
    sessions.delete(sessionKey);
    s = undefined;
  }

  if (!s) {
    const dir = sessionDir(cfg, session);
    const codex = codexFactory(codexOptionsFor(cfg));
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
      if (ev.type === "turn.failed") throw new ChatError("turn_failed", ev.error?.message ?? "对话失败");
      if (ev.type === "error") throw new ChatError("turn_failed", ev.message);
    }
  } catch (e) {
    if (e instanceof ChatError) throw e;
    if (ac.signal.aborted) throw new ChatError("timeout", `对话超时(${TURN_TIMEOUT_MS / 1000} 秒)`);
    throw new ChatError("turn_failed", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  s.turns += 1;
  s.lastUsed = Date.now();

  const { reply, redacted } = applyGate(raw);
  return { session, reply, redacted, duration_ms: Date.now() - t0 };
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
  // 🔴 **提示里不能回显命中的动作词** —— 我第一版写成"已移除(建仓)",
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
