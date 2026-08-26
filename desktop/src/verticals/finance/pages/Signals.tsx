
// ⚠️ 宏观概率**刻意不进页面查询**:它约 28 秒才回,放进一屏会让整页都等它。
//    慢端点走"按需取"(lazy),这是 EndpointPanel 仍然存在的唯一理由。
import { EndpointPanel } from "../../../core/ui/EndpointPanel";
import { Block, PageShell } from "../../../core/ui/PageShell";
import { PctCell, show, unitOf } from "../../../core/ui/envelope";
import { AskAgent } from "../../../core/ui/AskAgent";
import { Card, CardHead } from "../../../core/ui/primitives";
import type { Envelope } from "../../../core/lib/api";
import { guardOf, noteKV, pivot, visibleNote, type Row } from "../../../core/lib/records";

/**
 * 护栏句。项目铁律:**"这个数该怎么读"必须与数字同段显示** ——
 * 取数层已经把它写进 note 的 `读法:` 之后,页面只负责端出来,不许省。省掉它 = 替上游打包票。
 */
function Guard({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
      读法 · {text}
    </p>
  );
}

/** 同一端点的护栏是同一句,取第一条即可(逐行重复没意义) */
function guardOfEnv(env: Envelope): string {
  for (const e of env.evidence) {
    const g = guardOf(e.note ?? "");
    if (g) return g;
  }
  return "";
}

/** 温度计的一行:代码 + 名称 + 当期值 + 若干变动列 */
function ThermoRow({ row, valueField, cols }: { row: Row; valueField: string; cols: [string, string][] }) {
  const v = row.fields[valueField];
  const kv = noteKV(row.note);
  // 有 name= 就用它;没有就出可见 note(由 CSS 省略、完整留 tooltip)。
  // 别再按标点截断 —— 那是猜格式,而且截出来的半句看着像渲染坏了。
  const label = kv.name ?? (visibleNote(row.note) || row.key);
  return (
    <div className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
      <span className="w-14 shrink-0 truncate font-mono text-muted-foreground">{row.key}</span>
      <span className="min-w-0 flex-1 truncate" title={row.note}>
        {label}
      </span>
      <span className="tnum w-28 shrink-0 text-right" title={v ? `${v.period} · ${v.id}` : "无此项"}>
        {show(v)}
        {unitOf(v) ? <span className="ml-0.5 text-[10.5px] text-muted-foreground">{unitOf(v)}</span> : null}
      </span>
      {cols.map(([f, t]) => (
        <span key={f} className="w-16 shrink-0 text-right" title={t}>
          <PctCell ev={row.fields[f]} />
        </span>
      ))}
    </div>
  );
}


