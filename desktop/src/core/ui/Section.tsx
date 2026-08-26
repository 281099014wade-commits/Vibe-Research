import { ChevronRight } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { Card, cx } from "./primitives";

/**
 * 可折叠区块(下拉三角)。
 *
 * 🔴 折叠状态**记住**(存 localStorage):一页十几块时,用户每次进来都要重新收一遍
 *    等于这个功能没做。
 *
 * ⚠️ **折叠不等于不取数**。数据由 `PageShell` 一次取回,这里只管显示 ——
 *    否则展开一次就打一次上游,和"每次打开都重跑"是同一个毛病。
 *    ⇒ 想省取数请在**后端的查询声明**里少放一块,而不是靠界面折叠。
 *
 * 例外:`children` 传**函数**时按需求值,收起时连子树都不挂载。给"一屏几十条线、
 * 用户只看其中一条"的场景用(如研究 tag 列表)。🔴 懒挂载必须由本组件决定 ——
 * 调用方自己记"哪个展开过"会和这里的 localStorage 恢复对不上:上次展开过的
 * 这次一挂载就是展开的,但调用方的集合是空的,于是**展开着却一片空白**。
 */

const KEY = (id: string) => `vra.section.${id}`;

function initialOpen(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(KEY(id));
    return v === null ? fallback : v === "1";
  } catch {
    // 隐私模式 / 禁用存储时读写都会抛 —— 用默认值,别让一个显示偏好把页面弄崩
    return fallback;
  }
}

export function Section({
  id,
  title,
  note,
  right,
  defaultOpen = true,
  children,
}: {
  /** 稳定标识,用于记住折叠状态。**换了它等于清空用户在这一块上的偏好** */
  id: string;
  title: string;
  note?: string;
  right?: ReactNode;
  defaultOpen?: boolean;
  /** 传函数 = 收起时不挂载子树(见文件头注释) */
  children: ReactNode | (() => ReactNode);
}) {
  const [open, setOpen] = useState(() => initialOpen(id, defaultOpen));
  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(KEY(id), next ? "1" : "0");
      } catch {
        /* 存不下就只在本次会话生效,不影响使用 */
      }
      return next;
    });
  }, [id]);

  return (
    <Card>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-2 text-left"
      >
        <ChevronRight
          className={cx("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{title}</span>
          {note ? <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">{note}</span> : null}
        </span>
        {right ? <span className="shrink-0">{right}</span> : null}
      </button>
      {open ? <div className="mt-3">{typeof children === "function" ? children() : children}</div> : null}
    </Card>
  );
}
