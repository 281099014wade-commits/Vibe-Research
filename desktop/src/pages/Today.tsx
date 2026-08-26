import { ArrowRight } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { EndpointPanel } from "../components/ui/EndpointPanel";
import { Metric, MoneyCell, PctCell, show } from "../components/ui/envelope";
import { Async, Badge, Card, CardHead, statusTone } from "../components/ui/primitives";
import { api } from "../lib/api";
import { labelOf, pivot, scalar, sortBy } from "../lib/records";
import { useUi } from "../lib/store";
import { useAsync } from "../lib/useAsync";

function More({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-primary"
    >
      {children}
      <ArrowRight className="h-3 w-3" aria-hidden />
    </Link>
  );
}

/** 最近的研究运行:这是"我自己做过什么"的那一半,与行情并列才叫经营看板 */
function RecentRuns() {
  const fn = useCallback(() => api.runs(8), []);
  const { state, reload } = useAsync(fn, []);
  return (
    <Card>
      <CardHead title="最近的研究" note="每次运行都留下报告与证据台账" right={<More to="/data">全部运行</More>} />
      <Async state={state} onRetry={reload} isEmpty={(rs) => rs.length === 0} emptyText="还没有运行过研究">
        {(runs) => (
          <div>
            {runs.slice(0, 6).map((r) => (
              <div key={r.run_id} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate font-mono">{r.run_id}</span>
                <span className="tnum w-16 shrink-0 text-right text-muted-foreground">{r.symbol ?? "—"}</span>
                <Badge tone={statusTone(r.status)}>{r.status ?? "?"}</Badge>
              </div>
            ))}
          </div>
        )}
      </Async>
    </Card>
  );
}

export function Today() {
  const openDock = useUi((s) => s.openDock);

  return (
    <div className="space-y-4">
      <EndpointPanel endpoint="tx_quotes_batch" title="大盘" note="指数与宽基 ETF;红涨绿跌">
        {(res) => (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
            {pivot(res.envelope).map((r) => (
              <div key={r.key} className="min-w-0">
                <div className="truncate text-[11.5px] text-muted-foreground" title={r.note}>
                  {show(r.fields.security_name)}
                </div>
                <div className="tnum mt-0.5 text-[15px] font-medium">{show(r.fields.price)}</div>
                <div className="mt-0.5 text-[11.5px]">
                  <PctCell ev={r.fields.change_pct} />
                </div>
              </div>
            ))}
          </div>
        )}
      </EndpointPanel>

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointPanel endpoint="em_limit_up_sentiment" title="今日情绪" note="涨停 / 炸板 / 跌停">
          {(res) => (
            <div>
              <div className="grid grid-cols-3 gap-4">
                <Metric label="涨停" ev={scalar(res.envelope, "limit_up_count")} tone="danger" big />
                <Metric label="炸板" ev={scalar(res.envelope, "break_board_count")} tone="warning" big />
                <Metric label="跌停" ev={scalar(res.envelope, "limit_down_count")} tone="success" big />
              </div>
              <div className="mt-3">
                <More to="/review">看今天的完整复盘</More>
              </div>
            </div>
          )}
        </EndpointPanel>

        <EndpointPanel endpoint="em_board_fund_flow" title="资金去了哪" note="主力净额前 5 个行业板块">
          {(res) => (
            <div>
              {sortBy(pivot(res.envelope), "board_main_net_today")
                .slice(0, 5)
                .map((r, i) => (
                  <div key={r.key} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                    <span className="tnum w-4 shrink-0 text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{labelOf(r)}</span>
                    <MoneyCell ev={r.fields.board_main_net_today} className="w-24 shrink-0 text-right" />
                    <span className="w-14 shrink-0 text-right">
                      <PctCell ev={r.fields.board_change_pct_today} />
                    </span>
                  </div>
                ))}
              <div className="mt-2">
                <More to="/sectors">看全部板块</More>
              </div>
            </div>
          )}
        </EndpointPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointPanel endpoint="em_hot_rank" title="人气榜" note="东财人气排名;是关注度,不是资金也不是基本面">
          {(res) => (
            <div>
              {/* 取数层已把字段名改对:`change_pct` 是涨跌幅、`hot_rank_chg` 才是名次变化。
                  旧版两者挤在一个叫"排名变化百分比"的字段里 —— 字段名会喂给 agent,骗人的名字比缺数据更糟。 */}
              <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                <span className="w-4" />
                <span className="flex-1">标的</span>
                <span className="w-16 text-right">名次变化</span>
                <span className="w-16 text-right">现价</span>
                <span className="w-14 text-right">涨跌</span>
              </div>
              {pivot(res.envelope)
                .slice(0, 8)
                .map((r, i) => (
                  <div key={r.key} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                    <span className="tnum w-4 shrink-0 text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate" title={r.note}>
                      {labelOf(r)}
                    </span>
                    {/* 名次变化不套涨跌色 —— 它不是价格方向 */}
                    <span className="tnum w-16 shrink-0 text-right text-muted-foreground">
                      {show(r.fields.hot_rank_chg)}
                    </span>
                    <span className="tnum w-16 shrink-0 text-right">{show(r.fields.price)}</span>
                    <span className="w-14 shrink-0 text-right">
                      <PctCell ev={r.fields.change_pct} />
                    </span>
                  </div>
                ))}
              <div className="mt-2">
                <More to="/radar">看资讯与市场声音</More>
              </div>
            </div>
          )}
        </EndpointPanel>

        <RecentRuns />
      </div>

      <Card className="border-dashed">
        <CardHead title="还差什么" note="这一页只到「发生了什么」;要到「该不该动」,缺的是下面这块" />
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          真正的总览应该先说<span className="text-foreground">偏离</span>
          :我写下的计划是什么、今天哪几条离它更远了。 那需要一块还不存在的后端能力 ——
          读写自己的持仓、计划与行动记录(见「计划与风险」)。 在它建好之前,这一页只做事实汇总,不假装能判断"要不要管"。
        </p>
      </Card>

      <button
        type="button"
        onClick={() =>
          openDock("就今天的大盘、情绪与板块资金,总结三条值得记下来的事实,并各写一条「要推翻它需要看到什么」。")
        }
        className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
      >
        就今天问 Agent
      </button>
    </div>
  );
}
