import {
  Activity, BarChart3, Briefcase, CheckSquare, Database, Factory,
  LayoutDashboard, LineChart, NotebookPen, Radar, Settings as SettingsIcon, ShieldAlert, Swords, Target,
} from "lucide-react";

import type { VerticalUi } from "../../../core/lib/ui";
import { Actions } from "../pages/Actions";
import { Data } from "../pages/Data";
import { Debate } from "../pages/Debate";
import { Notes } from "../pages/Notes";
import { Operate } from "../pages/Operate";
import { Plan } from "../pages/Plan";
import { Radar as RadarPage } from "../pages/Radar";
import { Review } from "../pages/Review";
import { Risk } from "../pages/Risk";
import { SectorDetail } from "../pages/SectorDetail";
import { Sectors } from "../pages/Sectors";
import { Settings } from "../pages/Settings";
import { Signals } from "../pages/Signals";
import { StockData } from "../pages/StockData";
import { Today } from "../pages/Today";

/**
 * 金融垂类的界面声明:叫什么、有哪些栏目、每个栏目是哪个页面。
 *
 * 🔴 **分组是「盘面 / 研究 / 我的」**,不是按功能模块分:
 *    · 盘面 = 市场此刻与刚过去的那一天在发生什么(外部事实)
 *    · 研究 = 我做过的研究与它依赖的数据(我的产出)
 *    · 我的 = 我自己写下的持仓、计划、判据、行动(我的输入)
 *    这三段对应"看市场 → 做研究 → 落到自己的决策",而不是把功能按技术模块摆一排。
 *
 * ⚠️ 导航与页面表**在这里一起声明**,注册时会双向查(有导航没页面 / 有页面没导航都当场炸)——
 *    分开写的话,加页面时总有一边忘改,表现是"侧栏点了白屏"或"页面永远点不到",而且不报错。
 */
export const NAV_GROUP_RESEARCH = "研究";
export const NAV_GROUP_MINE = "我的";
export const NAV_GROUP_SETTINGS = "设置";

export const FINANCE_UI: VerticalUi = {
  brand: "投研看板",
  groups: [NAV_GROUP_RESEARCH, NAV_GROUP_MINE, NAV_GROUP_SETTINGS],
  defaultPath: "/today",
  nav: [
    // ── 盘面(第一组,不显示组标题)
    { path: "/today", label: "今日总览", icon: LayoutDashboard, intent: "今天在发生什么 —— 盘中的市场温度" },
    { path: "/review", label: "每日复盘", icon: Activity, intent: "已经收完盘的那一天,场内资金在玩哪些板块" },
    { path: "/sectors", label: "板块中心", icon: BarChart3, intent: "板块之间此刻的强弱与资金流向" },
    { path: "/stock", label: "个股数据", icon: LineChart, intent: "单个主体的行情、估值与财务事实" },
    { path: "/radar", label: "资讯雷达", icon: Radar, intent: "一手信源与市场声音,只当线索不当事实" },
    { path: "/signals", label: "产业信号", icon: Factory, intent: "上下游温度计:产业链本身冷还是热" },
    // ── 研究
    { path: "/debate", label: "多空辩论", icon: Swords, group: NAV_GROUP_RESEARCH, intent: "同一份现拉的资料,多空各打一遍,裁判收口成判据" },
    { path: "/notes", label: "研究记录", icon: NotebookPen, group: NAV_GROUP_RESEARCH, intent: "自己写下来的东西,回头能翻得到" },
    { path: "/data", label: "研究归档", icon: Database, group: NAV_GROUP_RESEARCH, intent: "做过的研究运行、证据台账与数据源健康" },
    // ── 我的
    { path: "/operate", label: "持仓", icon: Briefcase, group: NAV_GROUP_MINE, intent: "持有的东西当下什么状态、偏离了多少" },
    { path: "/plan", label: "计划与判据", icon: Target, group: NAV_GROUP_MINE, intent: "写下的目标与判据,后面拿它对账" },
    { path: "/risk", label: "仓位与风险", icon: ShieldAlert, group: NAV_GROUP_MINE, intent: "集中度与已经写死的证伪条件" },
    { path: "/actions", label: "行动", icon: CheckSquare, group: NAV_GROUP_MINE, intent: "待办与到期必裁的裁决点" },
    // ── 设置(单独一组,排最后)
    { path: "/settings", label: "设置", icon: SettingsIcon, group: NAV_GROUP_SETTINGS, intent: "产品按什么配置在跑;要改去哪儿改" },
  ],
  copy: {
    agentPlaceholder: "问一句,或写下标的代码开始研究(Enter 发送,Shift+Enter 换行)",
    agentHint: '说"研究 300308"会**真起一次六阶段运行**;⚠️ 它没有网络,问实时行情它会让你去起一次运行,而不是报记忆里的数。',
    importNoteExample: "例如:这是券商 App 的持仓页截图",
  },
  /** 从板块中心的每条研究线链过去;侧栏里不该多出一项 */
  detailRoutes: { "/sectors/:key": SectorDetail },
  pages: {
    "/today": Today, "/review": Review, "/sectors": Sectors, "/stock": StockData,
    "/radar": RadarPage, "/signals": Signals, "/data": Data,
    "/debate": Debate, "/notes": Notes, "/settings": Settings,
    "/operate": Operate, "/plan": Plan, "/risk": Risk, "/actions": Actions,
  },
};

/** 按路径找导航项(页头副标题、Agent 上下文都要用) */
export const navByPath = (p: string) => FINANCE_UI.nav.find((n) => n.path === p);
