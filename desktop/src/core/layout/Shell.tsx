import { Hexagon, MessageSquare, Moon, Sun, Upload } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { navGroups, verticalUi, type NavItem } from "../lib/ui";
import { useUi } from "../lib/store";
import { ImportPanel } from "../ui/ImportPanel";
import { cx } from "../ui/primitives";
import { AgentDock } from "./AgentDock";

const SIDEBAR = "w-[72px] lg:w-[232px]";
const SIDEBAR_OFFSET = "ml-[72px] lg:ml-[232px]";
/** 悬浮按钮压在页头右侧按钮上过一次(实测撞了「导入数据」)——给它留一条固定通道 */
const FAB_CHANNEL = "pr-[62px] xl:pr-[132px]";

function NavRow({ n }: { n: NavItem }) {
  return (
    <NavLink
      to={n.path}
      title={n.label}
      className={({ isActive }) =>
        cx(
          "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] transition-colors",
          isActive ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )
      }
    >
      <n.icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="hidden truncate lg:inline">{n.label}</span>
    </NavLink>
  );
}

function Sidebar() {
  const { theme, toggleTheme, dockOpen, toggleDock } = useUi();
  // 🔴 Core 的外壳**不认识任何一个具体栏目** —— 它只按注册进来的分组渲染。
  //    换个行业换一套导航,这个文件一行不用改(依赖方向:垂类 → Core,永不反向)。
  const ui = verticalUi();
  const groups = navGroups(ui);

  return (
    <aside
      className={cx(
        "fixed left-0 top-0 z-30 flex h-screen flex-col border-r border-border/60 bg-card/40 px-2.5 py-4 backdrop-blur-md lg:px-3",
        SIDEBAR,
      )}
    >
      <div className="mb-5 flex items-center gap-2 px-1.5">
        <Hexagon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="hidden text-[13px] font-medium tracking-wide lg:inline">{ui.brand}</span>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {groups.map(({ group, items }) => (
          <div key={group ?? "_"} className="space-y-1">
            {group ? (
              <div className="px-2.5 pb-1 pt-4 text-[10.5px] tracking-widest text-muted-foreground">
                <span className="hidden lg:inline">{group}</span>
                <span className="lg:hidden" aria-hidden>
                  ···
                </span>
              </div>
            ) : null}
            {items.map((n) => (
              <NavRow key={n.path} n={n} />
            ))}
          </div>
        ))}
      </nav>

      <div className="space-y-1 pt-3">
        <button
          type="button"
          onClick={toggleDock}
          aria-expanded={dockOpen}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          </span>
          <span className="hidden truncate lg:inline">{dockOpen ? "收起对话" : "Agent 就绪"}</span>
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {theme === "dark" ? (
            <Moon className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Sun className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <span className="hidden truncate lg:inline">切换{theme === "dark" ? "浅" : "深"}色</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * 当前这一页对应哪个导航项。
 * 🔴 **详情路由**(`/sectors/humanoid`)不在导航里,精确匹配会落空 ——
 *    那样页头整个不渲染,连"导入数据"都跟着消失,用户看到的是一个结构不一样的壳。
 *    ⇒ 落空时回退到**最长的前缀父项**(`/sectors`),页头与侧栏高亮都跟着父栏目走。
 * ⚠️ 前缀要连着 `/` 一起比 —— 否则 `/plan` 会把 `/planning-xyz` 也认成自己的孩子。
 */
function navHere(pathname: string) {
  const nav = verticalUi().nav;
  const exact = nav.find((n) => n.path === pathname);
  if (exact) return exact;
  return nav
    .filter((n) => n.path !== "/" && pathname.startsWith(n.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** 右上角悬浮按钮:与左下角那个是**同一个开关**,状态必须同步,不能各说各话 */
function AgentFab() {
  const { dockOpen, toggleDock } = useUi();
  const { pathname } = useLocation();
  const here = navHere(pathname);
  return (
    <button
      type="button"
      onClick={toggleDock}
      aria-expanded={dockOpen}
      title={here ? `就「${here.label}」跟 Agent 聊` : "跟 Agent 聊"}
      className={cx(
        "fixed right-6 top-[18px] z-[26] inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-[12.5px] font-medium text-primary-foreground transition-all xl:px-3.5",
        dockOpen ? "opacity-60 shadow-none" : "shadow-[0_8px_22px_hsl(var(--primary)/0.34)] hover:-translate-y-px",
      )}
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden xl:inline">问 Agent</span>
    </button>
  );
}

function PageHeader({ onImport }: { onImport: () => void }) {
  const { pathname } = useLocation();
  const here = navHere(pathname);
  if (!here) return null;
  return (
    <header className={cx("flex items-end justify-between gap-4 pb-5 pt-6", FAB_CHANNEL)}>
      <div className="min-w-0">
        <p className="text-[11.5px] tracking-wide text-muted-foreground">{here.intent}</p>
        <h1 className="mt-1 text-[22px] font-semibold leading-tight">{here.label}</h1>
      </div>
      <button
        type="button"
        onClick={onImport}
        className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-muted"
      >
        <Upload className="h-3.5 w-3.5" aria-hidden />
        导入数据
      </button>
    </header>
  );
}

export function Shell() {
  const dockOpen = useUi((s) => s.dockOpen);
  const [importing, setImporting] = useState(false);
  return (
    <div className="min-h-screen">
      <Sidebar />
      <div className={SIDEBAR_OFFSET}>
        <div className="px-6 lg:px-7">
          <PageHeader onImport={() => setImporting(true)} />
          {/* 导入面板挂在页头下、页面内容上:它是**跨页面**的动作,不属于任何一页 */}
          {importing ? (
            <div className="pb-4">
              <ImportPanel onClose={() => setImporting(false)} />
            </div>
          ) : null}
          {/* 展开对话区时给内容让位:纯 CSS,不测量高度。
              上一版用 JS 量过一次,页面在 0 高度容器里加载时把垃圾值锁死了,之后再也不更新。 */}
          <main className={dockOpen ? "pb-[398px]" : "pb-16"}>
            <Outlet />
          </main>
        </div>
      </div>

      <AgentFab />
      <AgentDock />

      <footer
        className={cx(
          "fixed left-0 right-0 z-20 border-t border-border/60 bg-background/80 px-6 py-2 text-center text-[11px] text-muted-foreground backdrop-blur-sm",
          dockOpen ? "bottom-[336px]" : "bottom-0",
        )}
      >
        本页只呈现数据与判据,不构成投资建议;不给目标价、不给买卖点。
      </footer>
    </div>
  );
}
