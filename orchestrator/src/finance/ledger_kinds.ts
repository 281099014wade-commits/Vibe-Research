/**
 * 金融垂类的**台账记录种类**。Core 只提供存储与校验(`src/ledger.ts`),种类与字段全在这里。
 *
 * 四种记录构成一个经营闭环:
 *   计划(thesis) → 判据(criterion) → 现状(position) → 到期要做的事(action)
 * **顺序是有意的**:先写下目标与判据,后面所有"偏离"才有参照物。
 *
 * 🔴 红线:这些是**用户自己写下的东西**,产品不替他生成建仓建议。
 *    界面只做两件事:把他写的原样呈现出来,以及把"哪条到期了"算出来。
 */
import type { LedgerKindDef } from "../plugin.ts";

/** 主体代码:六位数字,或留空(组合级的计划不针对单一主体) */
const SYMBOL = { type: "string", pattern: "^([0-9]{6})?$" };
/**
 * 日期:留空,或一个**真实存在的日历日**。
 * 🔴 只写 `^\d{4}-\d{2}-\d{2}$` 是不够的 —— `2026-99-99` / `2026-02-31` 都能过,
 *    然后进"到期清单"参与排序与提醒:**永远不触发,保存却报成功**。
 * `format: "date"` 由 Core 的 `ledger.ts` 自己注册(不依赖 ajv-formats 插件,
 * 所以不存在"没装就静默不校验"那种情况)。
 */
const DATE = { type: "string", anyOf: [{ maxLength: 0 }, { format: "date" }] };
const TEXT = (max = 500) => ({ type: "string", maxLength: max });
const NONEMPTY = (max = 500) => ({ type: "string", minLength: 1, maxLength: max, pattern: "\\S" });

export const FINANCE_LEDGER_KINDS: Record<string, LedgerKindDef> = {
  /** 持有记录:成本与数量是用户自己的事实,产品不猜也不改 */
  position: {
    label: "持有",
    properties: {
      symbol: { type: "string", pattern: "^[0-9]{6}$" },
      name: TEXT(40),
      account: TEXT(40),
      shares: { type: "number", minimum: 0 },
      cost: { type: "number", minimum: 0 },
      opened_at: DATE,
      note: TEXT(1000),
    },
    required: ["symbol", "shares", "cost"],
  },

  /** 论点:为什么持有 / 为什么关注。**这是经营闭环的地基** —— 没有它就谈不上"偏离" */
  thesis: {
    label: "论点",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(120),
      statement: TEXT(4000),
      review_by: DATE,
      status: { type: "string", enum: ["active", "paused", "closed"] },
      note: TEXT(1000),
    },
    required: ["title"],
  },

  /**
   * 判据:到期必裁的**裁决点**,或写死的**证伪条件**。
   * 两者共用一种记录、靠 `type` 区分 —— 它们的生命周期完全一样(写下 → 到期 → 判定),
   * 拆成两种只会让"到期清单"要去合并两张表。
   */
  criterion: {
    label: "判据",
    properties: {
      symbol: SYMBOL,
      thesis_id: TEXT(80),
      type: { type: "string", enum: ["decision_point", "falsifier"] },
      statement: NONEMPTY(1000),
      /** 到期日:裁决点通常有,证伪条件可以没有(它是随时可能触发的条件,不是日程) */
      due: DATE,
      status: { type: "string", enum: ["pending", "met", "broken", "dropped"] },
      note: TEXT(1000),
    },
    required: ["type", "statement"],
  },

  /** 行动:待办。可由判据到期生成,也可以自己写 */
  action: {
    label: "行动",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(200),
      due: DATE,
      status: { type: "string", enum: ["open", "done", "dropped"] },
      /** 关联的判据 / 论点 / 研究运行 id —— 只存字符串,不做外键约束 */
      ref: TEXT(120),
      note: TEXT(1000),
    },
    required: ["title"],
  },
};
