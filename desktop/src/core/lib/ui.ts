import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * **垂类 UI 注册点**(Core 侧)。
 *
 * 🔴 边界:**Core 的外壳不许 import 垂类**。Shell 不该知道有哪些具体栏目 ——
 *    它只知道"有若干导航项、每项有路径与图标"。换个行业换一套导航,Shell 一行不用改。
 *    ⇒ 依赖方向单向:垂类 → Core,永远不反过来。由**组装根**(main.tsx)把垂类接进来。
 *
 * ⚠️ 这与后端的 `Plugin` 是同一套思路的前端版:契约在 Core,内容在垂类包,注册期校验。
 */

export interface NavItem {
  /** URL 路径,同时也是 key */
  path: string;
  label: string;
  icon: LucideIcon;
  /** 分组名;undefined = 第一组(不显示组标题) */
  group?: string;
  /** 一句话说明这一页在回答什么问题。用作页头副标题与 Agent 的上下文 */
  intent: string;
}

export interface VerticalUi {
  /** 产品名(显示在侧栏顶部) */
  brand: string;
  /** 分组的显示顺序。没列到的分组排在最后 —— 不丢,只是排后面 */
  groups: readonly string[];
  nav: readonly NavItem[];
  /** 路径 → 页面组件 */
  pages: Readonly<Record<string, ComponentType>>;
  /**
   * **详情路由**:有页面、但**故意不进导航**的那些(如 `/sectors/:key`)——
   * 它们从别的页面链过去,侧栏里不该多出一项。
   *
   * 🔴 与 `pages` 分开声明,是为了让"有页面却点不到"这条校验继续有效:
   *    如果详情页混进 `pages`,那条校验就只能整个关掉,于是**真正的孤儿页也查不出来了**。
   */
  detailRoutes?: Readonly<Record<string, ComponentType>>;
  defaultPath: string;
  /**
   * 垂类自己的界面文案。
   * 🔴 用户可见的字里如果带行业词(输入框提示、示例),它就**不是 Core 的东西** ——
   *    换个行业那句话就得改,而它躺在通用组件里没人会想起来。⇒ 由垂类给。
   */
  copy: {
    /** 对话输入框的提示 */
    agentPlaceholder: string;
    /** 对话区的一句话说明:能问什么、不能问什么 */
    agentHint: string;
    /** 导入资料时"补充说明"的示例 */
    importNoteExample: string;
  };
}

let current: VerticalUi | null = null;

/**
 * 注册垂类 UI。**只在组装根调一次**。
 * @throws 导航与页面对不上时立刻抛错 —— 不能等用户点进去看白屏,那种失效没人会发现。
 */
export function registerVerticalUi(ui: VerticalUi): void {
  const missing = ui.nav.filter((n) => !ui.pages[n.path]).map((n) => n.path);
  if (missing.length) throw new Error(`导航有项没有对应页面:${missing.join(", ")}`);
  // 反向也要查:有页面却进不了导航 = 用户永远点不到它,而且没人会发现
  const orphan = Object.keys(ui.pages).filter((p) => !ui.nav.some((n) => n.path === p));
  if (orphan.length) throw new Error(`有页面不在导航里(点不到):${orphan.join(", ")}`);
  if (!ui.pages[ui.defaultPath]) throw new Error(`默认路径 ${ui.defaultPath} 没有对应页面`);
  const dup = ui.nav.map((n) => n.path).filter((p, i, a) => a.indexOf(p) !== i);
  if (dup.length) throw new Error(`导航路径重复:${dup.join(", ")}`);
  // 详情路由要真的是"详情":必须带参数段。不带参数的静态路径应该进导航,
  // 否则它就是一个谁也点不到的页面 —— 而 detailRoutes 恰好会让上面那条校验放它过去。
  const notDetail = Object.keys(ui.detailRoutes ?? {}).filter((p) => !p.includes(":"));
  if (notDetail.length) throw new Error(`detailRoutes 里这些没有参数段,应该进导航而不是这里:${notDetail.join(", ")}`);
  const clash = Object.keys(ui.detailRoutes ?? {}).filter((p) => p in ui.pages);
  if (clash.length) throw new Error(`同一路径既在 pages 又在 detailRoutes:${clash.join(", ")}`);
  // 🔴 详情路由必须挂在一个**真实存在的静态父页面**下(`/sectors/:key` → `/sectors`)。
  //    只查"带参数段"是不够的:`/nowhere/:id` 同样带参数、同样不与 pages 冲突,
  //    于是它绕过孤儿页校验,变成一个谁也点不到的页面(审计 pages-r1-P3)。
  const noParent = Object.keys(ui.detailRoutes ?? {}).filter((p) => {
    const parent = p.slice(0, p.indexOf("/:"));
    return !(parent in ui.pages);
  });
  if (noParent.length) {
    throw new Error(`detailRoutes 的静态父路径不在 pages 里(这样它谁也点不到):${noParent.join(", ")}`);
  }
  current = ui;
}

export function verticalUi(): VerticalUi {
  if (!current) throw new Error("垂类 UI 还没注册 —— 组装根(main.tsx)要先调 registerVerticalUi");
  return current;
}

/** 按注册的分组顺序把导航分好组(没列到的分组排在最后,**不丢**) */
export function navGroups(ui: VerticalUi): { group: string | undefined; items: NavItem[] }[] {
  const seen = new Map<string | undefined, NavItem[]>();
  for (const n of ui.nav) {
    if (!seen.has(n.group)) seen.set(n.group, []);
    seen.get(n.group)!.push(n);
  }
  const ordered: (string | undefined)[] = [undefined, ...ui.groups];
  const rest = [...seen.keys()].filter((g) => !ordered.includes(g));
  return [...ordered, ...rest].filter((g) => seen.has(g)).map((g) => ({ group: g, items: seen.get(g)! }));
}
