import { ArrowRight } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Block, PageShell } from "../../../core/ui/PageShell";
import { Metric, MoneyCell, PctCell, show } from "../../../core/ui/envelope";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Async, Badge, Card, CardHead, statusTone } from "../../../core/ui/primitives";
import { api } from "../../../core/lib/api";
import { MyDay } from "../components/MyDay";
import { labelOf, pivot, scalar, sortBy } from "../../../core/lib/records";
import { useAsync } from "../../../core/lib/useAsync";

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

/** 最近的研究运行:这是"我自己做过什么"的那一半,与行情并列才是完整的一屏 */
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

  return (
    <PageShell query="today">
      {({ block }) => (
        <div className="space-y-4">
      <Block b={block("indices")}>
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
      </Block>

      <div className="grid gap-4 xl:grid-cols-2">
        <Block b={block("sentiment")}>
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
        </Block>

        <Block b={block("board_flow")}>
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
        </Block>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* 成交额榜:全市场今天钱最集中在哪几只。**客观公开榜单,不含推荐** */}
        <Block b={block("turnover")}>
          {(res) => (
            <div>
              <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                <span className="w-4" />
                <span className="flex-1">标的</span>
                <span className="w-24 text-right">成交额</span>
                <span className="w-14 text-right">涨跌</span>
              </div>
              {pivot(res.envelope)
                .slice(0, 10)
                .map((r, i) => (
                  <div key={r.key} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                    <span className="tnum w-4 shrink-0 text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate" title={r.note}>
                      {labelOf(r)}
                    </span>
                    <MoneyCell ev={r.fields.turnover_amount} className="w-24 shrink-0 text-right" />
                    <span className="w-14 shrink-0 text-right">
                      <PctCell ev={r.fields.change_pct} />
                    </span>
                  </div>
                ))}
            </div>
          )}
        </Block>

        <Block b={block("hot")}>
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
        </Block>

        <RecentRuns />
      </div>

      {/* 盘面之后是**我自己的**那几块:计划 / 持有 / 自选。
          先看市场在发生什么,再看它跟我写下的东西对不对得上 —— 顺序是有意的。 */}
      <MyDay />

      <Card className="border-dashed">
        <CardHead title="这一页到哪为止" note="它把「市场在发生什么」和「我写下了什么」并排放在一起,到此为止" />
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          到期的判据会自己浮上来、持有会跟着价格走 —— 但<span className="text-foreground">该不该动</span>
          由你自己判断。产品只负责把两边摆齐、把该判的那条提到眼前,不替你下结论、也不给操作建议。
        </p>
      </Card>

      <AskAgent prompt={"就今天的大盘、情绪与板块资金,总结三条值得记下来的事实,并各写一条「要推翻它需要看到什么」。"}>就今天问 Agent</AskAgent>
        </div>
      )}
    </PageShell>
  );
}
