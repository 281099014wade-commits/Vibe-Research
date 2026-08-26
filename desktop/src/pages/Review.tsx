import type { ReactNode } from "react";

import { EndpointPanel } from "../components/ui/EndpointPanel";
import { Metric, MoneyCell, PctCell, show } from "../components/ui/envelope";
import { Card, CardHead } from "../components/ui/primitives";
import { labelOf, num, pivot, scalar, sortBy, type Row } from "../lib/records";
import { useUi } from "../lib/store";

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
  const openDock = useUi((s) => s.openDock);

  return (
    <div className="space-y-4">
      <Card>
        <CardHead
          title="这一页在回答什么"
          note="收盘后一屏看懂:今天场内的钱在哪些板块、情绪多热、谁在被买。喂的是中长期建仓择时,不是日内。"
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          每个数字都挂着资料期与证据 id(悬停可见)。这一页只呈现事实,不排"该买什么"。
        </p>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointPanel endpoint="em_limit_up_sentiment" title="情绪" note="涨停 / 炸板 / 跌停三个计数">
          {(res) => (
            <div className="grid grid-cols-3 gap-4">
              {/* 涨停红、跌停绿:A 股口径,说的是方向不是好坏 */}
              <Metric label="涨停" ev={scalar(res.envelope, "limit_up_count")} tone="danger" big />
              <Metric label="炸板" ev={scalar(res.envelope, "break_board_count")} tone="warning" big />
              <Metric label="跌停" ev={scalar(res.envelope, "limit_down_count")} tone="success" big />
            </div>
          )}
        </EndpointPanel>

        <EndpointPanel
          endpoint="ths_hot_reason"
          title="强势股原因"
          note="同花顺给的题材归因;是市场叙事,不是核验过的因果"
        >
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
        </EndpointPanel>
      </div>

      <EndpointPanel
        endpoint="em_board_fund_flow"
        title="板块资金流(行业 · 今日)"
        note="主力净额从大到小。净额是全市场口径,不等于某一只标的的买卖"
      >
        {(res) => {
          const rows = sortBy(pivot(res.envelope), "board_main_net_today");
          const top = rows.slice(0, 10);
          const bottom = rows.slice(-5).reverse();
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
              <div className="pb-1 pt-3 text-[11px] text-muted-foreground">净流出最多</div>
              {list(bottom, rows.length - bottom.length)}
            </div>
          );
        }}
      </EndpointPanel>

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointPanel endpoint="em_zt_pool" title="涨停梯队" note="按连板数排;说明栏是取数层原文(含首封时间)">
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
        </EndpointPanel>

        <EndpointPanel
          endpoint="em_daily_dragon_tiger"
          title="龙虎榜"
          note="按净买额排;同一只标的可能因多条上榜理由重复出现"
        >
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
        </EndpointPanel>
      </div>

      <button
        type="button"
        onClick={() =>
          openDock(
            "就今天的板块资金流与涨停梯队,帮我判断:这是一次有产业逻辑的资金转向,还是纯情绪轮动?列出要区分这两者还缺哪些证据。",
          )
        }
        className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
      >
        就今天的盘面问 Agent
      </button>
    </div>
  );
}
