/**
 * 对话能力 —— **接我们的底座,不碰密钥**。
 *
 * 🔴 与上游最大的不同就在这里。上游把用户的 API key 存在浏览器 localStorage、
 *    每个请求带着走;我们的密钥**只在后端环境变量里**,浏览器侧一个字节都不持有。
 *    ⇒ `LlmConfig` 这一套保留成同名同签名的空壳,只为让上游页面一行不用改;
 *      真正的模型配置在后端,「接入 AI」页只读地显示它。
 *
 * ⚠️ 我们的 `/chat` 是**一问一答不流式**的。`chatStream` 因此把整段回复作为一次
 *    `onDelta` 吐出去 —— 页面的逐字 UI 会变成"一次出现",功能不受影响。
 *    (真要逐字得在编排器上加 SSE;那是另一件事,没做就别假装在流式。)
 */
import { ApiError, backend, type ProductInfo } from "./backend";

export interface LlmConfig {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

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
 * 后端配置的缓存。
 * ⚠️ `hasLlm()` 在上游是**同步**的(页面渲染时直接调),而我们要问后端 ——
 *    所以模块加载时取一次放这儿。取到之前**乐观当作已配置**:
 *    宁可让用户点下去看到一条真实的错误,也不要在配置其实好着的时候先劝退他。
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
    /* 后端没起时保持乐观:真去用的时候会给出"连接不到编排器"的明确错误 */
  });

/** 后端当前的模型配置(只读投影,**不含密钥**);还没取到时为 null */
export const backendProvider = (): ProductInfo | null => cached;

export function loadLlm(): LlmConfig | null {
  if (!cached) return optimistic ? { provider: "backend", baseURL: "", apiKey: "", model: "" } : null;
  if (!cached.provider.key_present) return null;
  return {
    provider: cached.provider.name,
    baseURL: cached.provider.base_url ?? "",
    // 🔴 恒为空字符串。密钥不进浏览器 —— 这个字段只是为了让上游类型对得上。
    apiKey: "",
    model: String(cached.defaults.model ?? ""),
  };
}

/** 上游用它写配置。我们这儿配置在后端,前端**不允许写** —— 说清楚,不静默失败。 */
export function saveLlm(_cfg: LlmConfig): void {
  throw new ApiError("模型配置在后端(改配置文件 + 环境变量),界面不提供写入入口", 400, "read_only");
}

export function clearLlm(): void {
  throw new ApiError("模型配置在后端,界面不提供清除入口", 400, "read_only");
}

export function hasLlm(): boolean {
  return cached ? cached.provider.key_present : optimistic;
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
  const r = await backend.chat(message);
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
