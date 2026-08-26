/**
 * 导航策略 —— **界面里有大量外部链接，而那些链接不是我们写的。**
 *
 * 头条、市场声音这些卡片上的 URL 来自互联网。如果它们能把**应用窗口本身**导航走，
 * 那个页面就在一个"能打 `app://vibe/api/*`"的窗口里跑起来了 ——
 * 跨源 fetch 会被拦住，但用户已经失去了应用（回不去，界面状态全没）。
 *
 * ⇒ 三分：本应用的页面**允许**；http/https **交给系统浏览器**；其余一律**挡掉**。
 *
 * 🔴 只有 http/https 能进 `shell.openExternal`。别的 scheme 交出去等于让页面上的一串文本
 *    去调用本机的任意协议处理器（`file:` 打开访达、自定义 scheme 唤起别的 App）。
 *    白名单，不是黑名单。
 * 🔴 **不能用 `URL.origin` 判同源**：`app:` 不是"特殊协议"，Node 的 WHATWG URL 对它
 *    一律返回字符串 `"null"` —— `evil://x` 也是 `"null"`。照 origin 比，要么把自己挡了
 *    （值不相等），要么把所有自定义协议放行（都等于 "null"）。⇒ 逐字段比 protocol + host。
 */

export type NavDecision =
  | { action: "allow" }
  | { action: "external"; url: string }
  | { action: "block"; reason: string };

/** 允许交给系统浏览器的协议。**只有这两个。** */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export interface AppOrigin {
  /** 不带冒号，如 `app` */
  scheme: string;
  /** 主机名，如 `vibe` */
  host: string;
}

/**
 * @param target 目标 URL（`will-navigate` 的 url / `setWindowOpenHandler` 的 details.url）
 * @param self   本应用的协议与主机
 */
export function decideNavigation(target: string, self: AppOrigin): NavDecision {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return { action: "block", reason: `不是合法 URL：${clip(target)}` };
  }

  // 🔴 host 要**全等**，不是 startsWith：`app://vibe.evil/` 也以 `vibe` 开头。
  //    URL 解析已经把 host 规范化成小写，这里不再另做处理。
  if (u.protocol === `${self.scheme}:` && u.host === self.host) return { action: "allow" };

  if (EXTERNAL_PROTOCOLS.has(u.protocol)) return { action: "external", url: u.toString() };

  return { action: "block", reason: `不允许的目标：${clip(target)}` };
}

function clip(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
