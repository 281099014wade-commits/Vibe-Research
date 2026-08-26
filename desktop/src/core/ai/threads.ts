/**
 * 底部控制台的**聊天记录**：一条条历史对话，能翻回去看。
 *
 * 每条对话的消息本身仍由 `useAiChat` 按 key 存（`vr-ai-chat:<id>`）；
 * 这里只管**目录**：有哪些对话、叫什么、最近什么时候聊的。
 *
 * 🔴 目录与内容是两份数据，删的时候**必须一起删** —— 只删目录会留下永远读不到的孤儿，
 *    只删内容会留下点开是空的条目。所以删除只走这里的 `removeThread`。
 */
import { dropChat } from "./useAiChat";

const LIST_KEY = "vr-ai-threads";
/** 目录里最多留这么多条。**只裁目录不动内容会留下孤儿** ⇒ 裁掉的同时把内容也删了 */
const MAX_THREADS = 50;
const TITLE_MAX = 40;

export interface AiThread {
  id: string;
  title: string;
  /** 毫秒时间戳 */
  updatedAt: number;
}

const read = (): AiThread[] => {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];   // 被改坏 / 旧版本：当没有，别让页面崩
    return parsed.filter(
      (t): t is AiThread =>
        !!t && typeof t === "object" &&
        typeof (t as AiThread).id === "string" &&
        typeof (t as AiThread).title === "string" &&
        typeof (t as AiThread).updatedAt === "number",
    );
  } catch {
    return [];
  }
};

const write = (list: AiThread[]): void => {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    /* 存不下就这次不记；不影响当前这条对话能不能用 */
  }
};

/** 按最近聊过的排前面 */
export function listThreads(): AiThread[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function newThreadId(): string {
  // 不用 crypto.randomUUID：老 WebView 上没有，而这里只需要"不重"，不需要密码学强度
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 记一笔"这条对话刚聊过"。`title` 只在**还没有标题时**写入 ——
 * 用第一句话当标题，后面再聊也不改，免得列表里的名字一直在变、找不回昨天那条。
 */
export function touchThread(id: string, title: string, now = Date.now()): AiThread[] {
  const list = read();
  const i = list.findIndex((t) => t.id === id);
  const clean = title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  if (i >= 0) {
    list[i] = { ...list[i]!, updatedAt: now, title: list[i]!.title || clean };
  } else {
    list.push({ id, title: clean, updatedAt: now });
  }
  const kept = list.sort((a, b) => b.updatedAt - a.updatedAt);
  // 超出上限的连同内容一起删（见文件头：目录与内容必须同进同退）
  for (const gone of kept.slice(MAX_THREADS)) dropChat(gone.id);
  const head = kept.slice(0, MAX_THREADS);
  write(head);
  return head;
}

export function removeThread(id: string): AiThread[] {
  const left = read().filter((t) => t.id !== id);
  write(left);
  dropChat(id);
  return left.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 列表上显示的相对时间。**只到"天"** —— 更细的精度对"翻回去找那条"没有帮助 */
export function whenLabel(ts: number, now = Date.now()): string {
  const d = Math.floor((now - ts) / 86400000);
  if (d <= 0) return "今天";
  if (d === 1) return "昨天";
  if (d < 7) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
