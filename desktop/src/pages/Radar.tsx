import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { EndpointPanel } from "../components/ui/EndpointPanel";
import { show } from "../components/ui/envelope";
import { Card, CardHead, cx } from "../components/ui/primitives";
import type { FetchResult } from "../lib/api";
import { noteKV, pivot, scalar } from "../lib/records";
import { useUi } from "../lib/store";

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
function ClsList({ res }: { res: FetchResult }) {
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

function HeadlineList({ res }: { res: FetchResult }) {
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

function RssList({ res }: { res: FetchResult }) {
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

function StockNewsList({ res }: { res: FetchResult }) {
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

function VoiceList({ res }: { res: FetchResult }) {
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
const TABS = ["快讯", "海外头条", "行业 RSS", "个股"] as const;
type Tab = (typeof TABS)[number];

export function Radar() {
  const openDock = useUi((s) => s.openDock);
  const [tab, setTab] = useState<Tab>("快讯");
  const [input, setInput] = useState("300308");
  const [symbol, setSymbol] = useState("300308");
  const valid = A_SHARE.test(input.trim());

  return (
    <div className="space-y-4">
      <Card>
        <CardHead
          title="这一页在回答什么"
          note="一手信源与市场声音。⚠️ 这是线索层不是事实层:任何数字都要回到取数层核实过才能进结论。"
          right={
            <div className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cx(
                    "cursor-pointer rounded-md px-2.5 py-1 text-[11.5px] transition-colors",
                    tab === t ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          }
        />
      </Card>

      {tab === "快讯" ? (
        <EndpointPanel endpoint="cls_telegraph" title="财联社快讯" note="全市场快讯流;悬停标题看正文摘要">
          {(res) => <ClsList res={res} />}
        </EndpointPanel>
      ) : null}

      {tab === "海外头条" ? (
        <EndpointPanel endpoint="techmeme_headlines" title="海外头条" note="Techmeme river 时间流,48 小时窗口">
          {(res) => <HeadlineList res={res} />}
        </EndpointPanel>
      ) : null}

      {tab === "行业 RSS" ? (
        <EndpointPanel endpoint="rss_news" title="行业 RSS" note="按行业聚合的近 3 天条目;默认行业 ai">
          {(res) => <RssList res={res} />}
        </EndpointPanel>
      ) : null}

      {tab === "个股" ? (
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
      ) : null}

      <button
        type="button"
        onClick={() =>
          openDock("把这一页里跟我关注的产业相关的条目挑出来,逐条标注:它是事实、是传闻,还是只是转述别人的观点?")
        }
        className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
      >
        就这些线索问 Agent
      </button>
    </div>
  );
}
