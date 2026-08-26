import { ChevronRight, NotebookPen, Pencil } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AddButton, DeleteButton, LedgerShell, RecordForm, enumLabel } from "../../../core/ui/RecordForm";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Badge, Card, CardHead, cx } from "../../../core/ui/primitives";
import type { LedgerRecord } from "../../../core/lib/api";
import { recordsOf, str, type LedgerView } from "../../../core/lib/useLedger";

/**
 * 研究记录:把复盘 / 要点 / 问 Agent 的结果沉淀下来。
 *
 * 🔴 与开源版的区别:那边存 `localStorage`,这里存**用户自有台账**(原子落盘 + 契约校验)。
 *    浏览器清一次缓存就没了的东西,不配叫"沉淀"。
 * ⚠️ 这一层**只留痕,不参与任何自动判定** —— 要被拿来对账的是判据与论点,不是这里。
 */

const CATEGORY_TONE: Record<string, "primary" | "warning" | "success" | "neutral"> = {
  review: "primary",
  highlight: "warning",
  ask: "success",
  debate: "neutral",
  audit: "neutral",
};

function when(r: LedgerRecord): string {
  return String(r.created_at ?? "").slice(0, 16).replace("T", " ");
}

function Body({ s }: { s: LedgerView }) {
  const [form, setForm] = useState<{ kind: string; editing?: LedgerRecord | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // 新的在上面 —— 沉淀是按时间倒着翻的
  const notes = [...recordsOf(s, "note")].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  return (
    <>
      {form && s.kinds[form.kind] ? (
        <RecordForm
          kind={form.kind}
          def={s.kinds[form.kind]!}
          editing={form.editing ?? null}
          onClose={() => setForm(null)}
        />
      ) : null}

      <Card>
        <CardHead
          title="研究记录"
          note={`共 ${notes.length} 条。写下来的东西才回得去 —— 这里只留痕,不参与任何自动判定`}
          right={<AddButton label="写一条" onClick={() => setForm({ kind: "note" })} />}
        />
        {notes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <NotebookPen className="h-7 w-7 text-muted-foreground/40" aria-hidden />
            <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
              还没有记录。看完一天的盘面、或者跟 Agent 聊出点东西,把结论写一条存这儿 ——
              下次回头看,能对上的才算数。
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {notes.map((n) => {
              const open = openId === n.id;
              const cat = str(n, "category");
              const body = str(n, "body");
              return (
                <div key={n.id} className="rounded-lg border border-border/50">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : n.id)}
                      aria-expanded={open}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    >
                      <ChevronRight
                        className={cx(
                          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                          open && "rotate-90",
                        )}
                        aria-hidden
                      />
                      {cat ? <Badge tone={CATEGORY_TONE[cat] ?? "neutral"}>{enumLabel(cat)}</Badge> : null}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{str(n, "title")}</span>
                      {str(n, "symbol") ? (
                        <span className="tnum shrink-0 text-[11px] text-muted-foreground">{str(n, "symbol")}</span>
                      ) : null}
                      <span className="tnum shrink-0 text-[11px] text-muted-foreground">{when(n)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm({ kind: "note", editing: n })}
                      className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-primary"
                      aria-label="编辑"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <DeleteButton kind="note" id={n.id} />
                  </div>
                  {open ? (
                    <div className="border-t border-border/40 px-3 py-3">
                      {body ? (
                        <div className="markdown text-[12.5px] leading-relaxed">
                          <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
                        </div>
                      ) : (
                        <p className="text-[12px] text-muted-foreground">这条只有标题,没写正文。</p>
                      )}
                      {/* 开源版这里是「反思审计」:让 AI 回头审这段推理。
                          我们用同一个对话入口 —— 它已经过合规 gate,不会绕开红线。 */}
                      <AskAgent
                        className="mt-3"
                        prompt={`回头审这段我自己写的推理,逐条标出:哪些有数据撑着、哪些是脑补、最脆弱的一环在哪。只做审计,不要给我操作建议。\n\n标题:${str(n, "title")}\n\n${body || "(没有正文)"}`}
                      >
                        让 Agent 反过来审这条
                      </AskAgent>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

export function Notes() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHead title="这一页在回答什么" note="我自己写下来的东西,回头能翻得到" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          存在<span className="text-foreground">用户自有台账</span>里(原子落盘、有契约校验),
          不是浏览器缓存 —— 清一次缓存就没了的东西不配叫沉淀。
        </p>
      </Card>
      <LedgerShell>{(s) => <Body s={s} />}</LedgerShell>
    </div>
  );
}
