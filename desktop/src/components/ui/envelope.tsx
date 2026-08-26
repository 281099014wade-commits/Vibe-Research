import type { Envelope, Evidence } from "../../lib/api";
import { Badge, cx, type Tone } from "./primitives";

/** 按 field 精确取一条证据。取不到就是没有 —— 调用方负责显示"缺",不要在这里造零值。 */
export function pick(env: Envelope, field: string): Evidence | undefined {
  return env.evidence.find((e) => e.field === field);
}

/** 同一 field 有多条(多个 record_key,如多家公司 / 多个品种)时全取。 */
export function pickAll(env: Envelope, field: string): Evidence[] {
  return env.evidence.filter((e) => e.field === field);
}

/**
 * 证据值 → 展示串。
 * 🔴 只做**呈现层**的千分位与小数位,不做任何换算(不把元换成万元、不把小数换成百分比)。
 *    换算属于计算层(calc),在这里顺手做会让页面上的数字与证据 value 对不上,
 *    而"对得上"正是这个产品的立身之本。
 */
export function show(ev: Evidence | undefined): string {
  if (!ev) return "—";
  const v = ev.value;
  if (v === null) return "—";
  if (typeof v === "number") {
    // 🔴 只补千分位,不改数值。上一版对 ≥1000 的数取整,9895.96 显示成 9,896 ——
    //    页面数字与证据 value 对不上,而"对得上"正是这个产品的立身之本。
    //    只设上限不设下限:整数就不拖 .00,小数原样留到 4 位(极小值放宽到 6 位,免得显示成 0)。
    const maximumFractionDigits = Math.abs(v) < 1 ? 6 : 4;
    return v.toLocaleString("zh-CN", { maximumFractionDigits });
  }
  return String(v);
}

/**
 * 榜单用的紧凑写法:`6,607,165,440 元` → `66.07 亿元`。
 * 🔴 与 show() 的分工:show 绝不换算;**换算只发生在这里,而且必须把目标单位一起显示出来**。
 *    调用处要把原值放进 title(tooltip),让"看到的"与"证据里的"随时能对上 —— 见 MoneyCell。
 *    只处理确定的十进制中文量纲,拿不准就退回 show(),不猜。
 */
export function compact(ev: Evidence | undefined): { text: string; unit: string } {
  if (!ev || typeof ev.value !== "number") return { text: show(ev), unit: unitOf(ev) };
  const v = ev.value;
  const abs = Math.abs(v);
  const scale = (n: number, unit: string) => ({
    text: (v / n).toLocaleString("zh-CN", { maximumFractionDigits: 2 }),
    unit,
  });
  if (ev.unit === "元") {
    if (abs >= 1e8) return scale(1e8, "亿元");
    if (abs >= 1e4) return scale(1e4, "万元");
  }
  if (ev.unit === "万元" && abs >= 1e4) return scale(1e4, "亿元");
  return { text: show(ev), unit: unitOf(ev) };
}

/** `n/a` / `date` / `text` 是取数层的类型标记,不是量纲,不能当单位贴在数字后面 */
const NOT_A_UNIT = new Set(["n/a", "date", "text", "", "none"]);

export function unitOf(ev: Evidence | undefined): string {
  return ev && !NOT_A_UNIT.has(ev.unit) ? ev.unit : "";
}

/** A 股口径:涨用 danger(红),跌用 success(绿)。与"好坏"无关,别复用状态色映射。 */
export function moveTone(v: number | string | null | undefined): Tone {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return "neutral";
  return n > 0 ? "danger" : "success";
}

function envTone(s: string): Tone {
  if (s === "ok") return "success";
  if (s === "partial") return "warning";
  return "danger";
}

