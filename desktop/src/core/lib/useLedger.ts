import { useEffect } from "react";
import { create } from "zustand";

import { ApiError, api, type LedgerIssue, type LedgerKindDef, type LedgerRecord } from "./api";

/**
 * 台账的共享状态。**四个页面看同一份数据** —— 在「计划」里写下的判据,
 * 「行动」页要立刻能看到到期情况;各页各拉一份的话,保存完另一页还是旧的,而且不会报错。
 */
/** 台账视图。页面把它整份往下传(比逐个 prop 传四种记录清楚) */
export interface LedgerView {
  phase: "idle" | "loading" | "ready" | "error";
  error: string;
  kinds: Record<string, LedgerKindDef>;
  /** 字段 / 枚举显示名(垂类声明);Core 组件按它渲染,查不到就用原键名 */
  labels: { fields: Record<string, string>; enums: Record<string, string> };
  records: Record<string, LedgerRecord[]>;
  /** 磁盘上不合契约的记录(用户手改过 JSON)。有就提示他去修,别装看不见 */
  issues: Record<string, LedgerIssue[]>;
  /** 正在写入(禁用表单,避免重复提交) */
  saving: boolean;
  load: () => Promise<void>;
  save: (kind: string, record: Record<string, unknown>) => Promise<LedgerRecord>;
  remove: (kind: string, id: string) => Promise<void>;
}

export const useLedger = create<LedgerView>((set, get) => ({
  phase: "idle",
  error: "",
  kinds: {},
  labels: { fields: {}, enums: {} },
  records: {},
  issues: {},
  saving: false,

  load: async () => {
    set({ phase: "loading", error: "" });
    try {
      const d = await api.ledger();
      set({ phase: "ready", kinds: d.kinds, labels: d.labels ?? { fields: {}, enums: {} }, records: d.records, issues: d.issues ?? {} });
    } catch (e) {
      set({ phase: "error", error: e instanceof ApiError ? `${e.code} · ${e.message}` : String(e) });
    }
  },

  save: async (kind, record) => {
    set({ saving: true });
    try {
      const saved = await api.ledgerSave(kind, record);
      // 写完整份重拉。**不做本地乐观合并** —— id / created_at 由后端决定,
      // 本地拼一份"看起来一样"的记录,迟早与磁盘上的真值不一致,而且没人会发现。
      await get().load();
      return saved;
    } finally {
      set({ saving: false });
    }
  },

  remove: async (kind, id) => {
    set({ saving: true });
    try {
      await api.ledgerDelete(kind, id);
      await get().load();
    } finally {
      set({ saving: false });
    }
  },
}));

/** 页面挂载时确保数据已加载(已加载过就不重复拉) */
export function useLedgerData(): LedgerView {
  const s = useLedger();
  const phase = s.phase;
  const load = s.load;
  useEffect(() => {
    if (phase === "idle") void load();
  }, [phase, load]);
  return s;
}

export const recordsOf = (s: LedgerView, kind: string): LedgerRecord[] => s.records[kind] ?? [];

export const str = (r: LedgerRecord, f: string): string => (typeof r[f] === "string" ? (r[f] as string) : "");
export const numOf = (r: LedgerRecord, f: string): number | null =>
  typeof r[f] === "number" && Number.isFinite(r[f]) ? (r[f] as number) : null;

/** 今天(本地日历日)。判"到期没有"一律用这一处口径,别各页各写各的 */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type DueState = "overdue" | "today" | "soon" | "later" | "none";

/**
 * 到期状态。**"没写到期日"是独立一档(none),不是"很久以后"** ——
 * 把它并进 later 会让一批永远不会被提醒的条目看起来很安全。
 */
export function dueState(due: string, soonDays = 7): DueState {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return "none";
  const t = today();
  if (due < t) return "overdue";
  if (due === t) return "today";
  const limit = new Date(`${t}T00:00:00`);
  limit.setDate(limit.getDate() + soonDays);
  const p = (n: number) => String(n).padStart(2, "0");
  const limitStr = `${limit.getFullYear()}-${p(limit.getMonth() + 1)}-${p(limit.getDate())}`;
  return due <= limitStr ? "soon" : "later";
}

export const DUE_LABEL: Record<DueState, string> = {
  overdue: "已过期",
  today: "今天到期",
  soon: "临近",
  later: "未到期",
  none: "无到期日",
};
