/**
 * 用户的模型配置（**只存本地 localStorage，不上传、不进仓库**）+ 对话调用。
 *
 * 🔴 口径与开源版 Vibe-Research 对齐 —— 那一份经过真实用户验证：
 *    用户在「接入 AI」页选模型、粘自己的 key → 存本地 → **随请求发给本机后端** →
 *    后端把它拼进一个临时 env 交给引擎。**配置文件 / 日志 / 账本一个字节都碰不到。**
 *
 * ⚠️ 上一版的口径是「密钥只从环境变量读，界面只读」。那在终端里启动时没问题，
 *    但只依赖启动服务前配置 shell 环境，浏览器 UI 里就没有可操作的接入入口。
 *    「不进配置文件」这条纪律在新做法下照样成立（localStorage 不是仓库文件，key 也不进后端落盘）。
 *
 * ⚠️ 没配用户配置时**回落到后端默认**（`.local/config.json` + 环境变量那一套）——
 *    Simon 自己在终端里跑的那条路不受影响。
 */
import { ApiError, backend, type ProductInfo } from "./backend";
import { parseHeadlineTranslations, type HeadlineTranslationInput } from "./headlineTranslation";
import { clearUserLlm, loadUserLlm, saveUserLlm, type LlmConfig } from "./llmStore";

export type { LlmConfig };
// ⚠️ 存取一律走 llmStore —— 这里再抄一份实现，迟早两边判定不一致
export { loadUserLlm };

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  /** 上游用它显示"AI 调了哪些数据工具"。我们的对话线程不联网、不调工具,恒为空 */
  trace: { tool: string; args: Record<string, unknown> }[];
  rounds: number;
}

export interface ChatHandlers {
  onDelta?: (text: string) => void;
  onTool?: (tool: string, args: Record<string, unknown>) => void;
}

/**
 * 后端默认配置的缓存（用户没配时的回落）。
 * ⚠️ `hasLlm()` 是**同步**的（页面渲染时直接调），而问后端是异步的 ——
 *    所以模块加载时取一次放这儿。取到之前**乐观当作已配置**：
 *    宁可让用户点下去看到一条真实的错误，也不要在配置其实好着的时候先劝退他。
 */
let cached: ProductInfo | null = null;
let optimistic = true;

void backend
  .product()
  .then((p) => {
    cached = p;
    optimistic = p.provider.key_present;
  })
  .catch(() => {
    /* 后端没起时保持乐观：真去用的时候会给出"连接不到编排器"的明确错误 */
  });

/** 后端当前的模型配置（只读投影，**不含密钥**）；还没取到时为 null */
export const backendProvider = (): ProductInfo | null => cached;

export function saveLlm(cfg: LlmConfig): void {
  try {
    saveUserLlm(cfg);
  } catch (e) {
    // 🔴 存不下要**说出来**：静默失败会让用户以为配好了，下次打开又是空的
    throw new ApiError(`本地存储写不进去（${e instanceof Error ? e.message : String(e)}）—— 配置没保存`, 500, "storage_failed");
  }
}

export function clearLlm(): void {
  clearUserLlm();
}

/**
 * 有没有可用的模型。用户自己配了算，后端默认配好了也算。
 * ⚠️ 两条路都不通才算没有 —— 只看其中一条会误判。
 */
export function hasLlm(): boolean {
  if (loadUserLlm()) return true;
  return cached ? cached.provider.key_present : optimistic;
}

/** 兼容上游签名：上游的 `loadLlm()` 语义是"当前生效的配置"。 */
export function loadLlm(): LlmConfig | null {
  const mine = loadUserLlm();
  if (mine) return mine;
  if (!cached) return optimistic ? { provider: "backend", baseURL: "", apiKey: "", model: "" } : null;
  if (!cached.provider.key_present) return null;
  return {
    provider: cached.provider.name,
    baseURL: cached.provider.base_url ?? "",
    apiKey: "",                       // 后端那条路的密钥本来就不进浏览器
    model: String(cached.defaults.model ?? ""),
  };
}

/**
 * 发一轮对话。
 * ⚠️ `context` 拼在问题前面 —— 上游用它把"当前这一页在看什么"带进去。
 * ⚠️ 只发**最后一条用户消息** + 上下文:我们的 `/chat` 自己按 session 维护历史,
 *    把整段 history 再发一遍会重复计入。
 */
export async function chatStream(
  messages: ChatMsg[],
  context: string,
  handlers: ChatHandlers = {},
  signal?: AbortSignal,
): Promise<ChatResult> {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) throw new ApiError("没有要问的内容", 400, "empty_message");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const message = context ? `【当前页面的数据】\n${context}\n\n【问题】\n${last.content}` : last.content;
  // ⚠️ 用户那份由 `backend.chat` 自己带上（见 llmStore.ts 里那条"防线只守一个入口等于没有"）
  const r = await backend.chat(message, "default", signal);
  // 用户中途关面板 / 换问题:结果照样回来了,但不往界面上写(与上游 abort 行为一致)
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const content = r.redacted
    ? `${r.reply}\n\n> ⚠️ 有 ${r.redacted} 行触发产出红线被移除(不给操作建议)。`
    : r.reply;
  handlers.onDelta?.(content);
  return { content, trace: [], rounds: 1 };
}

export function chat(messages: ChatMsg[], context: string): Promise<ChatResult> {
  return chatStream(messages, context);
}

/**
 * Investment News 的专用标题翻译。
 *
 * 不复用 `default` 对话会话：后端为每一批开独立线程，并把翻译规则放在
 * developer 指令层，RSS 标题只作为 JSON 数据进入用户层。
 */
export async function translateHeadlineBatch(
  items: HeadlineTranslationInput[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  if (!items.length) return new Map();
  const r = await backend.translateHeadlines(items, signal);
  // 后端已经逐条移除触发红线的译文；其余安全条目必须保留，不能因一条而丢整批。
  // 被移除的 id 自然缺席，页面会把那几条保留成英文并显示 partial。
  return parseHeadlineTranslations(JSON.stringify({ items: r.items }), items);
}
