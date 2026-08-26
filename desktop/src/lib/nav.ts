import {
  Activity,
  BarChart3,
  Briefcase,
  CheckSquare,
  Database,
  Factory,
  LayoutDashboard,
  LineChart,
  Radar,
  ShieldAlert,
  Target,
  type LucideIcon,
} from "lucide-react";

/**
 * 导航是**唯一真相源**:路由表(App.tsx)与侧栏(Shell.tsx)都从这里读。
 * 两边各写一份的话,加页面时总有一边忘改 —— 表现是"侧栏有这一项、点了白屏",而且不报错。
 */
export interface NavItem {
  /** URL 路径,同时也是 key */
  path: string;
  label: string;
  icon: LucideIcon;
  /** 侧栏分组;undefined = 第一组(盘面),不显示组标题 */
  group?: string;
  /** 一句话说明这一页在回答什么问题,用作页头副标题与 Agent 的上下文 */
  intent: string;
}

export const NAV_GROUP_LOOP = "经营闭环";

export const NAV: readonly NavItem[] = [
  { path: "/today", label: "今日总览", icon: LayoutDashboard, intent: "今天有什么变了、要不要管" },
  { path: "/review", label: "每日复盘", icon: Activity, intent: "收盘后场内资金在玩哪些板块" },
  { path: "/sectors", label: "板块中心", icon: BarChart3, intent: "各板块的景气与拥挤度排序" },
  { path: "/stock", label: "个股数据", icon: LineChart, intent: "单个标的的行情、估值与财务事实" },
  { path: "/radar", label: "资讯雷达", icon: Radar, intent: "一手信源与市场声音,只当线索不当事实" },
  { path: "/signals", label: "产业信号", icon: Factory, intent: "上下游温度计:产业链本身冷还是热" },

  { path: "/operate", label: "组合经营", icon: Briefcase, group: NAV_GROUP_LOOP, intent: "持仓当下的经营状态与偏离" },
  { path: "/plan", label: "计划与风险", icon: Target, group: NAV_GROUP_LOOP, intent: "写下的目标与判据,后面拿它对账" },
  { path: "/risk", label: "资金与风险", icon: ShieldAlert, group: NAV_GROUP_LOOP, intent: "仓位、集中度与已写死的证伪条件" },
  { path: "/actions", label: "行动", icon: CheckSquare, group: NAV_GROUP_LOOP, intent: "待办与到期必裁的裁决点" },
  { path: "/data", label: "研究与数据", icon: Database, group: NAV_GROUP_LOOP, intent: "研究运行、证据台账与数据源健康" },
] as const;

export const DEFAULT_PATH = "/today";

export function navByPath(path: string): NavItem | undefined {
  return NAV.find((n) => n.path === path);
}
