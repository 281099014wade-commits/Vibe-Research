import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, FlaskConical, Loader2, Play, Save } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { backend } from "@/lib/backend";
import { addNote } from "@/lib/notes";
import { useAiPage } from "../../../core/ai/pageContext";

/** 后端下发的选项表。**前端不写死一份** —— 写死的那份迟早与真实实现对不上，
 *  而对不上的表现是「选了没反应」或「真实存在的选项不在列表里」，两种都看不出是配置漂移。 */
interface Catalog {
  styles: { key: string; label: string; holding: string; interval: string; min_bars: number; why_min: string }[];
  markets: { key: string; label: string; can_short: boolean; same_day_roundtrip: boolean;
             price_limit: string | null; lot: string; fees: string; currency: string }[];
  strategies: { key: string; label: string; note: string;
                params: Record<string, { default: number; label: string }> }[];
}

interface RunResult {
  strategy: string;
  plan: { codes: string[]; market: string; engine: string; style: string; start: string; end: string;
          limits: string[]; notes: string[] };
  metrics: Record<string, number | string>;
  benchmark_is_self: boolean;
  missing: Record<string, string>;
  provenance: { code: string; endpoint: string; rows: number; first_bar: string | null;
                last_bar: string | null; note: string }[];
}

type Reply =
  | { ok: true; result: RunResult }
  | { ok: false; refused: { reason: string; remedy: string } }
  | { ok: false; error: string }
  | { ok: true; catalog: Catalog };

