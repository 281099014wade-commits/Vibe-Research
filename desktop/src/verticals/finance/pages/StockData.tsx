import { Search } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { DataBar, oldestOf } from "../../../core/ui/DataBar";
import { EnvelopeMeta, Metric, compact, moveTone, pick, show } from "../../../core/ui/envelope";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Async, Badge, Card, CardHead } from "../../../core/ui/primitives";
import { api, type FetchResult } from "../../../core/lib/api";
import { useAsync } from "../../../core/lib/useAsync";

const A_SHARE = /^(6\d{5}|0\d{5}|3\d{5})$/;

/** 行情 + 公司资料 + 研究归档:三样一起要(技术指标与财务事实各自成块,见下面的 AutoPanel)。 */
function Overview({ symbol }: { symbol: string }) {
  const fn = useCallback(
    (refresh: boolean) =>
      Promise.all([
        api.fetch({ endpoint: "tx_quote", symbol, refresh }),
        api.fetch({ endpoint: "fetch_profile", symbol, refresh }),
        api.knowledge("CN", symbol),
      ]),
    [symbol],
  );
  const { state, reload } = useAsync(fn, [symbol]);

  // 默认拿的是**上次的快照**(见 service.fetchEndpoint):必须把取数时刻显示出来 + 给真取数的入口。
  // ⚠️ 三个来源里第三个是知识层召回(本地读盘、不取数),没有取数时刻 —— 只算前两个真取数的。
  const _res = state.phase === "ready" ? state.data : null;
  const dataBar = (
    <DataBar
      fetchedAt={oldestOf([_res?.[0]?.fetched_at, _res?.[1]?.fetched_at])}
      cached={Boolean(_res?.[0]?.cached || _res?.[1]?.cached)}
      loading={state.phase === "loading"}
      onRefresh={() => reload(true)}
    />
  );


  return (
    <>
      {dataBar}
      <Async state={state} onRetry={() => reload()}>
      {([q, p, know]) => {
        const env = q.envelope;
        const name = pick(env, "security_name");
        const chg = pick(env, "change_pct");
        const prof = p.envelope;
        return (
          <div className="space-y-4">
            <Card glow>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-[19px] font-semibold">{show(name)}</h2>
                <span className="tnum text-[13px] text-muted-foreground">{symbol}</span>
                <div className="ml-auto">
                  <EnvelopeMeta env={env} ms={q.duration_ms} />
                </div>
              </div>
              {/* A 股口径:涨红跌绿。这里的红绿说的是方向,不是"好坏"。 */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <Metric label="现价" ev={pick(env, "price")} tone={moveTone(chg?.value)} big />
                <Metric label="涨跌幅" ev={chg} tone={moveTone(chg?.value)} big />
                <Metric label="今开" ev={pick(env, "open")} />
                <Metric label="最高" ev={pick(env, "high")} />
                <Metric label="最低" ev={pick(env, "low")} />
                <Metric label="昨收" ev={pick(env, "last_close")} />
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHead title="估值" note="按数据源原样呈现;PEG 一类派生指标走计算层,不在页面里手搓" />
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Metric label="PE(TTM)" ev={pick(env, "pe_ttm")} />
                  <Metric label="PE(静)" ev={pick(env, "pe_static")} />
                  <Metric label="PB" ev={pick(env, "pb")} />
                  <Metric label="总市值" ev={pick(env, "market_cap")} />
                  <Metric label="流通市值" ev={pick(env, "float_market_cap")} />
                  <Metric label="量比" ev={pick(env, "volume_ratio")} />
                </div>
              </Card>

              <Card>
                <CardHead title="公司与交投" note={`资料源 ${prof.primary_source ?? "—"}`} />
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Metric label="换手率" ev={pick(env, "turnover_rate")} />
                  <Metric label="成交额" ev={pick(env, "turnover_amount")} />
                  <Metric label="上市日" ev={pick(prof, "ipo_date")} />
                  <Metric label="总股本" ev={pick(prof, "total_shares")} />
                  <Metric label="流通股本" ev={pick(prof, "float_shares")} />
                  <Metric label="行业" ev={pick(prof, "industry_em")} />
                </div>
                {prof.status !== "ok" ? (
                  <p className="mt-3 text-[11.5px] text-warning">
                    公司资料取数 {prof.status}
                    {prof.errors.length ? `:${JSON.stringify(prof.errors[0]).slice(0, 120)}` : ""}
                  </p>
                ) : null}
              </Card>
            </div>

            <Card>
              <CardHead
                title="研究归档"
                note="这家公司之前有没有跑过完整研究、结论还新不新"
                right={
                  know ? (
                    <Badge tone={know.status === "fresh" ? "success" : "warning"}>
                      {know.status === "fresh" ? "仍在有效期" : "已过期"}
                    </Badge>
                  ) : null
                }
              />
              {know ? (
                <div className="text-[12.5px] leading-relaxed">
                  <p className="text-muted-foreground">
                    归档于 <span className="tnum text-foreground">{know.as_of}</span> · 有效期{" "}
                    <span className="tnum text-foreground">{know.valid_days}</span> 天
                    {know.run_id ? (
                      <>
                        {" "}
                        · 来自 <span className="font-mono text-foreground">{know.run_id}</span>
                      </>
                    ) : null}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap">{know.text.slice(0, 600)}</p>
                  {know.truncated || know.text.length > 600 ? (
                    <p className="mt-1 text-[11.5px] text-muted-foreground">(已截断,完整内容在「研究与数据」里)</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  还没有这家的研究归档。到下方对话里写「研究 {symbol}」会真的跑一次六阶段研究,跑完自动归档。
                </p>
              )}
            </Card>

            <AskAgent prompt={`${show(name)}(${symbol})现价 ${show(pick(env, "price"))} 元、PE(TTM) ${show(pick(env, "pe_ttm"))} 倍。帮我列出:要判断这个估值贵不贵,还缺哪几个事实?`}>就这只标的问 Agent</AskAgent>
          </div>
        );
      }}
      </Async>
    </>
  );
}

/**
 * 自动取的一块。**默认读上次的快照**,所以"打开就有"并不等于"每次都重跑上游"。
 *
 * 🔴 以前这两块要点一下才取,理由写的是"约 10 秒,别拖首屏"。
 *    实测 indicators_cn 只要 3.4 秒 —— **那个理由是照着旧注释写的,没量过**。
 *    ⇒ 凡是"因为慢所以藏起来"的设计,先量一下到底多慢。
 */
function AutoPanel({
  symbol,
  endpoint,
  title,
  note,
  children,
}: {
  symbol: string;
  endpoint: string;
  title: string;
  note: string;
  children: (res: FetchResult) => ReactNode;
}) {
  const fn = useCallback((refresh: boolean) => api.fetch({ endpoint, symbol, refresh }), [endpoint, symbol]);
  const { state, reload } = useAsync(fn, [endpoint, symbol]);
  return (
    <Card>
      <CardHead
        title={title}
        note={note}
        right={
          <button
            type="button"
            disabled={state.phase === "loading"}
            onClick={() => reload(true)}
            className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.phase === "loading" ? "取数中…" : "重新取数"}
          </button>
        }
      />
      <Async state={state} onRetry={() => reload()}>
        {(res) => (
          <div className="space-y-3">
            {children(res)}
            <EnvelopeMeta env={res.envelope} ms={res.duration_ms} />
          </div>
        )}
      </Async>
    </Card>
  );
}

/** 一组指标:标题 + 若干格。分组名是**这个垂类的说法**,不是端点字段名 */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-muted-foreground">{title}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </div>
  );
}

