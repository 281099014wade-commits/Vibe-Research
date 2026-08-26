import { useCallback, useMemo } from "react";

import { DataBar } from "../../../core/ui/DataBar";
import { DueBadge, LedgerShell, enumLabel } from "../../../core/ui/RecordForm";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Async, Badge, Card, CardHead } from "../../../core/ui/primitives";
import { api } from "../../../core/lib/api";
import { num, pivot } from "../../../core/lib/records";
import { useAsync } from "../../../core/lib/useAsync";
import { dueState, numOf, recordsOf, str, type LedgerView } from "../../../core/lib/useLedger";

function tencentCode(symbol: string): string | null {
  if (/^(60|68)/.test(symbol)) return `sh${symbol}`;
  if (/^(00|30)/.test(symbol)) return `sz${symbol}`;
  return null;
}

const money = (v: number): string =>
  Math.abs(v) >= 1e8
    ? `${(v / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿元`
    : Math.abs(v) >= 1e4
      ? `${(v / 1e4).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 万元`
      : `${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 元`;

export function Risk() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHead title="这一页在回答什么" note="钱压在哪儿、压得多集中,以及我写死的证伪条件到期了没有。" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          集中度按<span className="text-foreground">市值占比</span>算(数量 × 现价)。
          这一页只呈现事实与到期状态,不给「该减到多少」这类结论 —— 那是你自己的判断。
        </p>
      </Card>
      <LedgerShell>{(s) => <Body s={s} />}</LedgerShell>
    </div>
  );
}

