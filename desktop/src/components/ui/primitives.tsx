import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import type { AsyncState } from "../../lib/useAsync";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- 容器 ---------- */

export function Card({ children, className, glow }: { children: ReactNode; className?: string; glow?: boolean }) {
  return <div className={cx("glass p-4", glow && "glass-glow", className)}>{children}</div>;
}

export function CardHead({ title, note, right }: { title: string; note?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium tracking-wide text-foreground">{title}</h3>
        {note ? <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{note}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

/* ---------- 标记 ---------- */

export type Tone = "neutral" | "primary" | "success" | "danger" | "warning";

const TONE: Record<Tone, string> = {
  // 底色一律走 /15 透明度叠在卡面上,文字用足色 —— 深浅两套主题下都够对比度
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/15 text-primary",
  success: "bg-success/15 text-success",
  danger: "bg-danger/15 text-danger",
  warning: "bg-warning/15 text-warning",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium", TONE[tone])}>
      {children}
    </span>
  );
}

/** 运行状态 → 语气。⚠️ 这里的红绿是"好坏",与行情涨跌无关,别混用同一套映射。 */
export function statusTone(status: string | null): Tone {
  if (status === "complete") return "success";
  if (status === "failed") return "danger";
  if (status === "incomplete" || status === "stale") return "warning";
  return "neutral";
}

/* ---------- 四态渲染 ---------- */

/**
 * 把 useAsync 的四态渲染成同一套外观。
 * `isEmpty` 判定由调用方给 —— 只有页面知道"空"是什么(0 条 / null / 全部过期)。
 */
export function Async<T>({
  state,
  children,
  isEmpty,
  emptyText = "暂无数据",
  onRetry,
}: {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  emptyText?: string;
  onRetry?: () => void;
}) {
  if (state.phase === "idle" || state.phase === "loading") {
    return (
      <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        读取中…
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="flex items-start gap-2 py-5 text-[12.5px]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <div className="text-foreground">读取失败 · {state.code}</div>
          <div className="mt-0.5 break-words text-muted-foreground">{state.error}</div>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 cursor-pointer rounded-md border border-border px-2 py-1 text-[11.5px] transition-colors hover:bg-muted"
            >
              重试
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (isEmpty?.(state.data)) {
    return (
      <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground">
        <Inbox className="h-3.5 w-3.5" aria-hidden />
        {emptyText}
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

/* ---------- 尚未接线的页面 ---------- */

/**
 * 占位块。**刻意写明"还没接"而不是画一堆假数据** ——
 * 假数据在演示时最好看,在验收时最贵:分不清哪些是真跑出来的。
 */
export function NotWired({ what, plan }: { what: string; plan: string }) {
  return (
    <Card className="border-dashed">
      <CardHead title={what} note="尚未接入真实数据源" />
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{plan}</p>
    </Card>
  );
}
