import { api, type PageBlock, type PageResult } from "./api";
import { useAsync } from "./useAsync";

/**
 * 取一屏数据。
 *
 * 🔴 页面只说自己要哪个查询,**不认识任何物理端点** ——
 *    端点 id、参数、分页上限全在后端的垂类声明里。所以:
 *    ① 界面上不会再印出 `em_limit_up_sentiment` 这种东西;
 *    ② 端点改名 / 换源不用动前端;
 *    ③ 一屏之内的块彼此有了共同上下文(在回答什么问题、看的是哪一天)。
 */
export function usePage(query: string, opts?: { symbol?: string; blockArgs?: Record<string, Record<string, unknown>> }) {
  const symbol = opts?.symbol;
  const blockArgs = opts?.blockArgs;
  // 🔴 依赖用**序列化后的值**而不是对象本身:调用方多半是内联字面量,
  //    每次渲染都是新对象引用 —— 拿引用当依赖会无限重取。
  const key = blockArgs ? JSON.stringify(blockArgs) : "";
  const r = useAsync<PageResult>(
    (refresh) => api.page(query, { ...(symbol ? { symbol } : {}), refresh, ...(blockArgs ? { blockArgs } : {}) }),
    [query, symbol, key],
  );
  return r;
}

/** 按块 id 取那一块。取不到时返回 undefined —— 调用方要显式处理,不许当成空数据 */
export function block(page: PageResult | null, id: string): PageBlock | undefined {
  return page?.blocks.find((b) => b.id === id);
}