function Body({ s }: { s: LedgerView }) {
  const positions = recordsOf(s, "position");
  const criteria = recordsOf(s, "criterion");

  const codes = useMemo(
    () => positions.map((p) => tencentCode(str(p, "symbol"))).filter((c): c is string => c !== null),
    [positions],
  );
  const codesKey = codes.join(",");
  const fn = useCallback(
    (refresh: boolean) => (codes.length === 0 ? Promise.resolve(null) : api.fetch({ endpoint: "tx_quotes_batch", args: { codes }, refresh })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [codesKey],
  );
  const { state, reload } = useAsync(fn, [codesKey]);

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


  const falsifiers = criteria.filter((c) => str(c, "type") === "falsifier");
  const overdue = criteria.filter((c) => str(c, "status") === "pending" && dueState(str(c, "due")) === "overdue");

  return (
    <>
      {dataBar}
      <Card>
        <CardHead title="集中度" note="按市值占比;取不到行情的会单独列出,不混进百分比" />
        {positions.length === 0 ? (
          <p className="py-4 text-[12.5px] text-muted-foreground">
            还没有持有记录。到「组合经营」记一笔,这里才有东西可算。
          </p>
        ) : (
          <Async state={state} onRetry={reload}>
            {(res) => {
              const byCode = new Map((res ? pivot(res.envelope) : []).map((q) => [q.key, q]));
              const rows = positions.map((p) => {
                const symbol = str(p, "symbol");
                const code = tencentCode(symbol);
                const q = code ? byCode.get(code) : undefined;
                const shares = numOf(p, "shares");
                const price = q ? num(q.fields.price) : null;
                return {
                  id: p.id,
                  symbol,
                  name: str(p, "name"),
                  account: str(p, "account") || "(未标账户)",
                  value: shares !== null && price !== null ? shares * price : null,
                };
              });
              const priced = rows.filter((r) => r.value !== null);
              const unpriced = rows.filter((r) => r.value === null);
              const total = priced.reduce((a, r) => a + (r.value ?? 0), 0);
              const sorted = [...priced].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
              const top1 = total > 0 && sorted[0] ? ((sorted[0].value ?? 0) / total) * 100 : null;
              const top3 = total > 0 ? (sorted.slice(0, 3).reduce((a, r) => a + (r.value ?? 0), 0) / total) * 100 : null;

              const byAccount = new Map<string, number>();
              for (const r of priced) byAccount.set(r.account, (byAccount.get(r.account) ?? 0) + (r.value ?? 0));

              return (
                <div>
                  <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px]">
                    <span>
                      <span className="text-muted-foreground">已计入市值 </span>
                      <span className="tnum text-[17px] font-medium">{money(total)}</span>
                    </span>
                    <span className="text-muted-foreground">
                      第一大 <span className="tnum text-foreground">{top1 === null ? "—" : `${top1.toFixed(1)}%`}</span>
                      {" · "}前三合计{" "}
                      <span className="tnum text-foreground">{top3 === null ? "—" : `${top3.toFixed(1)}%`}</span>
                    </span>
                    <span className="text-muted-foreground">
                      共 <span className="tnum text-foreground">{priced.length}</span> 只计入
                    </span>
                  </div>

                  {sorted.map((r) => {
                    const pct = total > 0 ? ((r.value ?? 0) / total) * 100 : 0;
                    return (
                      <div key={r.id} className="flex items-center gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                        <span className="tnum w-16 shrink-0">{r.symbol}</span>
                        <span className="w-28 shrink-0 truncate">{r.name || "—"}</span>
                        {/* 条形只是同一个百分比的第二种呈现,不引入新数字 */}
                        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </span>
                        <span className="tnum w-16 shrink-0 text-right">{pct.toFixed(1)}%</span>
                        <span className="tnum w-24 shrink-0 text-right text-muted-foreground">{money(r.value ?? 0)}</span>
                      </div>
                    );
                  })}

                  {unpriced.length > 0 ? (
                    // 🔴 取不到价的没进分母,所以这些占比是"已计入部分"的占比。不说清就是在骗人
                    <p className="pt-2 text-[11.5px] text-warning">
                      {unpriced.length} 只取不到行情({unpriced.map((r) => r.symbol).join("、")}),
                      未计入上面的百分比 —— 这些占比是「已计入部分」的占比,不是全部。
                    </p>
                  ) : null}

                  <div className="mt-4">
                    <div className="mb-1 text-[11.5px] text-muted-foreground">按账户</div>
                    {[...byAccount.entries()]
                      .sort((a, b) => b[1] - a[1])
                      .map(([acc, v]) => (
                        <div
                          key={acc}
                          className="flex items-baseline gap-2 border-b border-border/40 py-1 text-[11.5px]"
                        >
                          <span className="min-w-0 flex-1 truncate">{acc}</span>
                          <span className="tnum w-16 text-right">
                            {total > 0 ? `${((v / total) * 100).toFixed(1)}%` : "—"}
                          </span>
                          <span className="tnum w-24 text-right text-muted-foreground">{money(v)}</span>
                        </div>
                      ))}
                  </div>
                </div>
              );
            }}
          </Async>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHead title="证伪条件" note="写死的「什么出现就说明我错了」;判定状态由你自己填" />
          {falsifiers.length === 0 ? (
            <p className="py-3 text-[12.5px] leading-relaxed text-warning">
              一条证伪条件都没有。这本身就是最大的风险 —— 没有事先写下「什么算错」,
              事后总能给任何结果找到解释。到「计划与风险」补上。
            </p>
          ) : (
            falsifiers.map((c) => (
              <div key={c.id} className="flex items-start gap-2 border-b border-border/40 py-2 text-[11.5px]">
                <span className="tnum w-16 shrink-0 text-muted-foreground">{str(c, "symbol") || "组合"}</span>
                <span className="min-w-0 flex-1 leading-relaxed">{str(c, "statement")}</span>
                <Badge tone={str(c, "status") === "broken" ? "danger" : "neutral"}>
                  {str(c, "status") ? enumLabel(str(c, "status")) : "未填"}
                </Badge>
              </div>
            ))
          )}
        </Card>

        <Card>
          <CardHead title="已过期还没判的" note="到期不判 = 判据形同虚设" />
          {overdue.length === 0 ? (
            <p className="py-3 text-[12.5px] text-muted-foreground">没有过期未判的判据。</p>
          ) : (
            overdue.map((c) => (
              <div key={c.id} className="flex items-start gap-2 border-b border-border/40 py-2 text-[11.5px]">
                <DueBadge due={str(c, "due")} />
                <span className="min-w-0 flex-1 leading-relaxed">{str(c, "statement")}</span>
                <span className="tnum w-16 shrink-0 text-right text-muted-foreground">{str(c, "symbol") || "组合"}</span>
              </div>
            ))
          )}
        </Card>
      </div>

      <AskAgent prompt={"看我的集中度与证伪条件:这套持仓在什么情形下会同时受伤(共同风险因子是什么)?只讲因子,不讲仓位该怎么调。"}>让 Agent 找共同风险因子</AskAgent>
    </>
  );
}
