import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Sparkles, X, Settings, Send, Loader2, Wrench, AlertCircle, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { hasLlm, chatStream, type ChatMsg } from "@/lib/llm";
import { ApiError } from "@/lib/api";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { storageGet, storageSet, storageRemove } from "@/lib/storage";

// 对话持久化（#19）。此前 msgs 只是组件内的 useState：切页面卸载、刷新、
// 关标签页，问过的东西全没了——用户反馈「关闭 AI 就找不回之前的对话」，
// 而每轮对话是花了自己 API 额度换来的，丢掉的是真金白银。
//
// 按路由分开存：不同页面的「问 AI」上下文不同（个股页 vs 板块页），
// 混在一起会把上一页的对话带到下一页，比不存更让人困惑。
const CHAT_KEY_PREFIX = "vr-askai-chat:";
// 单页对话上限。localStorage 总配额约 5MB，而一轮研报级回答可能上万字；
// 不设上限迟早写爆，届时 storageSet 静默失败、用户以为存上了。
const MAX_PERSISTED_MSGS = 40;

type StoredMsg = ChatMsg & { tools?: ToolUse[] };

function loadChat(key: string): StoredMsg[] {
  const raw = storageGet(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // 存量数据可能来自旧版本或被手工改坏，形状不对就当没有，别让页面崩。
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is StoredMsg =>
        m && typeof m === "object" && typeof m.content === "string" &&
        (m.role === "user" || m.role === "assistant"),
    );
  } catch {
    return [];
  }
}

function saveChat(key: string, msgs: StoredMsg[]): void {
  if (!msgs.length) {
    storageRemove(key);
    return;
  }
  storageSet(key, JSON.stringify(msgs.slice(-MAX_PERSISTED_MSGS)));
}

interface Props {
  // 本分栏/本页要喂给用户 AI 的上下文，作为对话的系统上下文。
  context: string;
  suggestions?: string[];
  label?: string;
}

const TOOL_LABEL: Record<string, string> = {
  query_quote: "查行情",
  query_valuation: "查估值",
  query_reports: "查研报",
  query_news: "查新闻",
};

// 数据溯源：把工具调用的关键参数压成一小段（查了哪只/哪些代码）。
const argStr = (a: Record<string, unknown>): string => {
  if (Array.isArray(a.codes)) return (a.codes as unknown[]).join(",");
  if (typeof a.code === "string") return a.code;
  return "";
};

interface ToolUse { name: string; arg: string }

