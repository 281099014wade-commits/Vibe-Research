/**
 * **金融垂类包**:Core 需要知道的、随垂类而变的全部东西都在这里。
 *
 * 这些常量原先散在 `config.ts`(阶段、脚本、计算函数、报告章节)与 `schemas.ts`
 * (证据枚举、标准列、议题)里 —— 换个垂类它们**每一条都要重写**,所以属于包不属于 Core。
 *
 * 🔴 改这里之前先想清楚:新增 / 改名一个阶段,要**同时**改 `stages`、`stageScripts`、
 * `stageCalcs`、`extraTopics` 四处。漏改哪一处,`registerDomainPack` 会在注册时当场报出来
 * (键集必须与 stages 完全一致)—— 这是故意的,别去放宽那个校验。
 */
import type { DomainPack } from "../domain.ts";
import { FINANCE_LEXICON } from "./lexicon.ts";
import { financeQuoteDecision } from "./quote_freshness.ts";
import { financeBaselinePeriod } from "./fiscal_year.ts";
import { FINANCE_ROLES, FINANCE_SLOTS } from "./semantic_slots.ts";

/** 阶段顺序:摸清公司 → 财务 → 一致预期 → 估值 → 风险 → 成文 */
export const FINANCE_STAGES = ["profile", "financials", "estimates", "valuation", "risk", "report"] as const;
export type FinanceStage = (typeof FINANCE_STAGES)[number];

export const FINANCE_PACK: DomainPack = {
  id: "finance",
  stages: FINANCE_STAGES,

  /** 每阶段必需 / 可选的取数脚本(由编排器执行;fetch/<script>.json 必须存在且有账本记录) */
  stageScripts: {
    profile: { required: ["fetch_profile", "fetch_quote", "fetch_trade_calendar"], optional: [] },
    financials: { required: ["fetch_financials"], optional: [] },
    estimates: { required: ["fetch_estimates"], optional: [] },
    valuation: { required: [], optional: ["fetch_pe_history"] },
    risk: { required: [], optional: ["fetch_announcements", "fetch_kline"] },
    report: { required: [], optional: [] },
  },

  /** 关键脚本全部失败 → 运行 failed(无法产出可用研究) */
  criticalScripts: ["fetch_quote", "fetch_financials", "fetch_estimates"],

  /** 每阶段必须出现的 calc 函数(calc 记录的 id 必须列在该阶段 calculation_ids;或 gaps 以 operation 精确说明) */
  stageCalcs: {
    profile: [],
    financials: ["quarterize", "latest_quarter", "ttm_sum", "ttm_yoy", "qoq"],
    estimates: ["forward_cagr", "consensus_dispersion"],
    valuation: ["pe_deducted_annualized", "forward_pe", "pe_ttm_from_parts", "percentile_rank", "peg",
      "pe_digestion_scenarios", "forward_vs_ttm_judgement"],
    risk: [],
    report: [],
  },

  /** 各阶段 extra_findings 允许的 topic(与 stages.ts 的 EXT_GUIDE / SOP §6 一致;schema 与 validator 双重约束) */
  extraTopics: {
    profile: ["行业归属", "股本与市值", "上市状态", "板块归属", "其他交叉核对"],
    financials: ["三表交叉", "资产负债要点", "现金流要点", "其他交叉核对"],
    estimates: ["逐篇预测", "评级分布", "其他线索"],
    valuation: ["估值历史", "分红", "其他交叉核对"],
    risk: ["资金行为", "解禁", "股东结构", "公告线索", "互动易", "新闻线索", "市场声音", "产业温度计",
      "卡口事件", "管制与准入", "数据日历", "海外头条", "招聘信号", "宏观概率", "其他线索"],
    report: ["汇总"],
  },

  /** report.md 必须出现的章节标题(SOP §5 骨架) */
  reportSections: ["结论摘要", "事实", "推断", "估值", "风险与反证", "裁决点", "数据缺口"],

  evidence: {
    /** 证券市场代码 */
    markets: ["SH", "SZ", "BJ", "CN", "US", "HK", "TW"],
    /** 复权口径:前复权 / 后复权 / 不复权 / 不适用 */
    adjustments: ["none", "qfq", "hfq", "not_applicable"],
    /** 这些区域码**可以**带全市场读数(大宗、DRAM 现货这类) */
    marketWideCodes: ["CN", "US", "HK"],
    /** CN **只**用于全市场读数:A 股个股用 SH / SZ / BJ,美股港股则是个股与全市场共用同一代码 */
    marketWideOnlyCodes: ["CN"],
  },

  /** 批量摘要的标准列 */
  standardColumns: ["pe_deducted_x4", "forward_pe", "pe_ttm_percentile", "peg", "forward_cagr", "ttm_yoy", "qoq"],

  /** 口径角色:营收 / 归母 / 扣非 */
  roles: FINANCE_ROLES,
  /** 语义槽位表(每阶段每个计算函数"输入该怎么选") */
  semanticSlots: FINANCE_SLOTS,
  /** "报价是否陈旧"的判定:交易日历 / 盘前 / 停牌 */
  quoteDecision: financeQuoteDecision as DomainPack["quoteDecision"],
  /** 阶段显示名(也是允许拼进文件路径的白名单) */
  stageLabels: {
    profile: "公司画像", financials: "财务", estimates: "一致预期",
    valuation: "估值", risk: "风险与线索", report: "成稿",
  },

  /** 议题 → 报告章节:没列进来的议题不进专属章节,只作全文要求 */
  topicSections: {
    资金行为: "资金与市场行为", 解禁: "资金与市场行为", 股东结构: "资金与市场行为",
    公告线索: "公告 · 互动易 · 新闻线索", 互动易: "公告 · 互动易 · 新闻线索", 新闻线索: "公告 · 互动易 · 新闻线索",
    市场声音: "市场声音", 产业温度计: "产业温度计", 卡口事件: "卡口事件",
    管制与准入: "管制与准入", 海外头条: "海外头条", 招聘信号: "招聘信号", 宏观概率: "宏观概率",
  },

  /** 变化提醒默认盯的证据字段 */
  alertFields: ["price", "total_market_cap", "pe_ttm", "pb", "eps_consensus_mean", "eps_analyst_count",
    "revenue_cum", "net_profit_parent_cum", "net_profit_deducted_cum", "margin_financing_balance_latest",
    "shareholder_count", "lockup_upcoming_count", "dragon_tiger_count", "block_trade_count",
    "research_report_count_1y", "pe_ttm_latest", "announcement_title"],

  /** 标准列的表头显示名 */
  standardColumnLabels: {
    pe_deducted_x4: "扣非×4 PE", forward_pe: "前瞻 PE", pe_ttm_percentile: "PE 分位", peg: "PEG",
    forward_cagr: "前瞻 CAGR", ttm_yoy: "TTM 同比", qoq: "QoQ",
  },

  /** 标准列住在估值阶段的产物里 */
  standardColumnsStage: "valuation",

  /** doctor 的 calc 自检:前瞻 PE = 100 / 5 = 20 */
  selfTestCalc: { fn: "forward_pe", args: { price: 100, eps_forecast: 5 }, expect: 20 },

  /** 基准期 = 当前财年 T */
  baselinePeriod: financeBaselinePeriod as DomainPack["baselinePeriod"],

  lexicon: FINANCE_LEXICON,
};
