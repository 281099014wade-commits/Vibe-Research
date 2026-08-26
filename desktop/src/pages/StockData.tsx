import { Search } from "lucide-react";
import { useCallback, useState } from "react";

import { EnvelopeMeta, EvidenceTable, Metric, moveTone, pick, show } from "../components/ui/envelope";
import { Async, Badge, Card, CardHead } from "../components/ui/primitives";
import { api, type FetchResult } from "../lib/api";
import { useUi } from "../lib/store";
import { useAsync } from "../lib/useAsync";

const A_SHARE = /^(6\d{5}|0\d{5}|3\d{5})$/;

/** 行情 + 公司资料 + 研究归档:三样一起要;慢的那样(技术指标约 10 秒)放到按需,不拖首屏。 */
function Overview({ symbol }: { symbol: string }) {
  const openDock = useUi((s) => s.openDock);
  const fn = useCallback(
    () =>
      Promise.all([
        api.fetch({ endpoint: "tx_quote", symbol }),
        api.fetch({ endpoint: "fetch_profile", symbol }),
        api.knowledge("CN", symbol),
      ]),
    [symbol],
  );
  const { state, reload } = useAsync(fn, [symbol]);

  return (
    <Async state={state} onRetry={reload}>
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

            <button
              type="button"
              onClick={() =>
                openDock(
                  `${show(name)}(${symbol})现价 ${show(pick(env, "price"))} 元、PE(TTM) ${show(pick(env, "pe_ttm"))} 倍。帮我列出:要判断这个估值贵不贵,还缺哪几个事实?`,
                )
              }
              className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
            >
              就这只标的问 Agent
            </button>
          </div>
        );
      }}
    </Async>
  );
}

/** 慢端点按需取:技术指标要跑 baostock,实测约 10 秒 —— 不能拖住首屏。 */
function OnDemand({ symbol, endpoint, title, note }: { symbol: string; endpoint: string; title: string; note: string }) {
  const [res, setRes] = useState<FetchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <Card>
      <CardHead
        title={title}
        note={note}
        right={
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setErr(null);
              api
                .fetch({ endpoint, symbol })
                .then(setRes)
                .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
            className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "取数中…" : res ? "重新取数" : "取数"}
          </button>
        }
      />
      {err ? <p className="text-[12px] text-warning">取数失败:{err}</p> : null}
      {res ? (
        <div className="space-y-2">
          <EnvelopeMeta env={res.envelope} ms={res.duration_ms} />
          <EvidenceTable env={res.envelope} />
        </div>
      ) : busy ? null : (
        <p className="text-[12px] text-muted-foreground">按需取数:这一项要现算,点右上角才跑。</p>
      )}
    </Card>
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

      <div className="grid gap-4 xl:grid-cols-2">
        <OnDemand
          symbol={symbol}
          endpoint="indicators_cn"
          title="技术指标"
          note="均线 / MACD / RSI / KDJ,由 baostock 前复权数据现算(约 10 秒)"
        />
        <OnDemand symbol={symbol} endpoint="fetch_financials" title="财务事实" note="报表科目原值与资料期;派生比率走计算层" />
      </div>
    </div>
  );
}
