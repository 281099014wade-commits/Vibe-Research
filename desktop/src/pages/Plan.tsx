import { Pencil } from "lucide-react";
import { useState } from "react";

import { AddButton, DeleteButton, DueBadge, LedgerShell, RecordForm, enumLabel } from "../components/ui/RecordForm";
import { Badge, Card, CardHead } from "../components/ui/primitives";
import type { LedgerRecord } from "../lib/api";
import { useUi } from "../lib/store";
import { recordsOf, str } from "../lib/useLedger";

interface FormState {
  kind: string;
  editing?: LedgerRecord | null;
  preset?: Record<string, unknown>;
}

/** 一条判据。裁决点与证伪条件共用一种记录,靠 type 区分 */
function CriterionRow({ c, onEdit }: { c: LedgerRecord; onEdit: () => void }) {
  const type = str(c, "type");
  const status = str(c, "status");
  return (
    <div className="flex items-start gap-2 border-b border-border/40 py-2 text-[11.5px]">
      <Badge tone={type === "falsifier" ? "danger" : "primary"}>{enumLabel(type)}</Badge>
      <div className="min-w-0 flex-1">
        <div className="leading-relaxed">{str(c, "statement")}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
          {str(c, "symbol") ? <span className="tnum">{str(c, "symbol")}</span> : null}
          <DueBadge due={str(c, "due")} />
          <span>判定:{status ? enumLabel(status) : "未填"}</span>
          {str(c, "note") ? <span className="truncate">{str(c, "note")}</span> : null}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label="编辑判据"
        className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </button>
      <DeleteButton kind="criterion" id={c.id} />
    </div>
  );
}

export function Plan() {
  const openDock = useUi((s) => s.openDock);
  const [form, setForm] = useState<FormState | null>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHead
          title="这一页是整个经营闭环的地基"
          note="先写下目标与判据,后面所有「偏离」才有参照物。没有它,组合经营那页只能说涨跌,说不了「离计划多远」。"
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          这里存的是<span className="text-foreground">你自己写下的话</span>
          ,产品不替你生成。它只做两件事:原样呈现,以及把「哪条到期了」算出来。
        </p>
      </Card>

      <LedgerShell>
        {(s) => {
          const theses = recordsOf(s, "thesis");
          const criteria = recordsOf(s, "criterion");
          const byThesis = new Map<string, LedgerRecord[]>();
          const loose: LedgerRecord[] = [];
          for (const c of criteria) {
            const tid = str(c, "thesis_id");
            // 挂了一个**不存在**的论点 id 时归到"游离",不要凭空建一个分组
            if (tid && theses.some((t) => t.id === tid)) {
              byThesis.set(tid, [...(byThesis.get(tid) ?? []), c]);
            } else {
              loose.push(c);
            }
          }

          return (
            <>
              {form ? (
                <RecordForm
                  kind={form.kind}
                  def={s.kinds[form.kind]!}
                  editing={form.editing ?? null}
                  {...(form.preset ? { preset: form.preset } : {})}
                  onClose={() => setForm(null)}
                />
              ) : null}

              <Card>
                <CardHead
                  title="论点"
                  note="为什么持有 / 为什么关注。一条论点下面挂它自己的判据"
                  right={<AddButton label="写一条论点" onClick={() => setForm({ kind: "thesis" })} />}
                />
                {theses.length === 0 ? (
                  <p className="py-4 text-[12.5px] text-muted-foreground">
                    还没有论点。先写一条 —— 在它存在之前,「偏离」这个词没有意义。
                  </p>
                ) : (
                  <div className="space-y-4">
                    {theses.map((t) => {
                      const mine = byThesis.get(t.id) ?? [];
                      return (
                        <div key={t.id} className="rounded-lg border border-border/60 p-3">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[13px] font-medium">{str(t, "title")}</span>
                                {str(t, "symbol") ? (
                                  <span className="tnum text-[11.5px] text-muted-foreground">{str(t, "symbol")}</span>
                                ) : null}
                                {str(t, "status") ? <Badge>{enumLabel(str(t, "status"))}</Badge> : null}
                                {str(t, "review_by") ? (
                                  <span className="text-[10.5px] text-muted-foreground">
                                    复核 <span className="tnum">{str(t, "review_by")}</span>
                                  </span>
                                ) : null}
                              </div>
                              {str(t, "statement") ? (
                                <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
                                  {str(t, "statement")}
                                </p>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              onClick={() => setForm({ kind: "thesis", editing: t })}
                              aria-label="编辑论点"
                              className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <DeleteButton kind="thesis" id={t.id} />
                          </div>

                          <div className="mt-2">
                            {mine.map((c) => (
                              <CriterionRow key={c.id} c={c} onEdit={() => setForm({ kind: "criterion", editing: c })} />
                            ))}
                            <div className="pt-2">
                              <AddButton
                                label="给它加一条判据"
                                onClick={() =>
                                  setForm({
                                    kind: "criterion",
                                    preset: { thesis_id: t.id, symbol: str(t, "symbol"), status: "pending" },
                                  })
                                }
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>

              <Card>
                <CardHead
                  title="未挂到论点的判据"
                  note="可以先写下来再补论点;长期挂空 = 没人知道它在验证什么"
                  right={
                    <AddButton
                      label="写一条判据"
                      onClick={() => setForm({ kind: "criterion", preset: { status: "pending" } })}
                    />
                  }
                />
                {loose.length === 0 ? (
                  <p className="py-3 text-[12.5px] text-muted-foreground">没有游离的判据。</p>
                ) : (
                  loose.map((c) => (
                    <CriterionRow key={c.id} c={c} onEdit={() => setForm({ kind: "criterion", editing: c })} />
                  ))
                )}
              </Card>

              <button
                type="button"
                onClick={() =>
                  openDock(
                    "看我写下的论点与判据:哪一条**不可证伪**(无论发生什么都能自圆其说)?给出能让它变成可证伪的具体写法。",
                  )
                }
                className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
              >
                让 Agent 挑我判据里的毛病
              </button>
            </>
          );
        }}
      </LedgerShell>
    </div>
  );
}
