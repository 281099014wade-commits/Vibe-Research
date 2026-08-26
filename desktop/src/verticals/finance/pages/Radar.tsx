import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { EndpointPanel } from "../../../core/ui/EndpointPanel";
// ⚠️ 个股线索仍走按需面板:它要先输代码,不属于"打开就该有的一屏"
import { Block, PageShell, type ReadyBlock } from "../../../core/ui/PageShell";
import { show } from "../../../core/ui/envelope";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Card, CardHead } from "../../../core/ui/primitives";
import type { Envelope } from "../../../core/lib/api";
import { noteKV, pivot, scalar } from "../../../core/lib/records";

/**
 * 一条资讯。
 * 🔴 这一层是**线索不是事实**:标题里的数字不得当结论用,链接只是去查证的入口。
 *    所以行内只出标题 / 来源 / 时间,不把正文里的数字提出来放大。
 */
function NewsRow({
  title,
  when,
  source,
  href,
  tip,
}: {
  title: string;
  when?: string;
  source?: string;
  href?: string;
  tip?: string;
}) {
  // 只放行 http(s):note 是上游文本,可能带 javascript: 之类的东西
  const safe = href && /^https?:\/\//i.test(href) ? href : undefined;
  return (
    <div className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
      {when ? <span className="tnum w-24 shrink-0 text-muted-foreground">{when}</span> : null}
      <span className="min-w-0 flex-1 truncate" title={tip ?? title}>
        {title}
      </span>
      {source ? <span className="w-28 shrink-0 truncate text-right text-muted-foreground">{source}</span> : null}
      {safe ? (
        <a
          href={safe}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
          aria-label="打开原文"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

/** 财联社快讯:record_key 是 `时间|标题`,取前段当时间即可,不做别的解析 */
function ClsList({ res }: { res: { envelope: Envelope } }) {
  const rows = pivot(res.envelope).slice(0, 30);
  return (
    <div>
      {rows.map((r) => {
        const t = r.key.includes("|") ? r.key.slice(0, r.key.indexOf("|")) : "";
        return (
          <NewsRow
            key={r.key}
            title={show(r.fields.market_news_title)}
            when={t.slice(5, 16)}
            tip={r.note.startsWith("content=") ? r.note.slice(8, 400) : r.note}
          />
        );
      })}
    </div>
  );
}

function HeadlineList({ res }: { res: { envelope: Envelope } }) {
  const rows = pivot(res.envelope).slice(0, 30);
  const count = scalar(res.envelope, "headline_count");
  return (
    <div>
      {/* 单独取数没有产业门控上下文 ⇒ 关键词未打分。
          这与"没有相关新闻"完全是两件事,必须写清楚,否则会被读成"今天没相关"。 */}
      <p className="mb-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {String(count?.note ?? "")}
        <br />
        单独取数时没有产业标签上下文,所以<span className="text-foreground">未按产业关键词打分</span>
        —— 不等于「没有相关条目」。在一次研究运行里,这一层会按标的所属行业自动打分。
      </p>
      {rows.map((r) => {
        const kv = noteKV(r.note);
        return (
          <NewsRow
            key={r.key}
            title={show(r.fields.headline_item)}
            when={kv.published?.slice(5, 16).replace("T", " ")}
            {...(kv.source ? { source: kv.source } : {})}
            tip={r.note}
          />
        );
      })}
    </div>
  );
}

function RssList({ res }: { res: { envelope: Envelope } }) {
  const rows = pivot(res.envelope).slice(0, 30);
  return (
    <div>
      {rows.map((r) => {
        const kv = noteKV(r.note);
        return (
          <NewsRow
            key={r.key}
            title={show(r.fields.news_title)}
            {...(kv.source ? { source: kv.source } : {})}
            {...(kv.link ? { href: kv.link } : {})}
            tip={r.note}
          />
        );
      })}
    </div>
  );
}

function StockNewsList({ res }: { res: { envelope: Envelope } }) {
  const rows = pivot(res.envelope);
  return (
    <div>
      {rows.map((r) => {
        const kv = noteKV(r.note);
        const ev = r.fields.news_title;
        return (
          <NewsRow
            key={r.key}
            title={show(ev)}
            {...(ev?.period ? { when: ev.period } : {})}
            {...(kv.source ? { source: kv.source } : {})}
            {...(kv.url ? { href: kv.url } : {})}
            tip={r.note}
          />
        );
      })}
    </div>
  );
}

function VoiceList({ res }: { res: { envelope: Envelope } }) {
  const rows = pivot(res.envelope).slice(0, 25);
  const count = scalar(res.envelope, "web_result_count");
  return (
    <div>
      <p className="mb-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {String(count?.note ?? "")}
        <br />
        这一层是<span className="text-foreground">别人在说什么</span>,不是事实:
        帖子里的数字一律不得写进结论,只作为去查证的入口。
      </p>
      {rows.map((r) => {
        const kv = noteKV(r.note);
        const ev = r.fields.web_result ?? r.fields.web_excerpt;
        return (
          <NewsRow
            key={r.key}
            title={show(ev)}
            {...(ev?.period ? { when: ev.period } : {})}
            {...(kv.domain ? { source: kv.domain } : {})}
            tip={r.note}
          />
        );
      })}
    </div>
  );
}

const A_SHARE = /^(6\d{5}|0\d{5}|3\d{5})$/;

/**
 * 策展信源的行业切换器。
 * 🔴 **选项来自这一块自己的信封**(`extra.industries`),不是前端写死的一份表 ——
 *    写死的那份迟早跟 `rss_sources.json` 对不上,而对不上的表现是
 *    "选了没反应"或"真实存在的行业不在选项里",两种都看不出是配置漂移。
 */
function IndustryPicker({ res, value, onPick }: { res: ReadyBlock; value: string; onPick: (k: string) => void }) {
  const raw = res.envelope.extra?.industries;
  const opts = Array.isArray(raw)
    ? (raw as { key?: unknown; name?: unknown }[])
        .filter((i) => typeof i.key === "string" && i.key)
        .map((i) => ({ key: String(i.key), name: String(i.name ?? i.key) }))
    : [];
  if (!opts.length) return null;
  return (
    // 这个 select 嵌在 Section 的标题按钮里 ⇒ 必须挡住冒泡,否则每次选都会顺手把这一块折叠
    <select
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onPick(e.target.value);
      }}
      aria-label="切换行业"
      className="cursor-pointer rounded-md border border-border bg-input/60 px-2 py-0.5 text-[11px] outline-none focus:border-ring"
    >
      {opts.map((o) => (
        <option key={o.key} value={o.key}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export function Radar() {
  const [input, setInput] = useState("300308");
  const [symbol, setSymbol] = useState("300308");
  // 策展信源看哪个行业。⚠️ 换行业会**真的重取这一块** —— 它是用户主动的选择,不是打开页面就跑
  const [industry, setIndustry] = useState("ai");
  const valid = A_SHARE.test(input.trim());

  return (
    <PageShell query="radar" blockArgs={{ curated: { industry } }}>
      {({ page, block }) => (
        <div className="space-y-4">
          <Card>
            <CardHead title="这一页在回答什么" note={page.intent} />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              ⚠️ 这是**线索层不是事实层**:任何数字都要回到取数层核实过才能进结论。
            </p>
          </Card>

          {/* 🔴 顺序按"离判断有多近"排,不是按数据量:
              头条(需求侧一手)→ 策展信源(筛过的)→ 全市场快讯(量大但噪音也大)→ 市场声音(最软)。
              各块可折叠,折叠状态记住 —— ⚠️ 折叠只是不显示,数据仍是一次取回的。 */}
          <Block b={block("headlines")}>{(res) => <HeadlineList res={res} />}</Block>
          <Block
            b={block("curated")}
            right={
              (() => {
                const b = block("curated");
                return b?.status === "ok" && b.envelope ? (
                  <IndustryPicker res={b as ReadyBlock} value={industry} onPick={setIndustry} />
                ) : null;
              })()
            }
          >
            {(res) => <RssList res={res} />}
          </Block>
          <Block b={block("telegraph")}>{(res) => <ClsList res={res} />}</Block>

          {/* 个股线索:需要先输代码,天然是按需的一段(不进整屏查询) */}
          <>
            <Card>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid) setSymbol(input.trim());
                }}
                aria-label="股票代码"
                className="tnum w-32 rounded-lg border border-border bg-input/60 px-2.5 py-1.5 text-[12.5px] outline-none"
              />
              <button
                type="button"
                disabled={!valid}
                onClick={() => setSymbol(input.trim())}
                className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                查询
              </button>
              <span className="ml-auto text-[11.5px] text-muted-foreground">
                当前 <span className="tnum text-foreground">{symbol}</span>
              </span>
            </div>
          </Card>
          <EndpointPanel endpoint="em_stock_news" symbol={symbol} title="个股新闻" note="东财个股新闻流">
            {(res) => <StockNewsList res={res} />}
          </EndpointPanel>
          <EndpointPanel
            endpoint="exa_market_voice"
            symbol={symbol}
            lazy
            title="市场声音"
            note="全网检索(约 9 秒);已做脱敏与红线过滤,仍属线索层"
          >
            {(res) => <VoiceList res={res} />}
          </EndpointPanel>
          </>


      <AskAgent prompt={"把这一页里跟我关注的产业相关的条目挑出来,逐条标注:它是事实、是传闻,还是只是转述别人的观点?"}>就这些线索问 Agent</AskAgent>
        </div>
      )}
    </PageShell>
  );
}
