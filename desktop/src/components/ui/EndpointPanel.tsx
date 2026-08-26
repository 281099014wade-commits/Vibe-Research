import { RefreshCw } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { api, type FetchResult } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { EnvelopeMeta } from "./envelope";
import { Async, Card, CardHead } from "./primitives";

interface Props {
  endpoint: string;
  title: string;
  note?: string;
  symbol?: string;
  /** 覆盖注册表里该端点的默认参数(如 `{ top_n: 200 }`);后端按注册表声明校验,乱传会被拒 */
  args?: Record<string, unknown>;
  /** lazy = 点了才取。慢端点(实测 macro_probability 28 秒、大宗 8 秒)必须 lazy,否则拖垮整页首屏 */
  lazy?: boolean;
  className?: string;
  children: (res: FetchResult) => ReactNode;
}

function Body({ res, children }: { res: FetchResult; children: (r: FetchResult) => ReactNode }) {
  return (
    <div className="space-y-2.5">
      <EnvelopeMeta env={res.envelope} ms={res.duration_ms} />
      {/* status 非 ok 时照实说明,再照常渲染已经拿到的部分 ——
          partial 不是空:把它当空会丢掉真拿到的那一半数据。 */}
      {res.envelope.status !== "ok" ? (
        <p className="text-[11.5px] leading-relaxed text-warning">
          取数 {res.envelope.status}
          {res.envelope.errors.length ? `:${JSON.stringify(res.envelope.errors[0]).slice(0, 200)}` : ""}
        </p>
      ) : null}
      {children(res)}
    </div>
  );
}

/** args 是对象,每次渲染都是新引用 —— 直接进依赖数组会无限重取。按内容做键。 */
function useArgsKey(args: Record<string, unknown> | undefined): string {
  return args ? JSON.stringify(args) : "";
}

function buildReq(endpoint: string, symbol?: string, args?: Record<string, unknown>) {
  return { endpoint, ...(symbol === undefined ? {} : { symbol }), ...(args ? { args } : {}) };
}

function AutoPanel({ endpoint, symbol, args, children }: Pick<Props, "endpoint" | "symbol" | "args" | "children">) {
  const argsKey = useArgsKey(args);
  const fn = useCallback(() => api.fetch(buildReq(endpoint, symbol, args)), [endpoint, symbol, argsKey]);
  const { state, reload } = useAsync(fn, [endpoint, symbol, argsKey]);
  return (
    <Async state={state} onRetry={reload}>
      {(res) => <Body res={res}>{children}</Body>}
    </Async>
  );
}

function LazyPanel({ endpoint, symbol, args, children }: Pick<Props, "endpoint" | "symbol" | "args" | "children">) {
  const [res, setRes] = useState<FetchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    setBusy(true);
    setErr(null);
    api
      .fetch(buildReq(endpoint, symbol, args))
      .then(setRes)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-2.5">
      {err ? <p className="text-[12px] text-warning">取数失败:{err}</p> : null}
      {res ? <Body res={res}>{children}</Body> : null}
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "取数中…" : res ? "重新取数" : "取数"}
      </button>
    </div>
  );
}

/** 一个端点一张卡:自动或按需取数,元信息与失败态在这里一处收口。 */
export function EndpointPanel({ endpoint, title, note, symbol, args, lazy, className, children }: Props) {
  return (
    <Card className={className}>
      <CardHead
        title={title}
        note={note}
        right={<code className="font-mono text-[10.5px] text-muted-foreground">{endpoint}</code>}
      />
      {lazy ? (
        <LazyPanel endpoint={endpoint} symbol={symbol} args={args}>
          {children}
        </LazyPanel>
      ) : (
        <AutoPanel endpoint={endpoint} symbol={symbol} args={args}>
          {children}
        </AutoPanel>
      )}
    </Card>
  );
}

/** 页面级"重新读取"按钮的统一外观(刷什么由各页自己决定) */
export function RefreshButton({ onClick, label = "重新读取" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
