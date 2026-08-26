import { Check, Pencil } from "lucide-react";
import { useState } from "react";

import { AddButton, DeleteButton, DueBadge, LedgerShell, RecordForm, enumLabel } from "../../../core/ui/RecordForm";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Badge, Card, CardHead } from "../../../core/ui/primitives";
import type { LedgerRecord } from "../../../core/lib/api";
import { dueState, recordsOf, str, useLedger, type DueState, type LedgerView } from "../../../core/lib/useLedger";

/** 排序权重:越该现在处理的排越前。没写到期日的排在「未到期」之后 —— 它最容易被永远忘掉 */
const ORDER: Record<DueState, number> = { overdue: 0, today: 1, soon: 2, later: 3, none: 4 };

interface FormState {
  kind: string;
  editing?: LedgerRecord | null;
  preset?: Record<string, unknown>;
}

export function Actions() {
  const [form, setForm] = useState<FormState | null>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHead title="这一页在回答什么" note="今天该处理什么:到期必裁的判据,以及自己写下的待办。" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          到期的判据会自动出现在上面一栏 —— 它是从「计划与风险」里那些
          <span className="text-foreground">你自己写下的</span>判据算出来的,产品不新增任何判断。
          到点只提醒「该判了」,不说该怎么判。
        </p>
      </Card>

      <LedgerShell>{(s) => <Body s={s} form={form} setForm={setForm} />}</LedgerShell>
    </div>
  );
}

function Body({
  s,
  form,
  setForm,
}: {
  s: LedgerView;
  form: FormState | null;
  setForm: (v: FormState | null) => void;
}) {
  const save = useLedger((st) => st.save);
  const saving = useLedger((st) => st.saving);
  const actions = recordsOf(s, "action");
  const criteria = recordsOf(s, "criterion");

  // 到期必裁:待判 + 到期日已到或已过。**只看用户自己填的 status / due**,不替他推断
  const dueNow = criteria
    .filter((c) => str(c, "status") === "pending")
    .map((c) => ({ c, d: dueState(str(c, "due")) }))
    .filter((x) => x.d === "overdue" || x.d === "today")
    .sort((a, b) => ORDER[a.d] - ORDER[b.d] || str(a.c, "due").localeCompare(str(b.c, "due")));

  const open = actions
    .filter((a) => str(a, "status") !== "done" && str(a, "status") !== "dropped")
    .sort(
      (a, b) =>
        ORDER[dueState(str(a, "due"))] - ORDER[dueState(str(b, "due"))] || str(a, "due").localeCompare(str(b, "due")),
    );
  const closed = actions.filter((a) => str(a, "status") === "done" || str(a, "status") === "dropped");

  /** 从一条到期判据生成待办 */
  async function makeAction(c: LedgerRecord) {
    await save("action", {
      title: `裁决:${str(c, "statement").slice(0, 120)}`,
      symbol: str(c, "symbol"),
      due: str(c, "due"),
      status: "open",
      ref: c.id,
    });
  }

  /**
   * 标记完成。
   * 🔴 必须把该记录的**全部字段**一起带上 —— 台账的更新是整条替换,
   *    只发 `{id, status}` 会把标题、到期日、关联统统清空(而且不会报错)。
   */
  async function markDone(a: LedgerRecord) {
    const def = s.kinds.action;
    if (!def) return;
    const payload: Record<string, unknown> = { id: a.id };
    for (const f of Object.keys(def.properties)) if (a[f] !== undefined) payload[f] = a[f];
    payload.status = "done";
    await save("action", payload);
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

      <Card glow={dueNow.length > 0}>
        <CardHead
          title="到期必裁"
          note="从你写下的判据算出来的;判定结果要回到「计划与风险」里填"
          right={<Badge tone={dueNow.length > 0 ? "warning" : "neutral"}>{dueNow.length} 条</Badge>}
        />
        {dueNow.length === 0 ? (
          <p className="py-3 text-[12.5px] leading-relaxed text-muted-foreground">
            今天没有到期的判据。
            {criteria.length === 0
              ? "(不过你还一条判据都没写 —— 那不是「没到期」,是没有可到期的东西。)"
              : ""}
          </p>
        ) : (
          dueNow.map(({ c }) => (
            <div key={c.id} className="flex items-start gap-2 border-b border-border/40 py-2 text-[11.5px]">
              <DueBadge due={str(c, "due")} />
              <Badge tone={str(c, "type") === "falsifier" ? "danger" : "primary"}>{enumLabel(str(c, "type"))}</Badge>
              <div className="min-w-0 flex-1">
                <div className="leading-relaxed">{str(c, "statement")}</div>
                {str(c, "symbol") ? (
                  <span className="tnum text-[10.5px] text-muted-foreground">{str(c, "symbol")}</span>
                ) : null}
              </div>
              <button
                type="button"
                disabled={saving || actions.some((a) => str(a, "ref") === c.id)}
                onClick={() => void makeAction(c)}
                className="shrink-0 cursor-pointer rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                {actions.some((a) => str(a, "ref") === c.id) ? "已建待办" : "建成待办"}
              </button>
            </div>
          ))
        )}
      </Card>

      <Card>
        <CardHead
          title="待办"
          note="按到期紧迫度排;没写到期日的排最后 —— 那种最容易被永远忘掉"
          right={
            <AddButton label="加一条待办" onClick={() => setForm({ kind: "action", preset: { status: "open" } })} />
          }
        />
        {open.length === 0 ? (
          <p className="py-3 text-[12.5px] text-muted-foreground">没有待办。</p>
        ) : (
          open.map((a) => (
            <div key={a.id} className="flex items-start gap-2 border-b border-border/40 py-2 text-[11.5px]">
              <DueBadge due={str(a, "due")} />
              <div className="min-w-0 flex-1">
                <div className="leading-relaxed">{str(a, "title")}</div>
                <div className="mt-0.5 flex flex-wrap gap-2 text-[10.5px] text-muted-foreground">
                  {str(a, "symbol") ? <span className="tnum">{str(a, "symbol")}</span> : null}
                  {str(a, "ref") ? <span className="font-mono">{str(a, "ref")}</span> : null}
                  {str(a, "note") ? <span className="truncate">{str(a, "note")}</span> : null}
                </div>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => void markDone(a)}
                aria-label="标记完成"
                className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-success/15 hover:text-success disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setForm({ kind: "action", editing: a })}
                aria-label="编辑待办"
                className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
              <DeleteButton kind="action" id={a.id} />
            </div>
          ))
        )}
      </Card>

      {closed.length > 0 ? (
        <Card>
          <CardHead title="已了结" note="留着是为了以后能回头看当时怎么处理的" />
          {closed.map((a) => (
            <div key={a.id} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
              <Badge tone={str(a, "status") === "done" ? "success" : "neutral"}>{enumLabel(str(a, "status"))}</Badge>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{str(a, "title")}</span>
              <span className="tnum w-20 shrink-0 text-right text-muted-foreground">{str(a, "due") || "—"}</span>
              <DeleteButton kind="action" id={a.id} />
            </div>
          ))}
        </Card>
      ) : null}

      <AskAgent prompt={"就今天到期的判据,列出判定它需要哪些具体数据、各自去哪里取。只列取数路径,不要替我下判断。"}>问 Agent 该看哪些数据</AskAgent>
    </>
  );
}
