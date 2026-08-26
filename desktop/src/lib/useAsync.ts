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
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ phase: "idle" });
  const [tick, setTick] = useState(0);
  // 竞态:切页 / 连点刷新会有多个请求在飞,晚发的先回时不能被早发的覆盖
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const mine = ++seq.current;
    let alive = true;
    setState({ phase: "loading" });
    fnRef
      .current()
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

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { state, reload };
}
