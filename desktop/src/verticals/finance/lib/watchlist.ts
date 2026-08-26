/**
 * 自选股 —— **存在用户自有台账里**（`watch` 种类），不是浏览器缓存。
 * 理由与研究记录相同：清缓存不该让自选消失，而且 agent 要读得到。
 *
 * ⚠️ 读同步 / 写异步，缓存在 React 挂载前灌好（见 `main.tsx`）。
 */
import { backend, type LedgerRecord } from "./backend";

let cache: string[] = [];

const code6 = (v: unknown) => String(v ?? "").trim();
const isCode = (c: string) => /^\d{6}$/.test(c);

/** 台账里当前的 代码 → 记录 id。同一代码有多条时保留第一条，其余当重复处理 */
async function currentIds(): Promise<{ ids: Map<string, string>; dupes: string[] }> {
  const led = await backend.ledger();
  const rows: LedgerRecord[] = led.records.watch ?? [];
  const ids = new Map<string, string>();
  const dupes: string[] = [];
  for (const r of rows) {
    const c = code6(r.symbol);
    if (!isCode(c)) continue;
    if (ids.has(c)) dupes.push(r.id);
    else ids.set(c, r.id);
  }
  return { ids, dupes };
}

/**
 * 🔴 慢快照不许覆盖新缓存:hydrate 在途时若有写入完成,先发的那次 hydrate 会带回
 *    **不含新记录的旧快照**,落地后表现为"刚存的东西不见了"。用序号丢弃过期结果。
 */
let seq = 0;
export async function hydrateWatch(): Promise<void> {
  const mine = ++seq;
  const { ids } = await currentIds();
  if (mine !== seq) return;   // 期间又发生了一次 hydrate,以更晚那次为准
  cache = [...ids.keys()];
}

/** ⚠️ 返回**副本**:直接交出内部数组的话,调用方一个 `sort()` / `push()` 就改了缓存而没写台账 */
export function loadWatch(): string[] {
  return [...cache];
}

/**
 * 把列表写回台账（差集增删）。
 *
 * 🔴 **每次都以台账的真实状态算差集，不信任内存里的映射。**
 *    信内存的话，只要那份映射不是最新的（模块被重新加载过、另一个标签页写过），
 *    "已经有了"就会判成"还没有" ⇒ **静默写出重复记录**。
 *
 * ⚠️ **这只把窗口缩小，消不掉竞态。** 读状态和写回之间没有事务、没有版本校验，
 *    两个标签页同时保存仍可能各写一条同代码记录。真正兜底的是**每次保存开头的
 *    重复清扫**——它让重复自愈，而不是让重复不发生。要根治得在台账侧加唯一约束。
 * ⚠️ 中途失败时台账已经被改了一半 ⇒ **缓存一律以重读结果为准**，
 *    不能停在"写之前"或"想写成"的状态：那两种都会让界面显示一个从未存在过的列表。
 */
export async function saveWatch(codes: string[]): Promise<void> {
  const want = [...new Set(codes.filter(isCode))];
  try {
    const { ids, dupes } = await currentIds();
    for (const id of dupes) await backend.ledgerDelete("watch", id); // 顺手清掉历史重复
    for (const c of want) {
      if (!ids.has(c)) await backend.ledgerSave("watch", { symbol: c });
    }
    for (const [c, id] of ids) {
      if (!want.includes(c)) await backend.ledgerDelete("watch", id);
    }
  } finally {
    // 成功也好、写到一半炸了也好,缓存都刷成台账此刻的真实内容
    await hydrateWatch().catch(() => { /* 连重读都失败:保留旧缓存,错误由上面抛出去 */ });
  }
}

/** 从任意文本里抽 6 位 A 股代码（逗号 / 空格 / 换行 / 顿号都行，方便一次粘一串）。 */
export function parseCodes(raw: string): string[] {
  const tokens = raw.split(/[^\d]+/).filter(Boolean);
  return Array.from(new Set(tokens.filter(isCode)));
}

/** 并入已有自选，返回去重后的新列表 + 实际新增数量。 */
export function addCodes(existing: string[], raw: string): { next: string[]; added: number } {
  const incoming = parseCodes(raw).filter((c) => !existing.includes(c));
  return { next: [...existing, ...incoming], added: incoming.length };
}
