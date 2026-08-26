import { Pencil } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { DataBar } from "../../../core/ui/DataBar";
import { AddButton, DeleteButton, DueBadge, LedgerShell, RecordForm, enumLabel } from "../../../core/ui/RecordForm";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Async, Badge, Card, CardHead, cx } from "../../../core/ui/primitives";
import { api, type LedgerRecord } from "../../../core/lib/api";
import { num, pivot } from "../../../core/lib/records";
import { useAsync } from "../../../core/lib/useAsync";
import { dueState, numOf, recordsOf, str, type LedgerView } from "../../../core/lib/useLedger";

/**
 * 六位代码 → 腾讯行情代码。60/68 在沪,00/30 在深。
 * 认不出来就返回 null 并在界面上写"取不到行情",**不猜一个前缀试试** ——
 * 猜错拿回来的是另一只标的的价格,而页面看不出任何异常。
 */
function tencentCode(symbol: string): string | null {
  if (/^(60|68)/.test(symbol)) return `sh${symbol}`;
  if (/^(00|30)/.test(symbol)) return `sz${symbol}`;
  return null;
}

interface Row {
  pos: LedgerRecord;
  symbol: string;
  shares: number | null;
  cost: number | null;
  price: number | null;
  changePct: number | null;
  value: number | null;
  pnl: number | null;
  pnlPct: number | null;
  quoteMissing: string;
}

/** 金额的紧凑写法(带单位)。原始值放 tooltip,由调用处给。 */
function money(v: number | null): { text: string; unit: string } {
  if (v === null) return { text: "—", unit: "" };
  const abs = Math.abs(v);
  const scale = (n: number, unit: string) => ({ text: (v / n).toLocaleString("zh-CN", { maximumFractionDigits: 2 }), unit });
  if (abs >= 1e8) return scale(1e8, "亿元");
  if (abs >= 1e4) return scale(1e4, "万元");
  return { text: v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }), unit: "元" };
}

const pctTone = (v: number | null): string => (v === null || v === 0 ? "" : v > 0 ? "text-danger" : "text-success");

