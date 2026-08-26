import { ArrowLeft, Wrench } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { api } from "../../../core/lib/api";
import { num, pivot } from "../../../core/lib/records";
import { useAsync } from "../../../core/lib/useAsync";
import { AskAgent } from "../../../core/ui/AskAgent";
import { PctCell, show } from "../../../core/ui/envelope";
import { Async, Card, CardHead, cx } from "../../../core/ui/primitives";
import { RESEARCH_TAGS } from "../lib/tags";

/**
 * 一条研究线的下钻页。**板块中心是清单,这里是这一条的全貌。**
 *
 * 两块内容:① 产业链环节(只有环节名,不挂标的)② 在跟的标的(带实时行情)。
 *
 * 🔴 环节骨架**没核实过就如实说没核实**,不编一串看着很像的名字 ——
 *    编出来的环节最像"已经研究过了",而它恰恰是最没被研究过的东西。
 */
export function SectorDetail() {
  const { key } = useParams();
  const tag = RESEARCH_TAGS.find((t) => t.id === key);

  const codes = tag?.symbols.map((s) => s.code) ?? [];
  const codeKey = codes.join(",");
  const { state, reload } = useAsync(
    (refresh) => (codeKey ? api.fetch({ endpoint: "tx_quotes_batch", args: { codes }, refresh }) : Promise.resolve(null)),
    [codeKey],
  );

  if (!tag) {
    return (
      <Card>
        <CardHead title="没有这条研究线" note={`路径里的 ${String(key)} 不在研究线清单里`} />
        <Link to="/sectors" className="text-[12.5px] text-primary hover:underline">
          回板块中心
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        to="/sectors"
        className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> 板块中心
      </Link>

      <Card>
        <CardHead title={tag.label} note={tag.intent} />
      </Card>

      <Card>
        <CardHead
          title="产业链环节"
          note={
            tag.nodesVerified
              ? "只有环节名,不挂标的 —— 哪个环节卡脖子要靠研究,不靠这张图"
              : "这条线的环节骨架还没核实过"
          }
        />
        {tag.nodesVerified ? (
          <div className="flex flex-wrap gap-2">
            {tag.nodes.map((n) => (
              <span
                key={n}
                className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[12px] text-foreground"
              >
                {n}
              </span>
            ))}
          </div>
        ) : (
          // 🔴 不编。没核实就说没核实,并给出"怎么把它补上"的入口。
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Wrench className="h-6 w-6 text-muted-foreground/50" aria-hidden />
            <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
              这条线的环节骨架<span className="text-foreground">还没核实过</span>,所以这里是空的 ——
              不拿模型记忆凑一串看着很像的名字。要补上,让 Agent 按一手资料现场拆一遍,核实完再写进研究线清单。
            </p>
          </div>
        )}
        <div className="mt-3">
          <AskAgent
            prompt={`把「${tag.label}」这条产业链按环节拆开:每个环节做什么、谁在做、卡在哪。${
              tag.nodesVerified
                ? `已知环节:${tag.nodes.join("、")}。请逐个核实并指出遗漏。`
                : "目前没有已核实的环节骨架,请从一手资料出发列出来。"
            }只列环节与事实,不要给标的推荐。`}
          >
            让 Agent 拆这条产业链
          </AskAgent>
        </div>
      </Card>

      <Card>
        <CardHead
          title="在跟的标的"
          note="这是「我在跟哪些」的清单,不是推荐"
          right={
            <button
              type="button"
              onClick={() => reload(true)}
              className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
            >
              刷新行情
            </button>
          }
        />
        <Async state={state} onRetry={() => reload()}>
          {(res) => {
            // record_key 就是传进去的写法(取数层原样回传),直接按代码对上
            const byCode = new Map(res ? pivot(res.envelope).map((r) => [r.key, r] as const) : []);
            return (
              <div>
                <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                  <span className="w-16">代码</span>
                  <span className="flex-1">名称</span>
                  <span className="w-20 text-right">现价</span>
                  <span className="w-16 text-right">涨跌</span>
                  <span className="w-20 text-right">PE(TTM)</span>
                </div>
                {tag.symbols.map((s) => {
                  const r = byCode.get(s.code);
                  return (
                    <div
                      key={s.code}
                      className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]"
                      title={r?.note}
                    >
                      <span className="tnum w-16 shrink-0 text-muted-foreground">{s.code}</span>
                      {/* 名字以上游返回的为准(公司会改名);表里的只在取不到时兜底 */}
                      <span className="min-w-0 flex-1 truncate">{r ? show(r.fields.security_name) : s.name}</span>
                      <span className="tnum w-20 shrink-0 text-right">{r ? show(r.fields.price) : "未覆盖"}</span>
                      <span className="w-16 shrink-0 text-right">{r ? <PctCell ev={r.fields.change_pct} /> : null}</span>
                      <span
                        className={cx(
                          "tnum w-20 shrink-0 text-right",
                          num(r?.fields.pe_ttm) === null && "text-muted-foreground",
                        )}
                      >
                        {r ? show(r.fields.pe_ttm) : "未覆盖"}
                      </span>
                    </div>
                  );
                })}
                {res ? (
                  <p className="pt-2 text-[11px] text-muted-foreground">
                    行情资料期 {res.envelope.fetched_at.slice(0, 16).replace("T", " ")}
                    {res.cached ? "(上次取的,没有重新取)" : ""}
                  </p>
                ) : null}
              </div>
            );
          }}
        </Async>
      </Card>
    </div>
  );
}