/**
 * 技术指标:按人看得懂的分组摆出来,**不再把 `ind_macd_dif` 这种字段名印在界面上**。
 * ⚠️ 只呈现数值,不解读("金叉""超卖"都不写)—— 解读是判断,不是数据。
 */
function Indicators({ res }: { res: FetchResult }) {
  const e = res.envelope;
  const f = (name: string) => pick(e, name);
  const close = f("ind_close");
  // 均线在价格上方还是下方,只用来给个方向色;A 股口径:价高于线 = 红
  const vs = (ma: ReturnType<typeof pick>) => {
    const c = typeof close?.value === "number" ? close.value : null;
    const m = typeof ma?.value === "number" ? ma.value : null;
    return c === null || m === null ? undefined : moveTone(c - m);
  };
  return (
    <div className="space-y-3">
      <Group title="收盘与均线(颜色只表示价在线上还是线下,不含好坏)">
        <Metric label="收盘" ev={close} />
        <Metric label="MA5" ev={f("ind_ma5")} tone={vs(f("ind_ma5"))} />
        <Metric label="MA10" ev={f("ind_ma10")} tone={vs(f("ind_ma10"))} />
        <Metric label="MA20" ev={f("ind_ma20")} tone={vs(f("ind_ma20"))} />
        <Metric label="MA60" ev={f("ind_ma60")} tone={vs(f("ind_ma60"))} />
      </Group>
      <Group title="MACD">
        <Metric label="DIF" ev={f("ind_macd_dif")} />
        <Metric label="DEA" ev={f("ind_macd_dea")} />
        <Metric label="柱" ev={f("ind_macd_hist")} />
      </Group>
      <Group title="RSI / KDJ">
        <Metric label="RSI6" ev={f("ind_rsi6")} />
        <Metric label="RSI12" ev={f("ind_rsi12")} />
        <Metric label="RSI24" ev={f("ind_rsi24")} />
        <Metric label="K" ev={f("ind_kdj_k")} />
        <Metric label="D" ev={f("ind_kdj_d")} />
        <Metric label="J" ev={f("ind_kdj_j")} />
      </Group>
      <Group title="布林带">
        <Metric label="上轨" ev={f("ind_boll_upper")} />
        <Metric label="中轨" ev={f("ind_boll_middle")} />
        <Metric label="下轨" ev={f("ind_boll_lower")} />
        <Metric label="带宽" ev={f("ind_boll_bandwidth")} />
      </Group>
    </div>
  );
}

