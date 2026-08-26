import { useState } from "react";

import { MoneyCell, PctCell } from "../../../core/ui/envelope";
import { AskAgent } from "../../../core/ui/AskAgent";
import { PageShell } from "../../../core/ui/PageShell";
import { Badge, Card, CardHead, cx } from "../../../core/ui/primitives";
import { labelOf, num, pivot, sortBy, type Row } from "../../../core/lib/records";
import { TagBoards } from "../components/TagBoards";

/**
 * 两个端点的 record_key 都带板块代码,但前缀不同:
 * 涨跌排名是 `BK1341`,资金流是 `industry|BK1205`。**只按 `|` 后那段精确对齐**,
 * 对不上就是对不上 —— 不按名字模糊匹配(板块简称在两边不保证一字不差)。
 */
function bkCode(key: string): string {
  const i = key.lastIndexOf("|");
  return i < 0 ? key : key.slice(i + 1);
}

type Sort = "change" | "money";

interface Merged {
  cmp: Row;
  flow: Row | undefined;
}

export function Sectors() {
  const [sort, setSort] = useState<Sort>("change");

  return (
    <PageShell query="sectors">
      {({ page, block }) => {
        // 三块都取到才画表:少任何一块,涨跌与资金就对不起来。
        // 缺块的原因已由 PageShell 在顶部统一说明,这里不再画一个半张的表冒充完整。
        const cmp = block("comparison");
        const flow = block("board_flow");
        const sw = block("sw");
        return (
          <div className="space-y-4">
            <Card>
              <CardHead title="这一页在回答什么" note={page.intent} />
            </Card>

            {/* 自己在跟的几条线放最前面:打开这一页首先该看见的是"我关心的",
                而不是全市场几百个板块的排名。⚠️ 这几块与下面的全市场表**不共用取数** ——
                它们是各自独立的行情请求,展开哪条取哪条。 */}
            <TagBoards />

            {!cmp?.envelope || !flow?.envelope ? (
              <Card>
                <p className="text-[12.5px] text-muted-foreground">
                  全市场板块表:涨跌与资金两块要都在才对得起来,先看上面缺了哪块。
                </p>
              </Card>
            ) : (() => {
          const flowByCode = new Map(pivot(flow.envelope).map((r) => [bkCode(r.key), r]));
          const merged: Merged[] = pivot(cmp.envelope).map((r) => ({ cmp: r, flow: flowByCode.get(bkCode(r.key)) }));
          const matched = merged.filter((m) => m.flow).length;

          const byKey = new Map(merged.map((m) => [m.cmp.key, m]));
          const sorted: Merged[] =
            sort === "change"
              ? sortBy(
                  merged.map((m) => m.cmp),
                  "industry_board_change_pct",
                ).flatMap((c) => {
                  const m = byKey.get(c.key);
                  return m ? [m] : [];
                })
              : merged
                  .filter((m) => m.flow)
                  .sort(
                    (a, b) =>
                      (num(b.flow?.fields.board_main_net_today) ?? 0) - (num(a.flow?.fields.board_main_net_today) ?? 0),
                  );

          const rows = sorted.slice(0, 20);

          return (
            <>
              <Card>
                <CardHead
                  title="行业板块"
                  note={`涨跌排名 ${merged.length} 个;其中 ${matched} 个能对上资金流(资金流端点只取前 50)`}
                  right={
                    <div className="flex gap-1">
                      {(
                        [
                          ["change", "按涨跌"],
                          ["money", "按主力净额"],
                        ] as const
                      ).map(([k, t]) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setSort(k)}
                          className={cx(
                            "cursor-pointer rounded-md px-2 py-0.5 text-[11px] transition-colors",
                            sort === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  }
                />
                <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                  <span className="w-5" />
                  <span className="flex-1">板块</span>
                  <span className="w-16 text-right">涨跌</span>
                  <span className="w-20 text-right">涨 / 跌家数</span>
                  <span className="w-24 text-right">主力净额</span>
                  <span className="w-14 text-right">净占比</span>
                </div>
                {rows.map(({ cmp: c, flow: f }, i) => (
                  <div key={c.key} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                    <span className="tnum w-5 shrink-0 text-right text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate" title={c.note}>
                      {labelOf(c)}
                    </span>
                    <span className="w-16 shrink-0 text-right">
                      <PctCell ev={c.fields.industry_board_change_pct} />
                    </span>
                    <span className="tnum w-20 shrink-0 text-right text-muted-foreground">
                      <span className="text-danger">{num(c.fields.industry_board_up_count) ?? "—"}</span>
                      {" / "}
                      <span className="text-success">{num(c.fields.industry_board_down_count) ?? "—"}</span>
                    </span>
                    {/* 对不上就写"未覆盖",不填 0 —— 0 会被读成"没有资金流入" */}
                    {f ? (
                      <>
                        <MoneyCell ev={f.fields.board_main_net_today} className="w-24 shrink-0 text-right" />
                        <span className="w-14 shrink-0 text-right">
                          <PctCell ev={f.fields.board_main_pct_today} plain />
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="w-24 shrink-0 text-right text-[10.5px] text-muted-foreground">未覆盖</span>
                        <span className="w-14 shrink-0" />
                      </>
                    )}
                  </div>
                ))}
                <p className="pt-2 text-[11px] text-muted-foreground">
                  显示前 {rows.length} 个 / 共 {sorted.length} 个
                </p>
              </Card>

              {/* 申万分类是**可选**的一块:缺了不影响上面的主表(涨跌 × 资金),
                  所以单独判、单独不画 —— 缺的原因已由 PageShell 在顶部说明。 */}
              {sw?.envelope ? (
              <Card>
                <CardHead
                  title="申万行业分类"
                  note="用于跨源核对行业归属"
                  right={<Badge tone={sw.envelope.status === "ok" ? "success" : "danger"}>{sw.envelope.status}</Badge>}
                />
                {sw.envelope.status === "ok" ? (
                  <div className="space-y-0.5">
                    {pivot(sw.envelope)
                      .slice(0, 10)
                      .map((r) => (
                        <div
                          key={r.key}
                          className="flex items-baseline gap-2 border-b border-border/40 py-1 text-[11.5px]"
                        >
                          <span className="min-w-0 flex-1 truncate">{r.note || r.key}</span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-[12px] leading-relaxed text-warning">
                    这个源当前取不到:
                    <span className="ml-1 text-muted-foreground">
                      {JSON.stringify(sw.envelope.errors[0] ?? {}).slice(0, 220)}
                    </span>
                    <br />
                    <span className="text-muted-foreground">
                      照实显示、不静默隐藏 ——「取不到」和「这家没有申万分类」是两件事,处置也不同。
                    </span>
                  </p>
                )}
              </Card>
              ) : null}

              <AskAgent prompt={"就今天的行业板块表,找出「涨得多但主力净额是流出」的板块,说明这种背离通常意味着什么、要确认还需要哪些数据。"}>就板块背离问 Agent</AskAgent>
            </>
              );
            })()}

          </div>
        );
      }}
    </PageShell>
  );
}
