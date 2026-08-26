import { RefreshCw } from "lucide-react";

import { cx } from "./primitives";

/**
 * 页面级的「这页的数据是什么时候的 + 刷新」。
 *
 * 🔴 为什么每页都要有:页面默认读**上次取的快照**(不重新取数,省时间省钱)。
 *    既然给的是旧数据,就**必须让人看见它是旧的** —— 这个产品的全部信用建立在
 *    "每个数字都挂着资料期"上,拿三天前的数据冒充实时是自毁根基。
 *
 * ⚠️ 与 `EnvelopeMeta` 不重复:那个说的是**单个取数信封**(状态 / 源 / 资料期),
 *    这个说的是**整页**什么时候取的、以及怎么重新取。
 */

/** 多个端点各有各的取数时刻 → 显示**最旧**那个。整页的新鲜度不能好过它最差的那部分 */
export function oldestOf(times: (string | undefined | null)[]): string | null {
  const ok = times.filter((t): t is string => typeof t === "string" && t.length > 0);
  return ok.length ? ok.reduce((a, b) => (a < b ? a : b)) : null;
}

/**
 * 「刚刚 / 几分钟前」只用于粗看,精确时刻放 title 里(悬停可见)。
 * ⚠️ 别只给相对时间:跨天之后"1 天前"会让人分不清究竟是昨天还是前天的数据。
 */
function human(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function DataBar({
  fetchedAt,
  cached,
  loading,
  onRefresh,
  note,
}: {
  fetchedAt: string | null;
  /** true = 这份来自上次的快照,没有重新取数 */
  cached: boolean;
  loading: boolean;
  onRefresh: () => void;
  /** 这一页额外要说的话(比如「盘中显示的是上一个交易日」) */
  note?: string;
}) {
  const now = Date.now();
  // 超过一天还只标"快照"容易被当成刚取的 —— 老到这个程度就把时间标黄
  const stale = fetchedAt ? now - Date.parse(fetchedAt) > 24 * 3600_000 : false;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
      {fetchedAt ? (
        <span title={fetchedAt}>
          数据取于 <span className={cx("tnum", stale && "text-warning")}>{human(fetchedAt, now)}</span>
          {cached ? "(上次的,未重新取)" : ""}
        </span>
      ) : (
        <span>还没有取过数</span>
      )}
      {note ? <span>· {note}</span> : null}
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className={cx("h-3 w-3", loading && "animate-spin")} aria-hidden />
        {loading ? "取数中…" : "刷新"}
      </button>
    </div>
  );
}
