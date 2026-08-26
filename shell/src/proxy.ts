/**
 * `app://` 协议处理器 —— 界面的静态文件 + 打到编排器的请求，都走这一个入口。
 *
 * ## 为什么不开第二个 HTTP 端口
 *
 * 开发期是 Vite 起一个端口伺候界面、在代理里补 Authorization。装机版照搬那套的话，
 * **本机任何一个进程都能打那个端口**，而代理会替它补上 token ——
 * 等于把用户自己记的那些私有数据向本机所有程序敞开。开发期可以忍，发行版不行。
 *
 * ⇒ 用 Electron 的自定义协议：只有本 App 的渲染进程能发起 `app://` 请求，
 *   没有端口、没有监听、别的进程够不着。
 *
 * ## 三条不能破的
 *
 * 🔴 **token 不进渲染进程**。它只存在于主进程闭包里，在这里补进请求头。
 * 🔴 **不转发渲染进程的请求头**。后端有跨站防护：Origin 必须是回环、
 *    `Sec-Fetch-Site` 必须是 same-origin/none。而 `app://vibe` 这个 Origin 两条都不满足 ——
 *    照搬渲染进程的头会被后端 403，报出来是「forbidden_origin」这种摸不着头脑的错。
 *    ⇒ 这里**重新构造**一组干净的头，只带该带的。
 * 🔴 **静态文件不许越出界面目录**。拼路径后要确认结果仍在目录之内，防 `../` 读到别的东西。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 扩展名 → Content-Type。**列举而不是猜** —— 猜错会让浏览器拒绝执行脚本，而且不报错 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * 界面页面的 CSP。
 *
 * 🔴 这个窗口里渲染的是**互联网上的文本**（头条标题、论坛帖子）。渲染进程一旦被注入脚本，
 *    它就在一个"打 `app://vibe/api/*` 会被自动补上 token"的源里跑 —— 用户的私有台账、
 *    研究产物全在射程内。没有 preload 桥不等于没有暴露面。
 * 🔴 Electron 自己会对"没有 CSP"发警告，但那句警告**打包后就不显示了** ——
 *    正好在发行版里消失。所以由我们自己在响应头上给死。
 *
 * `script-src` 用**内联脚本的 sha256**而不是 `'unsafe-inline'`：
 * 产物里的内联脚本只有首帧主题那一段（构建产出，我们认得），把它按内容放行，
 * 别的内联脚本一律不许跑。
 * ⚠️ 万一哈希对不上，后果是那段脚本不执行（主题回落到 HTML 上写死的默认值），
 *    **不是白屏** —— 这是刻意选的失败方向。
 *
 * `style-src` 只能留 `'unsafe-inline'`：图表库与提示条运行时会写行内样式，
 * 这一条收不掉；而样式注入的危害远小于脚本注入。
 */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    // ⚠️ `\bsrc=` 会把 `data-src=` / `ng-src=` 也算成外链（`-` 是非单词字符，词边界照样成立），
    //    于是那种**其实是内联**的脚本不会被算哈希 —— 表现是它被 CSP 静默拦掉。
    //    ⇒ 要求 src 是独立的属性名。
    if (/(^|[\s/])src\s*=/i.test(m[1] ?? "")) continue;  // 外链脚本由 'self' 覆盖
    const body = m[2] ?? "";
    if (!body.trim()) continue;
    out.push(`'sha256-${crypto.createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return out;
}

export function htmlCsp(html: string): string {
  const scripts = ["'self'", ...inlineScriptHashes(html)].join(" ");
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface ProxyDeps {
  /** 取编排器的地址与 token；启动完成前返回 null */
  backend: () => { port: number; token: string } | null;
  uiDir: string;
  fetch: typeof globalThis.fetch;
  readFile: (p: string) => Promise<Buffer>;
  exists: (p: string) => boolean;
  isFile: (p: string) => boolean;
}

/**
 * 把 `app://vibe/...` 的 pathname 映射到界面目录里的真实文件。
 *
 * 找不到时回退 `index.html`（单页应用的深链接靠它），**但只在没有扩展名时** ——
 * 有扩展名却找不到是真 404；回退 index.html 会让浏览器把 HTML 当 JS 解析，
 * 报出来是一句莫名其妙的语法错，真正的「文件没打进包」被盖住了。
 */
export function resolveStatic(
  uiDir: string,
  pathname: string,
  exists: (p: string) => boolean,
  isFile: (p: string) => boolean,
): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // 非法百分号编码
  }
  rel = rel.replace(/^\/+/, "");
  const root = path.resolve(uiDir);
  const target = path.resolve(root, rel || "index.html");
  // 🔴 越界检查：`path.resolve` 会把 `../` 算进去，必须确认结果仍在 uiDir 之内
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(withSep)) return null;
  if (exists(target) && isFile(target)) return target;
  if (path.extname(target)) return null;
  const index = path.join(root, "index.html");
  // ⚠️ 也要 `isFile`：损坏的安装里 index.html 可能是个目录或 FIFO，
  //    只查存在会让"首页 404、深链接却卡住"，把真正的原因盖掉。
  return exists(index) && isFile(index) ? index : null;
}