/** 信封的元信息条:来源、资料期、状态、缺口。**缺口要显示出来**,不显示等于替上游打包票。 */
export function EnvelopeMeta({ env, ms }: { env: Envelope; ms?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <Badge tone={envTone(env.status)}>{env.status}</Badge>
      <span>
        源 <span className="text-foreground">{env.primary_source ?? "—"}</span>
      </span>
      <span>
        取于 <span className="tnum">{env.fetched_at.slice(0, 16).replace("T", " ")}</span>
      </span>
      {ms === undefined ? null : <span className="tnum">{ms} ms</span>}
      {env.missing.length > 0 ? <span className="text-warning">缺 {env.missing.length} 项</span> : null}
      {env.errors.length > 0 ? <span className="text-warning">报错 {env.errors.length} 条</span> : null}
    </div>
  );
}

/** 一格指标。数字下面挂资料期与证据 id —— 点得回去才算数。 */
export function Metric({
  label,
  ev,
  tone,
  big,
}: {
  label: string;
  ev: Evidence | undefined;
  tone?: Tone;
  big?: boolean;
}) {
  const color =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "";
  return (
    <div className="min-w-0">
      <div className="truncate text-[11.5px] text-muted-foreground">{label}</div>
      <div className={cx("tnum mt-0.5 font-medium", big ? "text-[21px]" : "text-[15px]", color)}>
        {show(ev)}
        {unitOf(ev) ? <span className="ml-1 text-[11px] font-normal text-muted-foreground">{unitOf(ev)}</span> : null}
      </div>
      <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground" title={ev?.id}>
        {ev ? `${ev.period} · ${ev.id}` : "无此项"}
      </div>
    </div>
  );
}

/**
 * 榜单里的金额格。**tooltip 一定带原值与证据 id** ——
 * 单元格里显示的是换算后的数,不给回溯路径就等于把"对得上"这件事丢了。
 */
export function MoneyCell({ ev, className }: { ev: Evidence | undefined; className?: string }) {
  const c = compact(ev);
  return (
    <span
      className={cx("tnum", className)}
      title={ev ? `${show(ev)} ${unitOf(ev)} · ${ev.period} · ${ev.id}` : "无此项"}
    >
      {c.text}
      {c.unit ? <span className="ml-0.5 text-[10.5px] text-muted-foreground">{c.unit}</span> : null}
    </span>
  );
}

/** 百分比格:按正负上 A 股涨跌色(红涨绿跌);零与缺值不着色。 */
export function PctCell({ ev, plain }: { ev: Evidence | undefined; plain?: boolean }) {
  const n = ev && typeof ev.value === "number" ? ev.value : null;
  const tone = plain ? "neutral" : moveTone(n);
  return (
    <span
      className={cx("tnum", tone === "danger" && "text-danger", tone === "success" && "text-success")}
      title={ev ? `${ev.period} · ${ev.id}` : "无此项"}
    >
      {n !== null && n > 0 ? "+" : ""}
      {show(ev)}
      {unitOf(ev) ? <span className="ml-0.5 text-[10.5px] text-muted-foreground">{unitOf(ev)}</span> : null}
    </span>
  );
}

/** 兜底:把信封里所有证据平铺成表。做实某一页之前先用它,至少显示的是真数据。 */
export function EvidenceTable({ env, limit = 40 }: { env: Envelope; limit?: number }) {
  const rows = env.evidence.slice(0, limit);
  return (
    <div className="space-y-0.5">
      {rows.map((e) => (
        <div key={e.id} className="flex items-baseline gap-2 border-b border-border/40 py-1 text-[11.5px]">
          <span className="min-w-0 flex-1 truncate">
            {e.field}
            {e.record_key && e.record_key !== e.symbol ? (
              <span className="ml-1.5 text-muted-foreground">{e.record_key}</span>
            ) : null}
          </span>
          <span className="tnum shrink-0">{show(e)}</span>
          <span className="w-10 shrink-0 truncate text-muted-foreground">{unitOf(e)}</span>
          <span className="w-20 shrink-0 truncate text-right text-muted-foreground">{e.period}</span>
        </div>
      ))}
      {env.evidence.length > rows.length ? (
        <p className="pt-1.5 text-[11px] text-muted-foreground">
          共 {env.evidence.length} 条,上面是前 {rows.length} 条
        </p>
      ) : null}
    </div>
  );
}
