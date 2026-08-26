import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";

import { useUi } from "../lib/store";
import { cx } from "./primitives";

/**
 * "就这一块问 Agent" —— 把当前这一屏的问题预填进对话框。
 *
 * 🔴 收成一个组件是因为**原来八个页面各写一遍同样的 className**:
 *    一处改亮、别处照旧,用户看到的是"有的按钮亮有的按钮暗",像是坏了。
 *
 * ⚠️ 样式用**主色描边 + 主色浅底**,不是透明底 + 中性描边 ——
 *    后者在深色主题下与页面底色几乎同色,看着像是禁用的。
 */
export function AskAgent({ prompt, children, className }: { prompt: string; children: ReactNode; className?: string }) {
  const openDock = useUi((s) => s.openDock);
  return (
    <button
      type="button"
      onClick={() => openDock(prompt)}
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-primary/45 bg-primary/10 px-3 py-1.5",
        "text-[12px] font-medium text-primary transition-colors hover:bg-primary/20",
        className,
      )}
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
      {children}
    </button>
  );
}