export function createHandler(deps: ProxyDeps) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const be = deps.backend();
      if (!be) return json(503, { error: "backend_starting", message: "本机服务还在启动，稍等一下再试" });

      const rest = url.pathname.slice("/api".length) || "/";
      const target = `http://127.0.0.1:${be.port}${rest}${url.search}`;

      // 🔴 只带该带的头。渲染进程的 Origin / Sec-Fetch-* 一律不转发（见文件头说明）
      const headers: Record<string, string> = {
        Authorization: `Bearer ${be.token}`,
        Accept: request.headers.get("accept") ?? "application/json",
      };
      const ct = request.headers.get("content-type");
      if (ct) headers["Content-Type"] = ct;

      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      let body: ArrayBuffer | undefined;
      if (hasBody) {
        const read = await readBounded(request, MAX_PROXY_BODY);
        if (read === null) return json(413, { error: "body_too_large", message: `请求体超过 ${MAX_PROXY_BODY / 1024 / 1024} MB` });
        body = read;
      }
      try {
        // 🔴 `redirect: "manual"`：默认会**跟着 Location 走**，而那是响应说了算的地址。
        //    我们只想打本机那一个端口，不想让一个响应头把主进程支使到别处去。
        const res = await deps.fetch(target, { method: request.method, headers, redirect: "manual", ...(body ? { body } : {}) });
        // ⚠️ 只有**带 Location** 的 3xx 才是跳转。304 之类合法地不带 Location，
        //    一律当跳转处理会把它报成"本机服务跳转异常"，把真相盖掉。
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) return relocate(res);
        // 状态码与正文原样回传：界面靠状态码分辨"没数据"和"没接上"
        return new Response(res.body, { status: res.status, headers: responseHeaders(res) });
      } catch (e) {
        // 连不上要说成"连不上",不能让界面把它读成"没有数据"
        return json(502, {
          error: "api_unreachable",
          message: `连不到本机服务：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    const file = resolveStatic(deps.uiDir, url.pathname, deps.exists, deps.isFile);
    if (!file) return new Response("Not Found", { status: 404 });
    let buf: Buffer;
    try {
      buf = await deps.readFile(file);
    } catch (e) {
      // 🔴 抛出去 = 协议请求以网络错误告终，窗口停在空白页上，真正原因（文件读不出来）没人看得到。
      //    换成一个带正文的 500：至少这句话会显示在窗口里。
      return new Response(
        `界面文件读不出来：${file}\n${e instanceof Error ? e.message : String(e)}\n安装可能不完整，重装一次。`,
        { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type };
    if (type.startsWith("text/html")) {
      // 🔴 CSP 只加在 HTML 上：它是唯一会执行脚本的响应。
      //    顺带 no-store —— 入口页被缓存住的话，升级之后仍会去要上一版的 assets 文件名。
      headers["Content-Security-Policy"] = htmlCsp(buf.toString("utf8"));
      headers["Cache-Control"] = "no-store";
    }
    return new Response(new Uint8Array(buf), { status: 200, headers });
  };
}


/**
 * 转发给后端的请求体上限。**后端自己每条路由另有更严的上限**（默认 256KB，导入那条约 28MB），
 * 这里只负责"别让主进程先被撑爆" —— 资源消耗发生在请求到后端之前，后端的上限管不着。
 */
export const MAX_PROXY_BODY = 32 * 1024 * 1024;

/**
 * **所有**在途请求体加起来的上限。
 * 🔴 只限单个请求挡不住"同时发很多个"：每个都停在 32 MB 差一点、都不结束，内存照样无上限涨。
 *    单请求上限管的是一条，这个管的是总量。
 */
export const MAX_INFLIGHT_BODY = 64 * 1024 * 1024;
let inFlightBytes = 0;

/** 只给测试看的：断言"读完之后额度确实还回去了" */
export const inFlightBodyBytes = (): number => inFlightBytes;

/** 边读边数，超了就**不再攒**并返回 null（调用方回 413）。整段读进内存再判断等于没判断。 */
export async function readBounded(request: Request, max: number, maxInFlight = MAX_INFLIGHT_BODY): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;   // 声明了就先按声明拒，省得白读
  const stream = request.body;
  if (!stream) return request.arrayBuffer();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let charged = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      inFlightBytes += value.byteLength;
      charged += value.byteLength;
      if (n > max || inFlightBytes > maxInFlight) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    // 🔴 额度必须**无论怎么退出都还回去**（读完 / 超限 / 抛错）。漏还一次，
    //    这个进程从此就少一块额度，而且再也长不回来 —— 那种泄漏只会越用越明显。
    inFlightBytes -= charged;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

/**
 * 后端响应里**必须带回来**的头。
 *
 * 🔴 原来只复制 `Content-Type`，等于把后端自己设的 CSP 全丢了 ——
 *    后端有几条会返回 HTML 的路由（运行列表页、证据查看器），它给那些页面配了很严的 CSP，
 *    而经过这一层之后 CSP 没了、页面却仍然跑在 `app://vibe` 这个"请求会被自动补 token"的源上。
 */
const FORWARD_RESPONSE_HEADERS = ["content-security-policy", "x-content-type-options", "referrer-policy", "cache-control"];

/** 后端没给 CSP 而它又返回了 HTML 时的兜底：什么都不许，连脚本带表单 */
const LOCKED_DOWN_HTML_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

export function responseHeaders(res: { status: number; headers: Headers }): Record<string, string> {
  const type = res.headers.get("content-type") ?? "application/json; charset=utf-8";
  const out: Record<string, string> = { "Content-Type": type };
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  if (type.toLowerCase().startsWith("text/html") && !out["content-security-policy"]) {
    out["content-security-policy"] = LOCKED_DOWN_HTML_CSP;
  }
  return out;
}

/**
 * 处理后端的重定向。只认**站内相对路径**，并把它搬回 `/api` 前缀下；
 * 绝对地址（含 `//host`）一律不放行 —— 那会把窗口带出这个应用。
 */
export function relocate(res: { status: number; headers: Headers }): Response {
  const loc = res.headers.get("location") ?? "";
  if (!loc.startsWith("/") || loc.startsWith("//")) {
    return json(502, { error: "bad_redirect", message: `本机服务要求跳转到一个不受支持的地址：${loc.slice(0, 120)}` });
  }
  return new Response(null, { status: res.status, headers: { Location: `/api${loc}`, "Cache-Control": "no-store" } });
}

export const realFsDeps = {
  readFile: (p: string) => fs.promises.readFile(p),
  exists: (p: string) => fs.existsSync(p),
  isFile: (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
