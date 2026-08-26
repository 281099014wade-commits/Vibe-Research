import { useState } from "react";

import { EndpointPanel } from "../components/ui/EndpointPanel";
import { PctCell, show, unitOf } from "../components/ui/envelope";
import { Card, CardHead, cx } from "../components/ui/primitives";
import type { Envelope } from "../lib/api";
import { guardOf, noteKV, pivot, visibleNote, type Row } from "../lib/records";
import { useUi } from "../lib/store";

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

const A_SHARE = /^(6\d{5}|0\d{5}|3\d{5})$/;

export function Signals() {
  const openDock = useUi((s) => s.openDock);
  const [input, setInput] = useState("300308");
  const [symbol, setSymbol] = useState("300308");
  const valid = A_SHARE.test(input.trim());

  return (
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

      <EndpointPanel
        endpoint="tw_monthly_revenue"
        title="台系月营收"
        note="法定每月 10 日前披露、滞后约 10 天 —— 追英伟达链实体排产最快的硬数据"
      >
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
      </EndpointPanel>

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointPanel endpoint="gpu_rent_thermometer" title="GPU 租金" note="现货撮合中位 + 远期合约;需求侧温度">
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
        </EndpointPanel>

        <EndpointPanel endpoint="dram_spot_thermo" title="DRAM 现货" note="社区转录的影子指标,不是官方一手价">
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
        </EndpointPanel>
      </div>

      <EndpointPanel
        endpoint="cn_commodity_futures"
        title="大宗原材料"
        note="沪铜 / 沪锡 / 沪铝 / 沪镍 / 工业硅(约 8 秒,按需取)"
        lazy
      >
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
      </EndpointPanel>

      <EndpointPanel
        endpoint="hiring_anchor_signal"
        title="招聘信号"
        note="产业锚点公司(上下游 / 需求侧,不是本公司)的公开在招岗位"
      >
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
      </EndpointPanel>

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

        <div className="space-y-4">
          <Card>
            <CardHead title="管制与准入" note="与供需正交:只当打折项,不重排名次" />
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
                className={cx(
                  "cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground",
                  "transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                查询
              </button>
            </div>
          </Card>
          <EndpointPanel
            endpoint="policy_access"
            symbol={symbol}
            lazy
            title={`名单核查 · ${symbol}`}
            note="联邦公报 1260H / BIS / FCC 逐条检索(约 7 秒)"
          >
            {(res) => (
              <div>
                {res.envelope.evidence.map((e) => (
                  <div key={e.id} className="border-b border-border/40 py-1.5 text-[11.5px]">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.field}</span>
                      <span className="tnum shrink-0" title={`${e.period} · ${e.id}`}>
                        {show(e)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground" title={e.note}>
                      {visibleNote(e.note ?? "")}
                    </div>
                  </div>
                ))}
                <Guard text={guardOfEnv(res.envelope)} />
              </div>
            )}
          </EndpointPanel>
        </div>
      </div>

      <button
        type="button"
        onClick={() =>
          openDock(
            "把这一页的产业温度计跟我关注标的的最新财报口径做一次对照:哪几项互相印证,哪几项对不上?对不上的写成裁决点。",
          )
        }
        className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
      >
        就产业信号问 Agent
      </button>
    </div>
  );
}
