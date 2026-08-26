/**
 * `app://` 的**总入口**：外壳自己的几条路由 → 其余交给 `proxy.ts`（静态 + API 转发）。
 *
 * 为什么要多这一层，而不是把启动页塞进 proxy：
 * proxy 是"界面与后端"的通道，它不该认识"外壳启动到哪一步了"。
 * 分开之后，启动页在**界面产物根本不存在**（安装不完整）时照样能显示 —— 那正是最需要它的时候。
 *
 * 🔴 `/__shell/` 整个前缀由这里吃掉，**不许落到静态**：否则谁往界面目录里放一个
 *    `__shell/state` 文件就能顶替掉真状态。未知的 `/__shell/*` 一律 404，不回退。
 * 🔴 启动页带 **nonce CSP**：页面里只有我们这一段内联脚本能跑。nonce 每次响应重新生成，
 *    与 HTML 里写的是同一个值 —— 分两处各生成一次就会永远对不上（页面静默不刷新）。
 */
import crypto from "node:crypto";

import { type BootState, bootHtml } from "./boot.ts";

export const SHELL_PREFIX = "/__shell/";

export interface ShellHandlerDeps {
  /** 取当前启动状态（**取值不是快照**：每次请求都要拿最新的）*/
  state: () => BootState;
  /** 非外壳路由的处理者：`proxy.createHandler(...)` */
  inner: (request: Request) => Promise<Response>;
  /** 生成 nonce；测试可注入确定值 */
  nonce?: () => string;
}

/** 启动页与状态都**绝不能被缓存**：缓存住 = 进度永远停在第一帧 */
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export function createShellHandler(deps: ShellHandlerDeps): (request: Request) => Promise<Response> {
  const nonce = deps.nonce ?? (() => crypto.randomBytes(16).toString("base64"));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(SHELL_PREFIX)) return deps.inner(request);

    const route = url.pathname.slice(SHELL_PREFIX.length);

    if (route === "state") {
      return new Response(JSON.stringify(deps.state()), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
      });
    }

    if (route === "boot") {
      const n = nonce();
      const html = bootHtml(deps.state(), n);
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // 只有带这个 nonce 的 script / style 能生效；页面不许连别处、不许被塞进 iframe
          "Content-Security-Policy":
            `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; ` +
            `connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          ...NO_STORE,
        },
      });
    }

    // 🔴 未知的 `/__shell/*` 到此为止 —— 不回退到静态（见文件头）
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  };
}