const pct = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(2)}%` : "—");
const num = (v: unknown, d = 2) => (typeof v === "number" ? v.toFixed(d) : "—");
const int = (v: unknown) => (typeof v === "number" ? String(v) : "—");

/** 指标怎么显示 —— 名字、取法、以及**这个数越大越好还是越小越好**（决定配色） */
const METRICS: { key: string; label: string; fmt: (v: unknown) => string; good?: "up" | "down" }[] = [
  { key: "total_return", label: "总收益", fmt: pct, good: "up" },
  { key: "annual_return", label: "年化", fmt: pct, good: "up" },
  { key: "max_drawdown", label: "最大回撤", fmt: pct, good: "up" },
  { key: "sharpe", label: "夏普", fmt: (v) => num(v), good: "up" },
  { key: "calmar", label: "卡玛", fmt: (v) => num(v), good: "up" },
  { key: "sortino", label: "索提诺", fmt: (v) => num(v), good: "up" },
  { key: "win_rate", label: "胜率", fmt: pct },
  { key: "profit_loss_ratio", label: "盈亏比", fmt: (v) => num(v) },
  { key: "trade_count", label: "交易笔数", fmt: int },
  { key: "avg_holding_days", label: "平均持仓天数", fmt: (v) => num(v, 1) },
];

const today = () => new Date().toISOString().slice(0, 10);
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};

export function Backtest() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogErr, setCatalogErr] = useState("");
  const [codes, setCodes] = useState("");
  const [start, setStart] = useState(yearsAgo(4));
  const [end, setEnd] = useState(today());
  const [style, setStyle] = useState("long");
  const [strategy, setStrategy] = useState("ma_cross");
  const [params, setParams] = useState<Record<string, number>>({});
  const [cash, setCash] = useState(1_000_000);
  const [running, setRunning] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const [fatal, setFatal] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    backend.runTool<Reply>("backtest", { action: "catalog" })
      .then((r) => { if ("catalog" in r && r.ok) setCatalog(r.catalog); })
      // 🔴 选项表拿不到就**说出来**：这时下面的下拉框是空的，
      //    不说的话用户看到的是「一个什么都选不了的表单」，分不清是坏了还是还没做
      .catch((e: unknown) => setCatalogErr(e instanceof Error ? e.message : String(e)));
    return () => abortRef.current?.abort();
  }, []);

  const strat = useMemo(
    () => catalog?.strategies.find((s) => s.key === strategy),
    [catalog, strategy],
  );
  const styleDef = useMemo(() => catalog?.styles.find((s) => s.key === style), [catalog, style]);

  const codeList = codes.split(/[,，\s]+/).map((c) => c.trim()).filter(Boolean);

  useAiPage(
    reply && "result" in reply && reply.ok
      ? {
          key: "backtest",
          title: "回测",
          context: [
            `策略：${reply.result.strategy}`,
            `标的：${reply.result.plan.codes.join(" ")}｜市场：${reply.result.plan.market}｜口径：${reply.result.plan.style}`,
            `区间：${reply.result.plan.start} → ${reply.result.plan.end}`,
            "指标：" + METRICS.map((m) => `${m.label} ${m.fmt(reply.result.metrics[m.key])}`).join("；"),
            `对照：${pct(reply.result.metrics.benchmark_return)}（${reply.result.benchmark_is_self ? "等权买入持有这几只标的本身，不是指数" : String(reply.result.metrics.benchmark_ticker)}）`,
            "这次回测的限制：" + reply.result.plan.limits.join("；"),
            "口径：" + reply.result.plan.notes.join("；"),
          ].join("\n"),
          suggestions: ["这个结果说明了什么", "这些限制会怎么影响结论", "跟买入持有比，差在哪"],
        }
      : null,
  );

  const go = async () => {
    setFatal("");
    setReply(null);
    if (!codeList.length) return setFatal("先填标的代码，如 600519.SH 或 AAPL");
    setRunning(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await backend.runTool<Reply>("backtest", {
        codes: codeList, start, end, style, strategy,
        params: { ...Object.fromEntries(Object.entries(strat?.params ?? {}).map(([k, v]) => [k, v.default])), ...params },
        initial_cash: cash,
      }, ac.signal);
      if (abortRef.current === ac) setReply(r);
    } catch (e: unknown) {
      if (ac.signal.aborted) return;
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      if (abortRef.current === ac) setRunning(false);
    }
  };

  const res = reply && reply.ok && "result" in reply ? reply.result : null;
  const refused = reply && !reply.ok && "refused" in reply ? reply.refused : null;
  const errored = reply && !reply.ok && "error" in reply ? reply.error : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="回测"
        subtitle="用你自己的规则跑一遍历史 · A股 / 美股 / 港股日线 · 每次都会先判断这个回测成不成立"
      />

      {catalogErr && (
        <GlassCard className="border-warning/40 bg-warning/5 p-4 text-sm">
          <AlertTriangle className="mr-1.5 inline h-4 w-4 text-warning" />
          选项表没取到（下面的下拉框会是空的）：{catalogErr}
        </GlassCard>
      )}

      {/* ── 参数 ── */}
      <GlassCard className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs text-muted-foreground">标的代码（多个用空格或逗号隔开）</span>
            <input
              value={codes}
              onChange={(e) => setCodes(e.target.value)}
              placeholder="600519.SH   或   AAPL NVDA   或   00700.HK"
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">开始</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">结束</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">口径</span>
            <select value={style} onChange={(e) => setStyle(e.target.value)}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
              {(catalog?.styles ?? []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">策略</span>
            <select value={strategy} onChange={(e) => { setStrategy(e.target.value); setParams({}); }}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
              {(catalog?.strategies ?? []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          {Object.entries(strat?.params ?? {}).map(([k, def]) => (
            <label key={k} className="space-y-1.5">
              <span className="text-xs text-muted-foreground">{def.label}</span>
              <input type="number" value={params[k] ?? def.default}
                onChange={(e) => setParams((p) => ({ ...p, [k]: Number(e.target.value) }))}
                className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm" />
            </label>
          ))}
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">起始资金（元）</span>
            <input type="number" value={cash} onChange={(e) => setCash(Number(e.target.value))}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm" />
          </label>
        </div>

        {styleDef && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <b className="text-foreground/80">{styleDef.label}</b>：{styleDef.holding}；
            至少约 {styleDef.min_bars} 根{styleDef.interval === "1D" ? "日线" : styleDef.interval}
            {styleDef.why_min ? ` —— ${styleDef.why_min}` : ""}
          </p>
        )}
        {strat?.note && <p className="text-xs text-muted-foreground">{strat.label}：{strat.note}</p>}

        <div className="flex items-center gap-3">
          <button onClick={() => void go()} disabled={running}
            className="inline-flex items-center gap-2 rounded-lg bg-primary/20 px-4 py-2 text-sm font-medium text-primary ring-1 ring-primary/40 transition-colors hover:bg-primary/30 disabled:opacity-50">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "取数并逐 bar 撮合中…" : "开始回测"}
          </button>
          {running && (
            // 🔴 几十秒是常态（要先拉几年日线再逐根撮合）。不说清楚的话，
            //    用户会以为卡住了 —— 一个转圈图标不足以表达"这本来就慢"。
            <span className="text-xs text-muted-foreground">
              要先拉取整段历史行情再逐根撮合，通常十几到几十秒，别关页面
            </span>
          )}
        </div>
      </GlassCard>

      {fatal && (
        <GlassCard className="border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-1.5 inline h-4 w-4" />{fatal}
        </GlassCard>
      )}

      {/* ── 被闸口拦住：这是**结论**，不是错误 ── */}
      {refused && (
        <GlassCard className="border-warning/40 bg-warning/[0.06] p-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warning">
            <Ban className="h-4 w-4" /> 这个回测不成立
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">{refused.reason}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            <b className="text-foreground/70">怎么才能跑：</b>{refused.remedy}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground/70">
            一个不成立的回测照样能算出夏普和最大回撤，数字排版整齐、看不出异常 ——
            所以这里直接拦住，不给你一份没有意义的报告。
          </p>
        </GlassCard>
      )}

      {errored && (
        <GlassCard className="border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-1.5 inline h-4 w-4" />{errored}
        </GlassCard>
      )}

      {/* ── 结果 ── */}
      {res && (
        <>
          <GlassCard className="p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="text-sm font-semibold text-glow">{res.strategy}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {res.plan.market} · {res.plan.style} · {res.plan.codes.join(" / ")} ·{" "}
                  {res.plan.start} → {res.plan.end}
                </span>
              </div>
              <button
                onClick={() => void addNote(
                  "回测",
                  `回测 · ${res.strategy} · ${res.plan.codes.join("/")}`,
                  [
                    `${res.plan.market} · ${res.plan.style} · ${res.plan.start} → ${res.plan.end}`,
                    METRICS.map((m) => `${m.label} ${m.fmt(res.metrics[m.key])}`).join(" · "),
                    `对照 ${pct(res.metrics.benchmark_return)}（${res.benchmark_is_self ? "等权买入持有这几只标的本身，不是指数" : String(res.metrics.benchmark_ticker)}）`,
                    "", "这次回测的限制：", ...res.plan.limits.map((x) => `· ${x}`),
                    "", "口径：", ...res.plan.notes.map((x) => `· ${x}`),
                    "", "数据来源：", ...res.provenance.map((p) => `· ${p.code} ${p.endpoint} ${p.rows} 根 ${p.first_bar}→${p.last_bar}`),
                  ].join("\n"),
                )}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary"
              >
                <Save className="h-3.5 w-3.5" /> 存进研究记录
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {METRICS.map((m) => {
                const v = res.metrics[m.key];
                const tone = m.good === "up" && typeof v === "number"
                  ? v > 0 ? "text-danger" : v < 0 ? "text-success" : ""
                  : "";
                return (
                  <div key={m.key} className="rounded-lg border border-border/60 bg-background/40 p-3">
                    <p className="text-[11px] text-muted-foreground">{m.label}</p>
                    <p className={`mt-0.5 font-mono text-lg font-bold ${tone}`}>{m.fmt(v)}</p>
                  </div>
                );
              })}
            </div>

            <div className="mt-3 rounded-lg border border-border/60 bg-background/40 p-3 text-sm">
              <span className="text-muted-foreground">对照</span>
              <span className="ml-2 font-mono font-bold">{pct(res.metrics.benchmark_return)}</span>
              {/* 🔴 说清楚这条对照到底是什么。名字叫 benchmark，不说的话会被当成沪深300 / 标普 */}
              <span className="ml-2 text-xs text-muted-foreground">
                {res.benchmark_is_self
                  ? "← 等权买入持有这几只标的本身，不是指数"
                  : `← 指数 ${String(res.metrics.benchmark_ticker)}`}
              </span>
            </div>

            {Object.keys(res.missing).length > 0 && (
              <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                <b className="text-warning">以下标的没有参与回测：</b>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {Object.entries(res.missing).map(([c, why]) => <li key={c}>· {c}：{why}</li>)}
                </ul>
              </div>
            )}
          </GlassCard>

          {/* 🔴 限制**必须与结果同屏**。回测最容易被误读的不是数字算错，
              而是读的人不知道它是在什么约束下算出来的。 */}
          <GlassCard className="p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <FlaskConical className="h-4 w-4 text-primary" /> 这次回测的限制（看结果之前先读）
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {res.plan.limits.map((x) => <li key={x}>· {x}</li>)}
            </ul>
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-1 text-xs font-medium text-foreground/70">口径</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {res.plan.notes.map((x) => <li key={x}>· {x}</li>)}
              </ul>
            </div>
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-1 text-xs font-medium text-foreground/70">数据来源</p>
              <ul className="space-y-1 font-mono text-xs text-muted-foreground">
                {res.provenance.map((p) => (
                  <li key={p.code}>
                    · {p.code} {p.endpoint} {p.rows} 根 {p.first_bar}→{p.last_bar}
                    {p.note ? ` [${p.note}]` : ""}
                  </li>
                ))}
              </ul>
            </div>
          </GlassCard>
        </>
      )}

      <Disclaimer />
    </div>
  );
}
