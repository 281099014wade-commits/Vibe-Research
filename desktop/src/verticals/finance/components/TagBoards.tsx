import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import { PctCell, show } from "../../../core/ui/envelope";
import { Section } from "../../../core/ui/Section";
import { api } from "../../../core/lib/api";
import { pivot } from "../../../core/lib/records";
import { useAsync } from "../../../core/lib/useAsync";
import { RESEARCH_TAGS, type ResearchTag } from "../lib/tags";

/**
 * 研究 tag 的折叠区:打开板块中心就看到自己在跟的几条线。
 *
 * 🔴 **展开才取行情**,收起的一条线不产生任何请求。与"页面打开不重跑"不冲突 ——
 *    这里取的是**用户主动展开的那一条**,不是打开页面就把六条线全打一遍。
 *    而且走同一套快照层:展开过一次,再展开就是上次的,除非点刷新。
 *
 * ⚠️ 这是"我在跟哪些线"的清单,**不是推荐**。
 */

function TagQuotes({ tag }: { tag: ResearchTag }) {
  const codes = tag.symbols.map((s) => s.code);
  const { state } = useAsync(
    (refresh) => api.fetch({ endpoint: "tx_quotes_batch", args: { codes }, refresh }),
    [codes.join(",")],
  );

  if (state.phase === "loading" || state.phase === "idle") {
    return <p className="py-2 text-[11.5px] text-muted-foreground">读取行情…</p>;
  }
  if (state.phase === "error") {
    // 🔴 取不到就说取不到,别退化成"这条线下面没有标的"
    return <p className="py-2 text-[11.5px] text-warning">行情取不到:{state.error}</p>;
  }

  // record_key 就是我们传进去的写法(取数层 `result[code]` 原样回传),所以直接按代码对上
  const byCode = new Map(pivot(state.data.envelope).map((r) => [r.key, r]));
  return (
    <div>
      {tag.symbols.map((s) => {
        const r = byCode.get(s.code);
        // 名字以**上游返回的**为准(公司会改名);表里的名字只在取不到时兜底
        const name = r ? show(r.fields.security_name) : s.name;
        return (
          <div
            key={s.code}
            className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]"
            title={r?.note}
          >
            <span className="tnum w-16 shrink-0 text-muted-foreground">{s.code}</span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {/* 这一只没回来时写"未覆盖" —— 不是 0,也不是空白 */}
            <span className="tnum w-20 shrink-0 text-right">{r ? show(r.fields.price) : "未覆盖"}</span>
            <span className="w-16 shrink-0 text-right">{r ? <PctCell ev={r.fields.change_pct} /> : null}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TagBoards() {
  return (
    <div className="space-y-3">
      {RESEARCH_TAGS.map((t) => (
        // children 传函数 —— 收起的那几条线连组件都不挂载,自然不会取数
        <Section
          key={t.id}
          id={`tag.${t.id}`}
          title={t.label}
          note={t.intent}
          defaultOpen={false}
          // ⚠️ 这个链接嵌在 Section 的标题按钮里 —— 必须挡冒泡,否则点"看全貌"会顺手把这一块折叠
          right={
            <Link
              to={`/sectors/${t.id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-primary"
            >
              看全貌
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          }
        >
          {() => <TagQuotes tag={t} />}
        </Section>
      ))}
    </div>
  );
}
