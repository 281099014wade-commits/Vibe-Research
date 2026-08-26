import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, type FetchResult } from "../../../core/lib/api";
import { num, pivot, type Row } from "../../../core/lib/records";
import { DUE_LABEL, dueState, numOf, recordsOf, str, useLedgerData, type DueState } from "../../../core/lib/useLedger";
import { useAsync } from "../../../core/lib/useAsync";
import { PctCell, moveTone, show } from "../../../core/ui/envelope";
import { Badge, cx } from "../../../core/ui/primitives";
import { Section } from "../../../core/ui/Section";

/**
 * 今日总览里**属于我自己的**那三块:今日计划 / 持有 / 自选。
 *
 * 🔴 与上面的盘面数据是两种东西:盘面是**外部事实**(取数层),这三块是**我自己写下的**
 *    (台账)。合在一屏才回答得了"今天该管什么" —— 只有盘面时,用户得自己在脑子里对账。
 * ⚠️ 一条建议都不给:到期只说"该判了",不说该怎么判;浮动盈亏只是把自己填的成本与
 *    公开价格做了一次减法,不是任何操作提示。
 */

/** 到期就该处理的两类:待办与判据。**按紧迫度排**,没写到期日的沉底(最容易被永远忘掉) */
const ORDER: Record<DueState, number> = { overdue: 0, today: 1, soon: 2, later: 3, none: 4 };
const DUE_TONE: Record<DueState, "danger" | "warning" | "primary" | "neutral"> = {
  overdue: "danger", today: "warning", soon: "primary", later: "neutral", none: "neutral",
};

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-1 text-[11.5px] leading-relaxed text-muted-foreground">{children}</p>;
}

/** 今日计划:今天(或已过期)该处理的判据与待办 */
function TodayPlan() {
  const s = useLedgerData();
  const rows = useMemo(() => {
    if (s.phase !== "ready") return [];
    const items = [
      ...recordsOf(s, "criterion")
        .filter((c) => str(c, "status") === "" || str(c, "status") === "pending")
        .map((r) => ({ id: r.id, kind: "判据", title: str(r, "statement"), due: str(r, "due"), symbol: str(r, "symbol") })),
      ...recordsOf(s, "action")
        .filter((a) => !["done", "dropped"].includes(str(a, "status")))
        .map((r) => ({ id: r.id, kind: "待办", title: str(r, "title"), due: str(r, "due"), symbol: str(r, "symbol") })),
    ];
    // 只留"今天该看的":已过期 / 今天到期 / 临近。很远的不占今天这一屏
    return items
      .filter((i) => ["overdue", "today", "soon"].includes(dueState(i.due)))
      .sort((a, b) => (ORDER[dueState(a.due)] ?? 9) - (ORDER[dueState(b.due)] ?? 9) || a.due.localeCompare(b.due));
  }, [s]);

  if (s.phase === "error") return <Empty>台账读不出来:{s.error}</Empty>;
  if (s.phase !== "ready") return <Empty>读取台账…</Empty>;
  if (!rows.length) {
    return (
      <Empty>
        今天没有到期的判据或待办。
        <Link to="/plan" className="mx-1 text-primary hover:underline">
          去「计划与判据」写一条
        </Link>
        —— 先写下判据,后面才谈得上"偏离了多少"。
      </Empty>
    );
  }
  return (
    <div>
      {rows.map((r) => {
        const d = dueState(r.due);
        return (
          <div key={r.id} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
            <Badge tone={DUE_TONE[d]}>{DUE_LABEL[d]}</Badge>
            <span className="w-8 shrink-0 text-muted-foreground">{r.kind}</span>
            <span className="min-w-0 flex-1 truncate" title={r.title}>{r.title}</span>
            {r.symbol ? <span className="tnum w-16 shrink-0 text-right text-muted-foreground">{r.symbol}</span> : null}
            <span className="tnum w-20 shrink-0 text-right text-muted-foreground">{r.due || "无到期日"}</span>
          </div>
        );
      })}
      <p className="pt-2 text-[11px] text-muted-foreground">到期只提醒「该判了」,判定仍然由自己写进台账。</p>
    </div>
  );
}

/**
 * 持有与自选**共用一次行情取数** —— 同一屏里两块的价格必须来自同一时刻,
 * 分两次取会出现"上面一个价、下面另一个价",而用户会以为是数据坏了。
 */
function useQuotes(codes: string[]) {
  const key = [...new Set(codes)].sort().join(",");
  return useAsync<FetchResult | null>(
    (refresh) =>
      key ? api.fetch({ endpoint: "tx_quotes_batch", args: { codes: key.split(",") }, refresh }) : Promise.resolve(null),
    [key],
  );
}

