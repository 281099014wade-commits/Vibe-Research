import { FileText, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Async, Badge, Card, CardHead, cx, statusTone } from "../components/ui/primitives";
import { api } from "../lib/api";
import { useUi } from "../lib/store";
import { useAsync } from "../lib/useAsync";

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // 后端给了非 ISO 就原样显示,不猜
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 数据源健康:按层聚合注册表。数字来自 GET /endpoints,不写死。 */
function SourceHealth() {
  const fn = useCallback(() => Promise.all([api.health(), api.endpoints()]), []);
  const { state, reload } = useAsync(fn, []);
  return (
    <Card>
      <CardHead
        title="数据源健康"
        note="注册表按层统计;停用的层多半是缺凭据或上游未接入"
        right={
          <button
            type="button"
            onClick={reload}
            aria-label="重新读取数据源"
            className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        }
      />
      <Async state={state} onRetry={reload}>
        {([health, eps]) => {
          const byLayer = new Map<string, { total: number; on: number }>();
          for (const e of eps) {
            const k = e.layer ?? "未分层";
            const cur = byLayer.get(k) ?? { total: 0, on: 0 };
            cur.total += 1;
            if (e.enabled) cur.on += 1;
            byLayer.set(k, cur);
          }
          const layers = [...byLayer.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
          const on = eps.filter((e) => e.enabled).length;
          return (
            <div>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]">
                <span>
                  <span className="tnum text-[17px] font-medium">{eps.length}</span>
                  <span className="ml-1 text-muted-foreground">端点</span>
                </span>
                <span>
                  <span className="tnum text-[17px] font-medium">{byLayer.size}</span>
                  <span className="ml-1 text-muted-foreground">层</span>
                </span>
                <span className="text-muted-foreground">
                  启用 <span className="tnum text-foreground">{on}</span> / 停用{" "}
                  <span className="tnum text-foreground">{eps.length - on}</span>
                </span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">v{health.version}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 xl:grid-cols-4">
                {layers.map(([layer, c]) => (
                  <div
                    key={layer}
                    className="flex items-baseline justify-between border-b border-border/40 py-1 text-[12px]"
                  >
                    <span className="truncate text-muted-foreground">{layer}</span>
                    <span className={cx("tnum ml-2 shrink-0", c.on === 0 && "text-muted-foreground")}>
                      {c.on}
                      <span className="text-muted-foreground">/{c.total}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        }}
      </Async>
    </Card>
  );
}

/** 单次运行的报告 + 证据台账。两者是同一次运行的产物,能对上才算数。 */
function RunDetail({ runId }: { runId: string }) {
  const openDock = useUi((s) => s.openDock);
  const fn = useCallback(
    () => Promise.all([api.runStatus(runId), api.report(runId), api.evidence(runId, { limit: 12 })]),
    [runId],
  );
  const { state, reload } = useAsync(fn, [runId]);
  return (
    <Card>
      <Async state={state} onRetry={reload}>
        {([st, rep, ev]) => (
          <div>
            <CardHead
              title={st.run_id}
              note={`${st.evidence_count ?? "?"} 条证据 · ${st.calculation_count ?? "?"} 项计算 · 结束 ${shortTime(st.finished_at)}`}
              right={<Badge tone={statusTone(st.status)}>{st.status ?? "未知"}</Badge>}
            />

            <div className="mb-3 flex flex-wrap gap-1.5">
              {st.stages.map((s) => (
                <span
                  key={s.stage}
                  className={cx(
                    "rounded-md px-1.5 py-0.5 text-[11px]",
                    s.status === "complete" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                  )}
                  title={`尝试 ${s.attempts} 次`}
                >
                  {s.stage}
                </span>
              ))}
            </div>

            {rep.report ? (
              <div className="max-h-[520px] overflow-y-auto rounded-lg border border-border/60 bg-background/40 px-4 py-3">
                <div className="markdown text-[12.5px] leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]}>{rep.report}</Markdown>
                </div>
              </div>
            ) : (
              // 🔴 别对"没有报告"作单一归因。实测 smoke-2 状态是 complete、却没有报告 ——
              //    因为它只被要求跑 profile / financials 两个阶段,根本没跑 report。
              //    原来那句"多半中途失败"会把一次正常的部分运行说成故障,比不写还糟。
              <p className="py-3 text-[12.5px] text-muted-foreground">
                {st.stages.some((s) => s.stage === "report")
                  ? "报告阶段没有产出,看上面的阶段状态。"
                  : `这次运行没跑报告阶段(只跑了 ${st.stages.map((s) => s.stage).join(" / ") || "——"})。`}
              </p>
            )}

            <div className="mt-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h4 className="text-[12.5px] font-medium">证据台账</h4>
                <span className="text-[11.5px] text-muted-foreground">
                  共 <span className="tnum">{ev.total}</span> 条,下面是前 {ev.items.length} 条
                </span>
              </div>
              <div className="space-y-1">
                {ev.items.map((it, i) => {
                  const r = it as Record<string, unknown>;
                  return (
                    <div
                      key={String(r.id ?? i)}
                      className="flex items-baseline gap-2 border-b border-border/40 py-1 text-[11.5px]"
                    >
                      <span className="shrink-0 font-mono text-muted-foreground">{String(r.id ?? "—")}</span>
                      <span className="min-w-0 flex-1 truncate">{String(r.field ?? "")}</span>
                      <span className="tnum shrink-0">{String(r.value ?? "")}</span>
                      <span className="shrink-0 text-muted-foreground">{String(r.period ?? "")}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                openDock(`就运行 ${st.run_id} 的结论,帮我找出最可能被推翻的那一条,以及推翻它需要看到什么数据。`)
              }
              className="mt-4 cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
            >
              就这次运行问 Agent
            </button>
          </div>
        )}
      </Async>
    </Card>
  );
}

export function Data() {
  const [sel, setSel] = useState<string | null>(null);
  const runsFn = useCallback(() => api.runs(200), []);
  const { state, reload } = useAsync(runsFn, []);

  // 默认落到最近一次**真跑完**的运行,而不是最近一次(那可能是失败的,打开是空报告)
  const autoSel = useMemo(() => {
    if (sel) return sel;
    if (state.phase !== "ready") return null;
    return state.data.find((r) => r.status === "complete")?.run_id ?? state.data[0]?.run_id ?? null;
  }, [sel, state]);

  return (
    <div className="space-y-4">
      <SourceHealth />

      {/* 🔴 右列必须写 minmax(0,1fr):`1fr` 的隐式 min-width 是 auto,
          报告里一张宽表就能把整列顶开 —— 实测整页 scrollWidth 2064 > 视口 1280。
          列能收缩之后,表格自己的 overflow-x 才接得住。 */}
      <div className="grid gap-4 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <Card className="max-h-[640px] overflow-hidden">
          <CardHead
            title="研究运行"
            note="每次运行都留下报告、证据台账与查看器"
            right={
              <button
                type="button"
                onClick={reload}
                aria-label="重新读取运行列表"
                className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              </button>
            }
          />
          <Async
            state={state}
            onRetry={reload}
            isEmpty={(rs) => rs.length === 0}
            emptyText="还没有运行:在下方对话里写个标的代码就能起一次"
          >
            {(runs) => (
              <div className="max-h-[520px] space-y-0.5 overflow-y-auto pr-1">
                {runs.map((r) => (
                  <button
                    key={r.run_id}
                    type="button"
                    onClick={() => setSel(r.run_id)}
                    // 🔴 选中态不给整行上主色调:浅色下 bg-primary/15 会把页底合成成暖米色,
                    //    行里的次要文字掉到 4.2、状态徽章(浅底叠浅底)掉到 3.97 —— 两处都不达 4.5。
                    //    继续压深令牌是治标;正解是**选中态用中性底**,让行内元素保持各自的对比度。
                    className={cx(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md border-l-2 px-2 py-1.5 text-left text-[11.5px] transition-colors",
                      autoSel === r.run_id ? "border-primary bg-muted" : "border-transparent hover:bg-muted",
                    )}
                  >
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono">{r.run_id}</span>
                    <span className="shrink-0 text-muted-foreground">{r.symbol ?? "—"}</span>
                    <Badge tone={statusTone(r.status)}>{r.status ?? "?"}</Badge>
                  </button>
                ))}
              </div>
            )}
          </Async>
        </Card>

        {autoSel ? (
          <RunDetail runId={autoSel} />
        ) : (
          <Card>
            <p className="py-6 text-[12.5px] text-muted-foreground">左边选一次运行,这里显示它的报告与证据台账。</p>
          </Card>
        )}
      </div>
    </div>
  );
}