// 「问 AI」入口 —— 把当前分栏内容作为上下文，调用户自己配置的模型；
// AI 可自行调 A股数据工具作答。结论由用户模型给出，本产品不校准、不负责。
export function AskAiButton({ context, suggestions = [], label = "问 AI" }: Props) {
  const { pathname } = useLocation();
  const chatKey = CHAT_KEY_PREFIX + pathname;

  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  // 惰性初始化：首帧就带上已存的对话，避免先渲染空列表再闪一下补上。
  const [msgs, setMsgs] = useState<StoredMsg[]>(() => loadChat(chatKey));
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 在跑的流式请求：关面板/换问题时中止，省用户的订阅/API 额度，也防迟到 chunk 写进新气泡
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) setConfigured(hasLlm());
  }, [open]);

  // 换页面 = 换一份对话（key 变了），把当前这页已存的读进来。
  useEffect(() => {
    setMsgs(loadChat(chatKey));
  }, [chatKey]);

  // 每次消息变动落盘。流式回答期间会频繁触发，但写的是同一个 key、
  // 数据量小，且 storageSet 已对配额异常兜底，代价可接受。
  useEffect(() => {
    saveChat(chatKey, msgs);
  }, [chatKey, msgs]);

  useEffect(() => () => abortRef.current?.abort(), []); // 组件卸载兜底

  const clearChat = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setErr(null);
    setMsgs([]);          // saveChat 见空数组会 storageRemove，不留空壳
  };

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setOpen(false);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setInput("");
    setErr(null);
    const history: ChatMsg[] = [...msgs.map(({ role, content }) => ({ role, content })), { role: "user", content: q }];
    // 先放用户气泡 + 一个空的 assistant 气泡，流式往里填。
    setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "", tools: [] }]);
    setLoading(true);
    // 更新「最后一条 assistant 气泡」（不可变）。
    const patchLast = (fn: (msg: ChatMsg & { tools?: ToolUse[] }) => ChatMsg & { tools?: ToolUse[] }) =>
      setMsgs((m) => m.map((msg, i) => (i === m.length - 1 && msg.role === "assistant" ? fn(msg) : msg)));
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // 只有仍是「当前这次请求」才允许写 UI——旧请求的迟到 chunk 直接丢弃
    const alive = () => abortRef.current === ac && !ac.signal.aborted;
    try {
      await chatStream(history, context, {
        onTool: (tool, args) => { if (alive()) patchLast((msg) => ({ ...msg, tools: [...(msg.tools || []), { name: tool, arg: argStr(args) }] })); },
        onDelta: (t) => { if (alive()) patchLast((msg) => ({ ...msg, content: msg.content + t })); },
      }, ac.signal);
    } catch (e) {
      // 出错/中止：去掉尾部空 assistant 气泡；主动中止不算错误，不提示
      setMsgs((m) => m.filter((msg, i) => !(i === m.length - 1 && msg.role === "assistant" && !msg.content)));
      if (!ac.signal.aborted) setErr(e instanceof ApiError ? e.message : "对话失败");
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-1.5 text-sm font-medium text-primary shadow-glow transition-colors hover:bg-primary/25"
      >
        <Sparkles className="h-4 w-4" />
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={close} />
          <aside className="glass relative m-3 flex w-full max-w-md flex-col rounded-2xl">
            <div className="flex items-center justify-between border-b border-border/60 p-4">
              <span className="flex items-center gap-2 font-semibold text-glow">
                <Sparkles className="h-4 w-4 text-primary" /> 问 AI · 本页上下文
              </span>
              <div className="flex items-center gap-1">
                {msgs.length > 0 && (
                  // 存了就得能删：对话留在本机 localStorage，用户得有办法清掉。
                  <button
                    onClick={clearChat}
                    title="清空本页对话"
                    aria-label="清空本页对话"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                <button onClick={close} className="text-muted-foreground hover:text-foreground" aria-label="关闭">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {!configured ? (
              // 未接入 AI：引导去设置
              <div className="flex-1 space-y-4 overflow-auto p-4 text-sm">
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                  分析结论由你自己配置的 AI 给出，本产品只负责把本页数据打包成上下文、并让 AI 能调数据工具，
                  <b className="text-foreground">不校准、不背书、不对结果负责</b>。
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">将随提问发给 AI 的本页上下文：</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
{context}
                  </pre>
                </div>
                <Link to="/settings" className="flex items-center justify-center gap-2 rounded-lg bg-primary/15 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/25">
                  <Settings className="h-4 w-4" /> 先接入你的 AI（订阅 / API）
                </Link>
              </div>
            ) : (
              // 已接入：真对话
              <>
                <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-4 text-sm">
                  {msgs.length === 0 && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                      AI 可基于本页上下文、并自行调取 A股行情/估值/研报数据作答。结论由你的模型给出，
                      <b className="text-foreground">不构成投资建议</b>。
                    </div>
                  )}
                  {msgs.map((m, i) => (
                    <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                      <div className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 leading-relaxed",
                        m.role === "user" ? "bg-primary/20 text-foreground" : "bg-muted/40 text-foreground",
                      )}>
                        {m.tools && m.tools.length > 0 && (
                          <div className="mb-1.5 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-muted-foreground/70">数据来源</span>
                            {m.tools.map((t, j) => (
                              <span key={j} className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                                <Wrench className="h-2.5 w-2.5" /> {TOOL_LABEL[t.name] || t.name}{t.arg ? ` ${t.arg}` : ""}
                              </span>
                            ))}
                          </div>
                        )}
                        {m.role === "assistant" ? (
                          <div className="prose prose-sm prose-invert max-w-none break-words text-foreground">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap break-words">{m.content}</p>
                        )}
                        {m.role === "assistant" && m.content && !(loading && i === msgs.length - 1) && (
                          <div className="mt-1.5"><SaveNoteButton kind="问AI" title={`问 AI · ${msgs[i - 1]?.content?.slice(0, 24) || "对话"}`} content={m.content} /></div>
                        )}
                      </div>
                    </div>
                  ))}
                  {loading && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> AI 正在思考 / 调取数据…
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
                        <button key={s} onClick={() => send(s)} className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs hover:border-primary/40 hover:text-primary">
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-border/60 p-3">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
                      rows={1}
                      placeholder="就本页内容提问…"
                      className="flex-1 resize-none rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
                    />
                    <button onClick={() => send(input)} disabled={loading || !input.trim()}
                      className="rounded-lg bg-primary/15 p-2 text-primary hover:bg-primary/25 disabled:opacity-40">
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
