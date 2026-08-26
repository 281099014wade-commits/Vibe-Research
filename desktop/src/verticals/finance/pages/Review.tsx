import type { ReactNode } from "react";

import { Block, PageShell } from "../../../core/ui/PageShell";
import { Metric, MoneyCell, PctCell, show } from "../../../core/ui/envelope";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Card, CardHead } from "../../../core/ui/primitives";
import { labelOf, num, pivot, scalar, sortBy, type Row } from "../../../core/lib/records";

/** 榜单行的统一骨架:名次 + 说明 + 右侧若干数值格 */
function RankRow({ i, label, children }: { i: number; label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
      <span className="tnum w-5 shrink-0 text-right text-muted-foreground">{i + 1}</span>
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function Review() {

  return (
    <PageShell query="review">
      {({ page, block }) => (
        <div className="space-y-4">
          <Card>
            {/* 🔴 "这一页在回答什么"来自**后端的垂类声明**,不是前端写死的 —— 只有一处真相 */}
            <CardHead title="这一页在回答什么" note={page.intent} />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              每个数字都挂着资料期与证据 id(悬停可见)。这一页只呈现事实,不排"该买什么"。
            </p>
          </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Block b={block("sentiment")}>
          {(res) => (
            <div className="grid grid-cols-3 gap-4">
              {/* 涨停红、跌停绿:A 股口径,说的是方向不是好坏 */}
              <Metric label="涨停" ev={scalar(res.envelope, "limit_up_count")} tone="danger" big />
              <Metric label="炸板" ev={scalar(res.envelope, "break_board_count")} tone="warning" big />
              <Metric label="跌停" ev={scalar(res.envelope, "limit_down_count")} tone="success" big />
            </div>
          )}
        </Block>

        <Block b={block("reason")}>
          {(res) => {
            const all = pivot(res.envelope);
            const rows = all.slice(0, 8);
            return (
              <div>
                {rows.map((r, i) => (
                  <RankRow key={r.key} i={i} label={labelOf(r)}>
                    <span
                      className="max-w-[52%] shrink-0 truncate text-right text-primary"
                      title={String(r.fields.strong_stock_reason?.value ?? "")}
                    >
                      {show(r.fields.strong_stock_reason)}
                    </span>
                  </RankRow>
                ))}
                <p className="pt-2 text-[11px] text-muted-foreground">
                  共 {all.length} 只;上面是前 {rows.length} 只
                </p>
              </div>
            );
          }}
        </Block>
      </div>

      <Block b={block("board_flow")}>
        {(res) => {
          const rows = sortBy(pivot(res.envelope), "board_main_net_today");
          const top = rows.slice(0, 10);
          const bottom = rows.slice(-5).reverse();
          // 🔴 标题按**实际数字**说话:尾部若仍是正数,那就不是"净流出",别硬安一个名字。
          const tailNet = num(bottom[0]?.fields.board_main_net_today);
          const tailIsOutflow = typeof tailNet === "number" && tailNet < 0;
          const list = (rs: Row[], from: number) =>
            rs.map((r, i) => (
              <RankRow key={r.key} i={from + i} label={labelOf(r)}>
                <MoneyCell ev={r.fields.board_main_net_today} className="w-24 shrink-0 text-right" />
                <span className="w-16 shrink-0 text-right">
                  <PctCell ev={r.fields.board_main_pct_today} plain />
                </span>
                <span className="w-16 shrink-0 text-right">
                  <PctCell ev={r.fields.board_change_pct_today} />
                </span>
              </RankRow>
            ));
          return (
            <div>
              <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                <span className="w-5" />
                <span className="flex-1">板块</span>
                <span className="w-24 text-right">主力净额</span>
                <span className="w-16 text-right">净占比</span>
                <span className="w-16 text-right">涨跌</span>
              </div>
              {list(top, 0)}
              <div className="pb-1 pt-3 text-[11px] text-muted-foreground">
                {tailIsOutflow ? "净流出最多" : "净流入最少(今日没有板块净流出)"}
              </div>
              {list(bottom, rows.length - bottom.length)}
            </div>
          );
        }}
      </Block>

      <div className="grid gap-4 xl:grid-cols-2">
        <Block b={block("zt_pool")}>
          {(res) => {
            const rows = sortBy(pivot(res.envelope), "pool_limit_days").slice(0, 14);
            return (
              <div>
                <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                  <span className="w-5" />
                  <span className="flex-1">标的</span>
                  <span className="w-10 text-right">连板</span>
                  <span className="w-20 text-right">封单</span>
                </div>
                {rows.map((r, i) => (
                  <RankRow key={r.key} i={i} label={labelOf(r)}>
                    <span className="tnum w-10 shrink-0 text-right">
                      {num(r.fields.pool_limit_days) ?? "—"}
                      <span className="ml-0.5 text-[10.5px] text-muted-foreground">板</span>
                    </span>
                    <MoneyCell ev={r.fields.pool_seal_fund} className="w-20 shrink-0 text-right" />
                  </RankRow>
                ))}
                <p className="pt-2 text-[11px] text-muted-foreground">
                  涨停池共 {show(scalar(res.envelope, "limit_up_pool_count"))} 只
                </p>
              </div>
            );
          }}
        </Block>

        <Block b={block("dragon")}>
          {(res) => {
            const rows = sortBy(pivot(res.envelope), "dragon_tiger_market_net_buy").slice(0, 14);
            return (
              <div>
                <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                  <span className="w-5" />
                  <span className="flex-1">标的与上榜理由</span>
                  <span className="w-20 text-right">净买额</span>
                  <span className="w-14 text-right">涨跌</span>
                </div>
                {rows.map((r, i) => (
                  <RankRow key={r.key} i={i} label={r.note || r.key}>
                    <MoneyCell ev={r.fields.dragon_tiger_market_net_buy} className="w-20 shrink-0 text-right" />
                    <span className="w-14 shrink-0 text-right">
                      <PctCell ev={r.fields.dragon_tiger_market_change_pct} />
                    </span>
                  </RankRow>
                ))}
              </div>
            );
          }}
        </Block>
      </div>

      <AskAgent prompt={"就今天的板块资金流与涨停梯队,帮我判断:这是一次有产业逻辑的资金转向,还是纯情绪轮动?列出要区分这两者还缺哪些证据。"}>就今天的盘面问 Agent</AskAgent>
        </div>
      )}
    </PageShell>
  );
}
