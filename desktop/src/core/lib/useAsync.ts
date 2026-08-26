import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "./api";

/**
 * 取数状态。**四态必须分开**:未开始 / 进行中 / 出错 / 有数据。
 * 合成三态(把"出错"折成"没数据")会让页面把"接不上后端"渲染成"这里本来就是空的",
 * 用户看不出区别,而这两件事的处置完全不同。
 */
export type AsyncState<T> =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: string; code: string }
  | { phase: "ready"; data: T };

export interface AsyncResult<T> {
  state: AsyncState<T>;
  /**
   * 重新取。`refresh: true` = **真去取数**(而不是读上次的快照)。
   * 🔴 默认 false 是刻意的:页面打开、切页、依赖变化都不该触发真取数 ——
   *    那正是"每点开一次就把端点全跑一遍"的来源,既慢又费钱。
   */
  reload: (refresh?: boolean) => void;
}

export function useAsync<T>(fn: (refresh: boolean) => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ phase: "idle" });
  const [tick, setTick] = useState(0);
  /** 下一次取数要不要强制刷新。用 ref 而不是 state:它只是"这一次怎么取",不该自己触发重渲染 */
  const forceNext = useRef(false);
  // 竞态:切页 / 连点刷新会有多个请求在飞,晚发的先回时不能被早发的覆盖
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const mine = ++seq.current;
    let alive = true;
    setState({ phase: "loading" });
    // 取出并**立刻复位**:强制刷新只作用于这一次,不能粘到后面每一次
    const force = forceNext.current;
    forceNext.current = false;
    fnRef
      .current(force)
      .then((data) => {
        if (!alive || seq.current !== mine) return;
        setState({ phase: "ready", data });
      })
      .catch((e: unknown) => {
        if (!alive || seq.current !== mine) return;
        const err = e instanceof ApiError ? e : null;
        setState({
          phase: "error",
          error: err ? err.message : e instanceof Error ? e.message : String(e),
          code: err ? err.code : "unknown",
        });
      });
    return () => {
      alive = false;
    };
  }, [...deps, tick]);

  const reload = useCallback((refresh = false) => {
    // 强制刷新只作用于**这一次**:取数时会立刻复位,不会粘到后面每一次
    if (refresh) forceNext.current = true;
    setTick((t) => t + 1);
  }, []);
  return { state, reload };
}
