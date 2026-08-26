import { ChevronDown, CornerDownLeft, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../../lib/api";
import { useUi } from "../../lib/store";
import { Badge, cx } from "../ui/primitives";

/** A 股六位代码。识别到就能把这句话变成一次**真的**研究运行,而不只是聊天。 */
const A_SHARE = /\b(6\d{5}|0\d{5}|3\d{5})\b/;

/**
 * 底部 Agent 对话区。两种能力,都是真的:
 * - 句子里带标的代码 + 明确说"研究" → **真起一次六阶段运行**,并轮询真实状态
 * - 其余 → **真的自由对话**(后端 read-only 沙箱 + 不联网 + 过合规 gate,见 orchestrator/src/chat.ts)
 *
 * 🔴 对话线程**拿不到网络也不能取数** —— 它只能读已经落盘的产物。
 *    这是刻意的:让它自己去抓数据就绕开了整条取数纪律(没有 raw_ref、没有资料期、不可复算)。
 *    所以问"现在股价多少"它会说去起一次研究运行,而不是报一个记忆里的数。
 */
export function AgentDock() {
  const { dockOpen, dockSeed, closeDock, turns, pushTurn } = useUi();
  const [text, setText] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 从页面某张卡点"就这个问 Agent"进来时预填
  useEffect(() => {
    if (dockOpen && dockSeed) setText(dockSeed);
    if (dockOpen) inputRef.current?.focus();
  }, [dockOpen, dockSeed]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns.length]);

  // 起了运行就轮询真实状态,直到终态。轮询而不是长连接:后端目前只有 GET /runs/:id/status。
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const timer = setInterval(() => {
      void api
        .runStatus(runId)
        .then((st) => {
          if (!alive) return;
          if (st.status !== "complete" && st.status !== "failed") return;
          clearInterval(timer);
          setRunId(null);
          setBusy(false);
          pushTurn({
            role: "agent",
            text:
              st.status === "complete"
                ? `研究完成:${st.evidence_count ?? "?"} 条证据 / ${st.calculation_count ?? "?"} 项计算。到「研究与数据」打开 ${st.run_id} 看报告与证据台账。`
                : `研究未完成(${st.status},退出码 ${st.exit_code ?? "?"})。阶段:${st.stages.map((s) => `${s.stage}=${s.status}`).join(" · ")}`,
            note: st.run_id,
          });
        })
        .catch(() => {
          /* 轮询失败不打断:下一拍再试。真挂了用户会在运行页看到 */
        });
    }, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runId, pushTurn]);

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    pushTurn({ role: "user", text: t });
    setText("");

    const code = A_SHARE.exec(t)?.[1];
    // 🔴 只有**同时**出现代码与"研究/跑一次"这类词才起运行 —— 光有代码就起太粗暴:
    //    "300308 的报告里那个 PE 怎么算的" 明显是提问,不该白跑一次十几分钟的研究。
    const wantsRun = code !== undefined && /研究|跑一次|跑一遍|重新跑|分析一下/.test(t);
    setBusy(true);
    try {
      if (wantsRun && code) {
        const r = await api.startResearch({ symbol: code, market: "CN" });
        setRunId(r.run_id);
        pushTurn({ role: "agent", text: `已启动 ${code} 的六阶段研究。`, note: r.run_id });
        return; // busy 由轮询在终态时解除
      }
      const r = await api.chat(t);
      pushTurn({
        role: "agent",
        text: r.reply,
        // 有行被红线移除就说出来 —— 不说的话用户只会觉得"它答得没头没尾"
        ...(r.redacted > 0 ? { note: `${r.redacted} 行触发产出红线已移除` } : {}),
      });
      setBusy(false);
    } catch (e) {
      setBusy(false);
      const msg = e instanceof ApiError ? `${e.code} · ${e.message}` : String(e);
      pushTurn({ role: "agent", text: `失败:${msg}` });
    }
  }

  if (!dockOpen) return null;

  return (
    <section
      aria-label="Agent 对话"
      className="glass fixed bottom-0 left-[72px] right-0 z-[25] flex h-[336px] flex-col rounded-none border-x-0 border-b-0 bg-card/95 backdrop-blur-[18px] lg:left-[232px]"
    >
      <header className="flex items-center justify-between border-b border-border/60 px-5 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span className="text-[12.5px] font-medium">Agent</span>
          <Badge tone={busy ? "warning" : "neutral"}>{busy ? "运行中" : "就绪"}</Badge>
        </div>
        <button
          type="button"
          onClick={closeDock}
          aria-label="收起 Agent 对话"
          className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {turns.length === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            可以直接问 —— 它读得到已经跑过的研究产物与你写下的台账。
            <br />
            说"研究 300308"会**真起一次六阶段运行**;⚠️ 它没有网络,问实时行情它会让你去起一次运行,而不是报记忆里的数。
          </p>
        ) : (
          turns.map((t) => (
            <div key={t.id} className={cx("flex", t.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cx(
                  "max-w-[70%] rounded-lg px-3 py-2 text-[12.5px] leading-relaxed",
                  t.role === "user" ? "bg-primary/15 text-foreground" : "bg-muted text-foreground",
                )}
              >
                {t.text}
                {t.note ? <span className="ml-2 font-mono text-[11px] text-muted-foreground">{t.note}</span> : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border/60 px-5 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder="问一句,或写下标的代码开始研究(Enter 发送,Shift+Enter 换行)"
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-border bg-input/60 px-3 py-2 text-[12.5px] leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !text.trim()}
            className="flex h-[44px] cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-4 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
            <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </section>
  );
}