export function Signals() {

  return (
    <PageShell query="signals">
      {({ block }) => (
    <div className="space-y-4">
      <Card>
        <CardHead
          title="这一页在回答什么"
          note="公司自己之外,它所在的产业链本身是冷是热。跟公司口径对得上=互相印证;对不上=反证,喂给裁决点。"
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          ⚠️ 在一次<span className="text-foreground">研究运行</span>里,这些温度计按标的的产业标签自动挂载 ——
          没命中标签就是不相关,不是缺数据。这一页是手动巡检,所以全部列出。
        </p>
      </Card>

      <Block b={block("tw_revenue")}>
        {(res) => {
          const rows = pivot(res.envelope);
          const diff = rows.find((r) => r.fields.tw_chain_differential);
          const firms = rows.filter((r) => r.fields.tw_monthly_revenue);
          return (
            <div>
              <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                <span className="w-14">代码</span>
                <span className="flex-1">公司与角色</span>
                <span className="w-28 text-right">当月营收</span>
                <span className="w-16 text-right">环比</span>
                <span className="w-16 text-right">同比</span>
              </div>
              {firms.map((r) => (
                <ThermoRow
                  key={r.key}
                  row={r}
                  valueField="tw_monthly_revenue"
                  cols={[
                    ["tw_monthly_revenue_mom_pct", "环比上月"],
                    ["tw_monthly_revenue_yoy_pct", "同比去年同月"],
                  ]}
                />
              ))}
              {diff ? (
                <div className="mt-3 rounded-md bg-muted/60 px-2.5 py-2 text-[11.5px] leading-relaxed">
                  <span className="text-muted-foreground">链路差分 </span>
                  <span className="tnum">{show(diff.fields.tw_chain_differential)}</span>
                  {/* 只出 `读法:` 之前那段:护栏在下面单独渲染,这里再铺一遍就成了带 raw_ref 的噪音 */}
                  <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground" title={diff.note}>
                    {visibleNote(diff.note)}
                  </div>
                </div>
              ) : null}
              <Guard text={guardOfEnv(res.envelope)} />
            </div>
          );
        }}
      </Block>

      <div className="grid gap-4 xl:grid-cols-2">
        <Block b={block("gpu_rent")}>
          {(res) => (
            <div>
              {pivot(res.envelope).map((r) => (
                <div key={r.key} className="border-b border-border/40 py-1.5 text-[11.5px]">
                  <div className="flex items-baseline gap-2">
                    <span className="w-14 shrink-0 font-mono">{r.key}</span>
                    <span className="tnum min-w-0 flex-1">
                      {show(r.fields.gpu_spot_median_usd_per_gpu_hr)}
                      {unitOf(r.fields.gpu_spot_median_usd_per_gpu_hr) ? (
                        <span className="ml-0.5 text-[10.5px] text-muted-foreground">
                          {unitOf(r.fields.gpu_spot_median_usd_per_gpu_hr)}
                        </span>
                      ) : null}
                    </span>
                    <span className="tnum w-16 shrink-0 text-right text-muted-foreground">
                      {show(r.fields.gpu_spot_offer_count ?? r.fields.gpu_forward_rung_count)} 档
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground" title={r.note}>
                    {visibleNote(r.note)}
                  </div>
                </div>
              ))}
              <Guard text={guardOfEnv(res.envelope)} />
            </div>
          )}
        </Block>

        <Block b={block("dram")}>
          {(res) => (
            <div>
              <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
                <span className="w-14">品类</span>
                <span className="flex-1" />
                <span className="w-28 text-right">均价</span>
                <span className="w-16 text-right">7 日</span>
                <span className="w-16 text-right">30 日</span>
              </div>
              {pivot(res.envelope).map((r) => (
                <ThermoRow
                  key={r.key}
                  row={r}
                  valueField="dram_spot_avg"
                  cols={[
                    ["dram_spot_chg7_pct", "约 7 日"],
                    ["dram_spot_chg30_pct", "约 30 日"],
                  ]}
                />
              ))}
              <Guard text={guardOfEnv(res.envelope)} />
            </div>
          )}
        </Block>
      </div>

      <Block b={block("commodity")}>
        {(res) => (
          <div>
            <div className="flex items-baseline gap-2 pb-1 text-[10.5px] text-muted-foreground">
              <span className="w-14">合约</span>
              <span className="flex-1">用途</span>
              <span className="w-28 text-right">收盘</span>
              <span className="w-16 text-right">7 日</span>
              <span className="w-16 text-right">30 日</span>
            </div>
            {pivot(res.envelope).map((r) => (
              <ThermoRow
                key={r.key}
                row={r}
                valueField="commodity_futures_close"
                cols={[
                  ["commodity_futures_chg7_pct", "约 7 日"],
                  ["commodity_futures_chg30_pct", "约 30 日"],
                ]}
              />
            ))}
            <Guard text={guardOfEnv(res.envelope)} />
          </div>
        )}
      </Block>

      <Block b={block("hiring")}>
        {(res) => {
          const ex = res.envelope.extra ?? {};
          const degraded = typeof ex.degraded === "string" ? ex.degraded : "";
          const warnings = Array.isArray(ex.warnings) ? ex.warnings.map(String) : [];
          const rows = pivot(res.envelope);
          if (rows.length === 0) {
            return (
              <div className="text-[12px] leading-relaxed">
                {/* 🔴 0 条不等于 0 岗位。照抄取数层自己给的降级说明,不改写成"暂无数据"。 */}
                <p className="text-warning">{degraded || "本次没有可用锚点"}</p>
                {warnings.map((w) => (
                  <p key={w} className="mt-1 text-muted-foreground">
                    {w}
                  </p>
                ))}
                <p className="mt-2 text-muted-foreground">
                  这一层只在一次<span className="text-foreground">研究运行</span>
                  里取得到:锚点由标的的产业标签决定,单独取数没有那个上下文。
                </p>
              </div>
            );
          }
          return (
            <div>
              {rows.map((r) => (
                <div key={r.key} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                  <span className="min-w-0 flex-1 truncate" title={r.note}>
                    {r.key}
                  </span>
                  <span className="tnum w-20 shrink-0 text-right">
                    {show(Object.values(r.fields).find((e) => e?.field.includes("count")))}
                  </span>
                </div>
              ))}
              <Guard text={guardOfEnv(res.envelope)} />
            </div>
          );
        }}
      </Block>

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointPanel
          endpoint="macro_probability"
          title="宏观预期概率"
          note="预测市场合约的隐含概率(约 28 秒,按需取);是资金预期不是预报"
          lazy
        >
          {(res) => (
            <div>
              {pivot(res.envelope)
                .slice(0, 12)
                .map((r) => (
                  <div key={r.key} className="flex items-baseline gap-2 border-b border-border/40 py-1.5 text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate" title={r.note}>
                      {r.note}
                    </span>
                    <span
                      className="tnum w-16 shrink-0 text-right"
                      title={`${r.fields.macro_probability?.period ?? ""} · ${r.fields.macro_probability?.id ?? ""}`}
                    >
                      {show(r.fields.macro_probability)}
                    </span>
                  </div>
                ))}
              <Guard text={guardOfEnv(res.envelope)} />
            </div>
          )}
        </EndpointPanel>

        {/* 🔴 「管制与准入 / 名单核查」**刻意不在界面上展示**(Simon 明确要求)。
            它与供需正交、只是打折项,摆在这里只是噪音;但对分析有用 ⇒ 端点仍在,
            注册表标了 `exposure: "agent"`,AI 需要时照样能调。
            ⚠️ 光靠"这一页不渲染"守不住 —— 所以过滤做在 `listEndpoints` 的 `for_ui` 上。 */}
      </div>

      <AskAgent prompt={"把这一页的产业温度计跟我关注标的的最新财报口径做一次对照:哪几项互相印证,哪几项对不上?对不上的写成裁决点。"}>就产业信号问 Agent</AskAgent>
        </div>
      )}
    </PageShell>
  );
}
