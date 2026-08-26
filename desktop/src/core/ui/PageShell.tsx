import type { ReactNode } from "react";

import type { Envelope, PageBlock, PageResult } from "../lib/api";
import { usePage } from "../lib/usePage";
import { DataBar } from "./DataBar";
import { Card, CardHead } from "./primitives";
import { Section } from "./Section";

/**
 * **一屏**的渲染外壳:取数、资料期、刷新、缺块提示都在这里,页面只管画内容。
 *
 * 🔴 与 `EndpointPanel` 的区别 —— 它是要被取代的那个:
 *    `EndpointPanel` 让每张卡片自己认识一个**物理端点 id**,于是端点名印在界面上,
 *    端点改名要改一片前端,而且一屏之内的块彼此不认识。
 *    `PageShell` 让页面只说要哪个查询,端点全在后端的垂类声明里。
 *
 * 🔴 **缺块要说出来,不许留空白**。一块取不到时页面若只是少画一块,用户会以为
 *    "这里本来就没有东西" —— 而真相是取数失败。两件事的处置完全不同。
 */

export function PageShell({
  query,
  symbol,
  blockArgs,
  children,
}: {
  query: string;
  symbol?: string;
  /**
   * 用户在界面上拨过的块参数(如切换行业)。**能拨哪些键由后端白名单说了算** ——
   * 这里传什么,后端都只认它自己声明的那几个。
   */
  blockArgs?: Record<string, Record<string, unknown>>;
  children: (ctx: { page: PageResult; block: (id: string) => PageBlock | undefined }) => ReactNode;
}) {
  const { state, reload } = usePage(query, { ...(symbol ? { symbol } : {}), ...(blockArgs ? { blockArgs } : {}) });

  if (state.phase === "idle" || state.phase === "loading") {
    return <p className="py-6 text-[12.5px] text-muted-foreground">读取中…</p>;
  }
  if (state.phase === "error") {
    return (
      <Card>
        <CardHead title="这一页取不到数据" />
        <p className="text-[12.5px] leading-relaxed text-warning">
          {state.code} · {state.error}
        </p>
        <button
          type="button"
          onClick={() => reload()}
          className="mt-3 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-muted"
        >
          重试
        </button>
      </Card>
    );
  }

  const page = state.data;
  const find = (id: string) => page.blocks.find((b) => b.id === id);
  const missing = page.blocks.filter((b) => b.status === "missing");
  // 业务上下文里若带了"为什么是这一天",要显示出来 —— 否则用户不知道自己看的为何是昨天
  const ctxNote = typeof page.context?.review_reason === "string" ? String(page.context.review_reason) : undefined;

  return (
    <>
      <DataBar
        fetchedAt={page.oldest_fetched_at}
        cached={page.blocks.some((b) => b.cached)}
        loading={false}
        onRefresh={() => reload(true)}
        {...(ctxNote ? { note: ctxNote } : {})}
      />

      {/* 🔴 一屏之内跨了不同的天:用户会把并排的几块当成同一时刻的快照,必须出声 */}
      {page.mixed_ages ? (
        <p className="mb-3 text-[11.5px] text-warning">
          ⚠️ 这一屏各块的数据不是同一天取的 —— 并排看时注意它们不构成同一时刻的快照。
        </p>
      ) : null}

      {missing.length ? (
        <Card className="mb-4 border-warning/50">
          <CardHead title="有几块没取到" note="不是这里本来就没东西 —— 是这次没取到,原因如下" />
          <ul className="space-y-1 text-[11.5px]">
            {missing.map((b) => (
              <li key={b.id} className="text-warning">
                <span className="text-foreground">{b.title}</span>:{b.error ?? "未知原因"}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {children({ page, block: find })}
    </>
  );
}

/**
 * 一块的卡片外壳。标题与说明都来自**后端的垂类声明**,不是前端写死的 ——
 * 于是"这一块在回答什么"只有一处真相,改说明不用动前端。
 */
/** 这一块确实取到了 —— `Block` 内部已窄化,把这个保证写进类型,调用方就不用再判一次 */
export type ReadyBlock = PageBlock & { envelope: Envelope };

export function Block({
  b,
  right,
  children,
}: {
  b: PageBlock | undefined;
  /** 块标题栏右侧的控件(如切换这一块参数的选择器) */
  right?: ReactNode;
  children: (b: ReadyBlock) => ReactNode;
}) {
  // 缺块已在 PageShell 顶部统一列出并说明原因,这里不重复渲染一个空壳
  if (!b || b.status !== "ok" || !b.envelope) return null;
  // 折叠是**显示层**的事:数据已经一次取回。默认展开,除非后端的声明说这一块该先收着。
  return (
    <Section
      id={`${b.id}`}
      title={b.title}
      {...(b.note ? { note: b.note } : {})}
      {...(right ? { right } : {})}
      defaultOpen={!b.collapsed}
    >
      {children(b as ReadyBlock)}
    </Section>
  );
}