export function MyDay() {
  const s = useLedgerData();
  const positions = s.phase === "ready" ? recordsOf(s, "position") : [];
  const watches = s.phase === "ready" ? recordsOf(s, "watch") : [];
  const codes = [...positions, ...watches].map((r) => str(r, "symbol")).filter(Boolean);
  const { state, reload } = useQuotes(codes);

  const quotes = new Map<string, Row>(
    state.phase === "ready" && state.data ? pivot(state.data.envelope).map((r) => [r.key, r] as const) : [],
  );

  /** 浮动盈亏:(现价 − 自己填的成本) × 数量。**只是一次减法**,不含任何操作含义 */
  const pnlOf = (shares: number | null, cost: number | null, price: number | null) =>
    shares !== null && cost !== null && price !== null ? (price - cost) * shares : null;

  // 🔴 有一只取不到价就单独计数,**不当 0 算进合计** —— 那会给出一个偏小、看着却很正常的假合计
  const totals = positions.reduce(
    (acc, r) => {
      const v = pnlOf(numOf(r, "shares"), numOf(r, "cost"), num(quotes.get(str(r, "symbol"))?.fields.price));
      return v === null ? { sum: acc.sum, missing: acc.missing + 1 } : { sum: acc.sum + v, missing: acc.missing };
    },
    { sum: 0, missing: 0 },
  );

  const quoteNote =
    state.phase === "error"
      ? `行情取不到:${state.error}`
      : state.phase === "ready" && state.data
        ? `行情资料期 ${state.data.envelope.fetched_at.slice(0, 16).replace("T", " ")}${state.data.cached ? "(上次取的,没有重新取)" : ""}`
        : "读取行情…";

  const money = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  const moveCls = (v: number) => (moveTone(v) === "danger" ? "text-danger" : moveTone(v) === "success" ? "text-success" : "");

  return (
    <div className="space-y-4">
      <Section id="my.plan" title="今日计划" note="今天到期、或已经过期的判据与待办">
        <TodayPlan />
      </Section>

      <Section
        id="my.positions"
        title="持有"
        note="自己填的成本与数量 × 公开价格;浮动盈亏只是一次减法,不含任何操作含义"
        right={
          // ⚠️ 不能用 <button>:它嵌在 Section 的标题按钮里,嵌套 button 是非法 HTML
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); reload(true); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); reload(true); } }}
            className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
          >
            刷新行情
          </span>
        }
      >
        {s.phase !== "ready" ? (
          <Empty>读取台账…</Empty>
        ) : !positions.length ? (
          <Empty>
            还没有记录。<Link to="/operate" className="text-primary hover:underline">去「持仓」加一条</Link>
          </Empty>
        ) : (
          <div>
            <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
              <span className="w-16">代码</span>
              <span className="flex-1">名称</span>
              <span className="w-20 text-right">现价</span>
              <span className="w-16 text-right">涨跌</span>
              <span className="w-20 text-right">成本</span>
              <span className="w-24 text-right">浮动盈亏</span>
            </div>
            {positions.map((p) => {
              const code = str(p, "symbol");
              const q = quotes.get(code);
              const v = pnlOf(numOf(p, "shares"), numOf(p, "cost"), num(q?.fields.price));
              return (
                <div key={p.id} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]" title={q?.note}>
                  <span className="tnum w-16 shrink-0 text-muted-foreground">{code}</span>
                  <span className="min-w-0 flex-1 truncate">{q ? show(q.fields.security_name) : str(p, "name") || "—"}</span>
                  <span className="tnum w-20 shrink-0 text-right">{q ? show(q.fields.price) : "未覆盖"}</span>
                  <span className="w-16 shrink-0 text-right">{q ? <PctCell ev={q.fields.change_pct} /> : null}</span>
                  <span className="tnum w-20 shrink-0 text-right text-muted-foreground">{numOf(p, "cost") ?? "—"}</span>
                  <span className={cx("tnum w-24 shrink-0 text-right", v === null ? "text-muted-foreground" : moveCls(v))}>
                    {v === null ? "未覆盖" : money(v)}
                  </span>
                </div>
              );
            })}
            <div className="flex items-baseline gap-2 pt-2 text-[11.5px]">
              <span className="flex-1 text-muted-foreground">合计浮动盈亏</span>
              <span className={cx("tnum text-right font-medium", moveCls(totals.sum))}>{money(totals.sum)}</span>
            </div>
            {totals.missing ? (
              <p className="pt-1 text-[11px] text-warning">
                ⚠️ 有 {totals.missing} 只取不到价格,没有算进上面的合计 —— 这个合计是不完整的。
              </p>
            ) : null}
            <p className="pt-1 text-[11px] text-muted-foreground">{quoteNote}</p>
          </div>
        )}
      </Section>

      <Section id="my.watch" title="自选" note="只是盯着它 —— 和持有是两张表,这里出现不代表持有" defaultOpen={false}>
        {s.phase !== "ready" ? (
          <Empty>读取台账…</Empty>
        ) : !watches.length ? (
          <Empty>
            还没有自选。<Link to="/operate" className="text-primary hover:underline">去「持仓」页加</Link>
          </Empty>
        ) : (
          <div>
            {watches.map((w) => {
              const code = str(w, "symbol");
              const q = quotes.get(code);
              return (
                <div key={w.id} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]" title={q?.note}>
                  <span className="tnum w-16 shrink-0 text-muted-foreground">{code}</span>
                  <span className="min-w-0 flex-1 truncate">{q ? show(q.fields.security_name) : str(w, "name") || "—"}</span>
                  {str(w, "tag") ? <Badge>{str(w, "tag")}</Badge> : null}
                  <span className="tnum w-20 shrink-0 text-right">{q ? show(q.fields.price) : "未覆盖"}</span>
                  <span className="w-16 shrink-0 text-right">{q ? <PctCell ev={q.fields.change_pct} /> : null}</span>
                </div>
              );
            })}
            <p className="pt-1 text-[11px] text-muted-foreground">{quoteNote}</p>
          </div>
        )}
      </Section>
    </div>
  );
}