/** 报表科目的中文名。**只是显示名**,不改数、不换算(换算在 compact 里,而且带目标单位) */
const FIN_ROWS: { field: string; label: string }[] = [
  { field: "revenue_cum", label: "营业收入" },
  { field: "net_profit_parent_cum", label: "归母净利" },
  { field: "net_profit_deducted_cum", label: "扣非净利" },
  { field: "eps_basic_cum", label: "每股收益" },
];

/**
 * 财务事实:同一科目有十几个资料期,**按期排成一张表**才看得懂 ——
 * 平铺成证据列表时,同一个科目会连着出现十二行、彼此只差一个看不见的 period。
 * ⚠️ 都是**累计值**(cum):同一年内各期不可直接相减当单季,页面不做这个减法。
 */
function Financials({ res }: { res: FetchResult }) {
  const e = res.envelope;
  const byField = new Map<string, Map<string, (typeof e.evidence)[number]>>();
  for (const ev of e.evidence) {
    if (!byField.has(ev.field)) byField.set(ev.field, new Map());
    byField.get(ev.field)!.set(ev.period, ev);
  }
  // 期次倒序:最近的在左边
  const periods = [...new Set(e.evidence.map((x) => x.period))].sort().reverse().slice(0, 8);
  if (!periods.length) return <p className="text-[12px] text-muted-foreground">这次没有取到任何报表科目。</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[11.5px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="pb-1 text-left font-normal">科目</th>
            {periods.map((p) => (
              <th key={p} className="tnum pb-1 text-right font-normal">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FIN_ROWS.filter((r) => byField.has(r.field)).map((r) => (
            <tr key={r.field} className="border-t border-border/40">
              <td className="py-1.5 text-muted-foreground">{r.label}</td>
              {periods.map((p) => {
                const ev = byField.get(r.field)?.get(p);
                const c = compact(ev);
                return (
                  // 单元格里是换算后的数 ⇒ tooltip 必带原值与证据 id,否则"对得上"就丢了
                  <td
                    key={p}
                    className="tnum py-1.5 text-right"
                    title={ev ? `${show(ev)} ${ev.unit} · ${ev.id}` : undefined}
                  >
                    {ev ? (
                      <>
                        {c.text}
                        {c.unit ? <span className="ml-0.5 text-[10px] text-muted-foreground">{c.unit}</span> : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">未覆盖</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pt-2 text-[11px] text-muted-foreground">
        全部是累计值;同一年内各期不能直接相减当单季用,页面不替你做这个减法。
      </p>
    </div>
  );
}

export function StockData() {
  const [input, setInput] = useState("300308");
  const [symbol, setSymbol] = useState("300308");
  const valid = A_SHARE.test(input.trim());

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-input/60 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) setSymbol(input.trim());
              }}
              placeholder="六位 A 股代码"
              aria-label="股票代码"
              className="tnum w-32 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            type="button"
            disabled={!valid}
            onClick={() => setSymbol(input.trim())}
            className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            查询
          </button>
          {input.trim() && !valid ? (
            <span className="text-[11.5px] text-warning">要六位 A 股代码(6 / 0 / 3 开头)</span>
          ) : null}
          <span className="ml-auto text-[11.5px] text-muted-foreground">
            当前 <span className="tnum text-foreground">{symbol}</span>
          </span>
        </div>
      </Card>

      <Overview symbol={symbol} />

      <AutoPanel
        symbol={symbol}
        endpoint="indicators_cn"
        title="技术指标"
        note="均线 / MACD / RSI / KDJ / 布林带,由前复权日线现算;只给数,不给解读"
      >
        {(res) => <Indicators res={res} />}
      </AutoPanel>

      <AutoPanel
        symbol={symbol}
        endpoint="fetch_financials"
        title="财务事实"
        note="报表科目原值与资料期;派生比率(PEG 一类)走计算层,不在页面里手搓"
      >
        {(res) => <Financials res={res} />}
      </AutoPanel>
    </div>
  );
}
