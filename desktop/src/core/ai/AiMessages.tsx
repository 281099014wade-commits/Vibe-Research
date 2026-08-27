/**
 * 对话气泡区 —— 抽屉与底部控制台共用这一份渲染。
 *
 * 🔴 回答按 markdown 渲染、提问按纯文本：模型答的是带 **加粗**、列表、表格的正文，
 *    当纯文本贴出来就是一屏星号（看着像模型答坏了，其实是没渲染）；
 *    而用户打的字里出现 markdown 记号是巧合，不该被解释成格式。
 */
import { type ReactNode, useEffect, useRef } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/cn";
import type { AiMsg } from "./useAiChat";

export interface AiMessagesProps {
  msgs: AiMsg[];
  loading: boolean;
  err: string | null;
  /** 空对话时那条说明（免责声明一类，行业相关，由垂类给） */
  notice: string;
  /** 空对话时可点的问题 */
  suggestions?: string[];
  onPick?: (s: string) => void;
  /** 每条回答下面挂什么（例如"存进记录"）。Core 不认识这些，垂类给 */
  renderReplyActions?: (reply: string, question: string) => ReactNode;
  className?: string;
}

export function AiMessages({
  msgs, loading, err, notice, suggestions = [], onPick, renderReplyActions, className,
}: AiMessagesProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading]);

  return (
    <div ref={ref} className={cn("flex-1 space-y-3 overflow-auto p-4 text-sm", className)}>
      {msgs.length === 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
          {notice}
        </div>
      )}
      {msgs.map((m, i) => (
        <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
          <div className={cn(
            "max-w-[85%] rounded-2xl px-3 py-2 leading-relaxed",
            m.role === "user" ? "bg-primary/20 text-foreground" : "bg-muted/40 text-foreground",
          )}>
            {m.role === "assistant" ? (
              <div className="prose prose-sm dark:prose-invert max-w-none break-words text-foreground">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
            )}
            {m.role === "assistant" && m.content && !(loading && i === msgs.length - 1) &&
              renderReplyActions?.(m.content, msgs[i - 1]?.content ?? "")}
          </div>
        </div>
      ))}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> AI 正在想…
        </div>
      )}
      {err && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {err}
        </div>
      )}
      {msgs.length === 0 && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {suggestions.map((s) => (
            <button key={s} onClick={() => onPick?.(s)}
              className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs hover:border-primary/40 hover:text-primary">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 输入条：两个外壳共用（Enter 发送、Shift+Enter 换行） */
export function AiComposer({
  placeholder, disabled, onSend,
}: { placeholder: string; disabled: boolean; onSend: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fire = () => {
    const v = ref.current?.value ?? "";
    if (!v.trim() || disabled) return;
    onSend(v);
    if (ref.current) ref.current.value = "";
  };
  return (
    <div className="border-t border-border/60 p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          onKeyDown={(e) => {
            // 🔴 中文输入法**选字期间**的 Enter 是"确认候选词"，不是"发送"。
            //    不挡的话，打到一半按回车会把没成词的拼音直接发出去并清空输入框 ——
            //    对中文用户是每天都会撞到的。`isComposing` 只在原生事件上有。
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              fire();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="flex-1 resize-none rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
        />
        <button onClick={fire} disabled={disabled}
          className="rounded-lg bg-primary/15 px-3 py-2 text-primary hover:bg-primary/25 disabled:opacity-40">
          发送
        </button>
      </div>
    </div>
  );
}