export function Operate() {
  const [form, setForm] = useState<{ kind: string; editing?: LedgerRecord | null } | null>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHead title="这一页在回答什么" note="持有的东西现在什么状态,以及它离我自己写下的判据有多远。" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          数量与成本是<span className="text-foreground">你填的</span>,现价是实时取的;市值与浮盈由这两者算出,
          悬停能看到它的两个输入。这一页不给任何加减仓建议。
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
  form: { kind: string; editing?: LedgerRecord | null } | null;
  setForm: (v: { kind: string; editing?: LedgerRecord | null } | null) => void;
}) {
  const positions = recordsOf(s, "position");
  const criteria = recordsOf(s, "criterion");
  const watches = recordsOf(s, "watch");

  // 行情按持有的代码批量取一次。**没有持仓就不发请求** —— 空 codes 会让端点报参数错,
  // 那在页面上显示成"取数失败",而真相只是"你还没记持仓"。
  const codes = useMemo(
    () => positions.map((p) => tencentCode(str(p, "symbol"))).filter((c): c is string => c !== null),
    [positions],
  );
  const codesKey = codes.join(",");
  const fetchQuotes = useCallback(
    (refresh: boolean) => (codes.length === 0 ? Promise.resolve(null) : api.fetch({ endpoint: "tx_quotes_batch", args: { codes }, refresh })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [codesKey],
  );
  const { state, reload } = useAsync(fetchQuotes, [codesKey]);

  // 默认拿的是**上次的快照**(见 service.fetchEndpoint):必须把取数时刻显示出来 + 给真取数的入口
  const _res = state.phase === "ready" ? state.data : null;
  const dataBar = (
    <DataBar
      fetchedAt={_res?.fetched_at ?? null}
      cached={_res?.cached ?? false}
      loading={state.phase === "loading"}
      onRefresh={() => reload(true)}
    />
  );


  return (
    <>
      {dataBar}
      {form ? (
        <RecordForm
          kind={form.kind}
          def={s.kinds[form.kind]!}
          editing={form.editing ?? null}
          onClose={() => setForm(null)}
        />
      ) : null}

      <Card>
        <CardHead
          title="持有"
          note="成本与数量是你自己的记录;产品既不猜也不改"
          right={<AddButton label="记一笔持有" onClick={() => setForm({ kind: "position" })} />}
        />
        {positions.length === 0 ? (
          <p className="py-4 text-[12.5px] text-muted-foreground">
            还没有持有记录。记一笔之后,这里会显示它的实时状态与相关判据。
          </p>
        ) : (
          <Async state={state} onRetry={reload}>
            {(res) => {
              const byCode = new Map((res ? pivot(res.envelope) : []).map((q) => [q.key, q]));
              const rows: Row[] = positions.map((pos) => {
                const symbol = str(pos, "symbol");
                const code = tencentCode(symbol);
                const q = code ? byCode.get(code) : undefined;
                const shares = numOf(pos, "shares");
                const cost = numOf(pos, "cost");
                const price = q ? num(q.fields.price) : null;
                const changePct = q ? num(q.fields.change_pct) : null;
                return {
                  pos,
                  symbol,
                  shares,
                  cost,
                  price,
                  changePct,
                  value: shares !== null && price !== null ? shares * price : null,
                  pnl: shares !== null && price !== null && cost !== null ? (price - cost) * shares : null,
                  pnlPct: cost !== null && cost > 0 && price !== null ? ((price - cost) / cost) * 100 : null,
                  quoteMissing: code === null ? "代码前缀认不出" : q ? "" : "行情里没有这只",
                };
              });
              const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
              const totalPnl = rows.reduce((a, r) => a + (r.pnl ?? 0), 0);
              const missing = rows.filter((r) => r.value === null).length;

              return (
                <div>
                  <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px]">
                    <span>
                      <span className="text-muted-foreground">合计市值 </span>
                      <span className="tnum text-[17px] font-medium">{money(total).text}</span>
                      <span className="ml-0.5 text-[11px] text-muted-foreground">{money(total).unit}</span>
                    </span>
                    <span>
                      <span className="text-muted-foreground">合计浮盈 </span>
                      <span className={cx("tnum text-[17px] font-medium", pctTone(totalPnl))}>{money(totalPnl).text}</span>
                      <span className="ml-0.5 text-[11px] text-muted-foreground">{money(totalPnl).unit}</span>
                    </span>
                    {missing > 0 ? (
                      // 🔴 有一只取不到价,合计就是**不完整的**。不说出来 = 让人拿一个偏小的数当全部
                      <span className="text-[11.5px] text-warning">有 {missing} 只取不到行情,合计未包含它们</span>
                    ) : null}
                  </div>

                  <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                    <span className="w-16">代码</span>
                    <span className="flex-1">名称 / 账户</span>
                    <span className="w-20 text-right">数量</span>
                    <span className="w-20 text-right">成本</span>
                    <span className="w-20 text-right">现价</span>
                    <span className="w-16 text-right">今日</span>
                    <span className="w-24 text-right">市值</span>
                    <span className="w-24 text-right">浮盈</span>
                    <span className="w-14" />
                  </div>

                  {rows.map((r) => {
                    const mine = criteria.filter((c) => str(c, "symbol") === r.symbol);
                    const hot = mine.filter((c) => {
                      const d = dueState(str(c, "due"));
                      return str(c, "status") === "pending" && (d === "overdue" || d === "today");
                    });
                    return (
                      <div key={r.pos.id} className="border-b border-border/40 py-2">
                        <div className="flex items-baseline gap-2 text-[11.5px]">
                          <span className="tnum w-16 shrink-0">{r.symbol}</span>
                          <span className="min-w-0 flex-1 truncate">
                            {str(r.pos, "name") || "—"}
                            {str(r.pos, "account") ? (
                              <span className="ml-2 text-muted-foreground">{str(r.pos, "account")}</span>
                            ) : null}
                          </span>
                          <span className="tnum w-20 shrink-0 text-right">{r.shares ?? "—"}</span>
                          <span className="tnum w-20 shrink-0 text-right">{r.cost ?? "—"}</span>
                          <span className="tnum w-20 shrink-0 text-right">{r.price ?? "—"}</span>
                          <span className={cx("tnum w-16 shrink-0 text-right", pctTone(r.changePct))}>
                            {r.changePct === null ? "—" : `${r.changePct > 0 ? "+" : ""}${r.changePct}%`}
                          </span>
                          <span
                            className="tnum w-24 shrink-0 text-right"
                            title={`市值 = 数量 ${r.shares ?? "?"} × 现价 ${r.price ?? "?"}`}
                          >
                            {money(r.value).text}
                            <span className="ml-0.5 text-[10.5px] text-muted-foreground">{money(r.value).unit}</span>
                          </span>
                          <span
                            className={cx("tnum w-24 shrink-0 text-right", pctTone(r.pnl))}
                            title={`浮盈 = (现价 ${r.price ?? "?"} − 成本 ${r.cost ?? "?"}) × 数量 ${r.shares ?? "?"}`}
                          >
                            {money(r.pnl).text}
                            {/* 单位不能省:同一行市值带单位、浮盈不带,两个数会被当成同一量纲读 */}
                            <span className="ml-0.5 text-[10.5px] text-muted-foreground">{money(r.pnl).unit}</span>
                            {r.pnlPct === null ? null : (
                              <span className="ml-1.5 text-[10.5px]">{r.pnlPct.toFixed(1)}%</span>
                            )}
                          </span>
                          <span className="flex w-14 shrink-0 items-center justify-end gap-0.5">
                            <button
                              type="button"
                              onClick={() => setForm({ kind: "position", editing: r.pos })}
                              aria-label="编辑持有"
                              className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <DeleteButton kind="position" id={r.pos.id} />
                          </span>
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-2 pl-16 text-[10.5px] text-muted-foreground">
                          {r.quoteMissing ? <span className="text-warning">{r.quoteMissing}</span> : null}
                          {mine.length === 0 ? (
                            // 没判据 = 这笔持有没有写下来的理由。这是**要指出来的状态**,不是空白
                            <span className="text-warning">没有写下判据 —— 拿它对不了账</span>
                          ) : (
                            <>
                              <span>判据 {mine.length} 条</span>
                              {hot.map((c) => (
                                <span key={c.id} className="flex items-center gap-1">
                                  <DueBadge due={str(c, "due")} />
                                  <span className="max-w-[26rem] truncate">{str(c, "statement")}</span>
                                </span>
                              ))}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          </Async>
        )}
      </Card>

      <Card>
        <CardHead title="判据一览" note="按主体归拢;判定状态由你自己填,产品不替你判" />
        {criteria.length === 0 ? (
          <p className="py-3 text-[12.5px] text-muted-foreground">
            还没有判据。到「计划与风险」写下来,这里会自动按主体归拢。
          </p>
        ) : (
          criteria.map((c) => (
            <div key={c.id} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
              <span className="tnum w-16 shrink-0 text-muted-foreground">{str(c, "symbol") || "组合"}</span>
              <Badge tone={str(c, "type") === "falsifier" ? "danger" : "primary"}>{enumLabel(str(c, "type"))}</Badge>
              <span className="min-w-0 flex-1 truncate">{str(c, "statement")}</span>
              <DueBadge due={str(c, "due")} />
              <span className="w-14 shrink-0 text-right text-muted-foreground">
                {str(c, "status") ? enumLabel(str(c, "status")) : "未填"}
              </span>
            </div>
          ))
        )}
      </Card>

      <Card>
        <CardHead
          title="自选"
          note="只是盯着它,还没到写论点的程度。与持有是两张表 —— 这里出现不代表持有"
          right={<AddButton label="加一只自选" onClick={() => setForm({ kind: "watch" })} />}
        />
        {watches.length === 0 ? (
          <p className="py-3 text-[12.5px] text-muted-foreground">
            还没有自选。加进来之后,「今日总览」那一页会带上它的现价与涨跌。
          </p>
        ) : (
          watches.map((w) => (
            <div key={w.id} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
              <span className="tnum w-16 shrink-0 text-muted-foreground">{str(w, "symbol")}</span>
              <span className="w-24 shrink-0 truncate">{str(w, "name") || "—"}</span>
              {str(w, "tag") ? <Badge>{str(w, "tag")}</Badge> : null}
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={str(w, "note")}>
                {str(w, "note")}
              </span>
              <button
                type="button"
                onClick={() => setForm({ kind: "watch", editing: w })}
                className="cursor-pointer text-muted-foreground transition-colors hover:text-primary"
                aria-label="编辑"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <DeleteButton kind="watch" id={w.id} />
            </div>
          ))
        )}
      </Card>

      <AskAgent prompt={"对照我的持有与我写下的判据:哪几笔的理由已经站不住了?逐条说明是哪条判据被什么事实推翻的。"}>让 Agent 对一遍账</AskAgent>
    </>
  );
}
