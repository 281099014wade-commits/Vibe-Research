import type { Envelope, Evidence } from "./api";

/**
 * 取数层是**长表**:同一个信封里,N 个 record_key × M 个 field 平铺成一串证据
 * (例:板块资金流 50 个板块 × 3 个字段 = 150 条)。页面要的是"一行一个对象",
 * 所以这里统一透视一次 —— 每个页面各写一遍分组逻辑,迟早写出不一样的口径。
 */
export interface Row {
  key: string;
  /** 取数层给的人话说明。**原样保留** —— 各端点格式不同,解析它就是在赌格式不变 */
  note: string;
  fields: Record<string, Evidence | undefined>;
}

export function pivot(env: Envelope): Row[] {
  const byKey = new Map<string, Row>();
  for (const e of env.evidence) {
    // 没有 record_key 的是"整体指标"(如 limit_up_pool_count=65),不属于任何一行,单独取
    if (!e.record_key) continue;
    let row = byKey.get(e.record_key);
    if (!row) {
      row = { key: e.record_key, note: e.note ?? "", fields: {} };
      byKey.set(e.record_key, row);
    }
    // 同 key 同 field 出现多次时保留第一条(实测未见;真出现了也不该悄悄覆盖)
    row.fields[e.field] ??= e;
    if (!row.note && e.note) row.note = e.note;
  }
  return [...byKey.values()];
}

/** 整体指标:没有 record_key 的那一条(如 limit_up_pool_count) */
export function scalar(env: Envelope, field: string): Evidence | undefined {
  return env.evidence.find((e) => e.field === field && !e.record_key);
}

export function num(ev: Evidence | undefined): number | null {
  if (!ev || ev.value === null) return null;
  const n = typeof ev.value === "number" ? ev.value : Number(ev.value);
  return Number.isFinite(n) ? n : null;
}

/** 按某个字段排序。取不到值的行一律沉底 —— 不当成 0(那会让"没数据"冒充极值排到榜首或榜尾)。 */
export function sortBy(rows: Row[], field: string, dir: "desc" | "asc" = "desc"): Row[] {
  return [...rows].sort((a, b) => {
    const x = num(a.fields[field]);
    const y = num(b.fields[field]);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return dir === "desc" ? y - x : x - y;
  });
}

/**
 * note 里的 `键=值;键=值` 片段(新闻类端点一致采用:source / url / link / published / domain / topic / name)。
 * 🔴 只按白名单精确取,不做通用 split —— 财联社的 `content=` 正文里本身就含分号,
 *    通用切分会切出一堆垃圾键,而且不会报错。
 */
const KEYS = [
  "source",
  "url",
  "link",
  "published",
  "domain",
  "topic",
  "name",
  "kind",
  "author",
  "period_basis",
  "period",
  "lag_months",
  "n_offers",
  "gpu",
] as const;

/**
 * 🔴 取值边界是"下一个**已知键**",不是"下一个分号"。
 *    实测 `name=台光电子·CCL(M8/M9;英伟达链 + AWS Trainium 独供)` 的值里本身就含分号 ——
 *    按分号切会把标签截成半句(而且看着像是渲染坏了,不像数据问题,极难追)。
 *    末尾的 `读法:` 段由 guardOf 单独取,所以也算一个边界。
 */
const KV = new RegExp(
  `(?:^|;)\\s*(${KEYS.join("|")})=([\\s\\S]*?)(?=;\\s*(?:${KEYS.join("|")})=|;\\s*读法:|$)`,
  "g",
);

export function noteKV(note: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of note.matchAll(KV)) {
    const k = m[1];
    const v = m[2];
    if (k && v !== undefined && !(k in out)) out[k] = v.trim();
  }
  return out;
}

/**
 * 取数层把"这个数该怎么读"写在 note 的 `读法:` 之后(温度计 / 数据日历 / 管制层都有)。
 * 项目铁律:**护栏句必须与数字同段显示** —— 只给数字不给读法,等于替上游打包票。
 */
export function guardOf(note: string): string {
  const i = note.indexOf("读法:");
  return i < 0 ? "" : note.slice(i + 3).trim();
}

/**
 * 可见的 note:去掉 `读法:` 段(护栏另有位置显示)与 `raw_ref…=…` 段(落盘文件名,几十字符)。
 * ⚠️ **只是不占版面,不是删掉** —— 调用处必须把完整 note 放进 title,
 *    溯源路径是这个产品的立身之本,不能因为难看就丢。
 */
export function visibleNote(note: string): string {
  return note
    .split("读法:")[0]!
    .replace(/;?\s*raw_ref[^=;]*=[^;]*/g, "")
    .replace(/;\s*$/, "")
    .trim();
}

/** note 常以 record_key 开头(如 `000017 深中华A …`);代码已单独显示时把它去掉,只做精确前缀匹配 */
export function labelOf(row: Row): string {
  const n = row.note;
  return n.startsWith(`${row.key} `) ? n.slice(row.key.length + 1) : n;
}
