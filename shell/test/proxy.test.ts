import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createHandler, htmlCsp, inlineScriptHashes, resolveStatic } from "../src/proxy.ts";

const UI = "/ui";
const has = (...files: string[]) => (p: string) => files.includes(p);

test("🔴 静态文件不许越出界面目录", () => {
  const exists = has(path.join(UI, "index.html"), "/etc/passwd");
  assert.equal(resolveStatic(UI, "/../etc/passwd", exists, () => true), null);
  assert.equal(resolveStatic(UI, "/%2e%2e/etc/passwd", exists, () => true), null);
  // `/ui-other/x` 不在 `/ui/` 之内 —— 前缀比较必须带分隔符
  assert.equal(resolveStatic(UI, "/../ui-other/x.js", has("/ui-other/x.js"), () => true), null);
});

test("单页深链接回退 index.html —— 但只在没有扩展名时", () => {
  const exists = has(path.join(UI, "index.html"));
  assert.equal(resolveStatic(UI, "/daily-review", exists, () => true), path.join(UI, "index.html"));
  // 有扩展名却找不到 = 真 404。回退会让浏览器把 HTML 当 JS 解析，报一句语法错把真原因盖住
  assert.equal(resolveStatic(UI, "/assets/missing.js", exists, () => true), null);
});

test("非法百分号编码不当成路径", () => {
  assert.equal(resolveStatic(UI, "/%zz", () => true, () => true), null);
});

test("🔴 内联脚本按 sha256 放行，外链脚本不参与（由 'self' 覆盖）", () => {
  const html = `<script>var a=1</script><script src="/assets/x.js"></script><script>  </script>`;
  const hs = inlineScriptHashes(html);
  assert.equal(hs.length, 1, `应当只有一个内联脚本哈希：${hs.join(",")}`);
  assert.match(hs[0]!, /^'sha256-[A-Za-z0-9+/]+=*'$/);
});

test("CSP 关掉一切默认来源，且不含 unsafe-inline 的脚本放行", () => {
  const csp = htmlCsp(`<script>var a=1</script>`);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), `script-src 不该放行 unsafe-inline：${csp}`);
  assert.ok(!/unsafe-eval/.test(csp));
});

test("HTML 才带 CSP；JS/CSS 不带（带了没用，只是噪音）", async () => {
  const files: Record<string, string> = {
    [path.join(UI, "index.html")]: "<html><script>var a=1</script></html>",
    [path.join(UI, "a.js")]: "console.log(1)",
  };
  const h = createHandler({
    backend: () => null,
    uiDir: UI,
    fetch: (async () => new Response("")) as unknown as typeof globalThis.fetch,
    readFile: async (p) => Buffer.from(files[p] ?? "", "utf8"),
    exists: (p) => p in files,
    isFile: (p) => p in files,
  });
  const html = await h(new Request("app://vibe/index.html"));
  assert.ok(html.headers.get("content-security-policy"), "HTML 必须带 CSP");
  assert.match(html.headers.get("cache-control") ?? "", /no-store/);
  const js = await h(new Request("app://vibe/a.js"));
  assert.equal(js.headers.get("content-security-policy"), null);
});

test("后端还没起来时 /api 回 503，而不是让界面读成\"没有数据\"", async () => {
  const h = createHandler({
    backend: () => null,
    uiDir: UI,
    fetch: (async () => new Response("")) as unknown as typeof globalThis.fetch,
    readFile: async () => Buffer.from(""),
    exists: () => false,
    isFile: () => false,
  });
  const res = await h(new Request("app://vibe/api/health"));
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { error: string }).error, "backend_starting");
});

test("🔴 转发给后端时不带渲染进程的 Origin / Sec-Fetch-*（后端跨站防护会 403）", async () => {
  let seen: Record<string, string> = {};
  const h = createHandler({
    backend: () => ({ port: 1234, token: "T" }),
    uiDir: UI,
    fetch: (async (_u: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch,
    readFile: async () => Buffer.from(""),
    exists: () => false,
    isFile: () => false,
  });
  await h(new Request("app://vibe/api/fetch", {
    method: "POST",
    headers: { origin: "app://vibe", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(seen.Authorization, "Bearer T");
  const keys = Object.keys(seen).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("origin"), `不该转发 origin：${keys.join(",")}`);
  assert.ok(!keys.includes("sec-fetch-site"));
});

// ── Codex shell-r2 修复项 ────────────────────────────────────────────
import { MAX_PROXY_BODY, readBounded, relocate, responseHeaders } from "../src/proxy.ts";

test("🔴 后端自己设的 CSP 必须带回来 —— 丢掉它，后端返回的 HTML 就在 app:// 源上裸奔", () => {
  const h = new Headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff" });
  const out = responseHeaders({ status: 200, headers: h });
  assert.equal(out["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(out["x-content-type-options"], "nosniff");
});

test("后端返回 HTML 却没给 CSP → 兜一个最严的（而不是放行）", () => {
  const out = responseHeaders({ status: 200, headers: new Headers({ "content-type": "text/html" }) });
  assert.match(out["content-security-policy"] ?? "", /default-src 'none'/);
  assert.match(out["content-security-policy"] ?? "", /sandbox/);
});

test("JSON 响应不硬塞 CSP（塞了没用，只是噪音）", () => {
  const out = responseHeaders({ status: 200, headers: new Headers({ "content-type": "application/json" }) });
  assert.equal(out["content-security-policy"], undefined);
});

test("🔴 重定向只认站内相对路径，绝对地址一律拒（否则一个响应头就能把窗口带出应用）", () => {
  const ok = relocate({ status: 302, headers: new Headers({ location: "/ui" }) });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/api/ui");
  for (const bad of ["https://evil.example/x", "//evil.example/x", "ui", ""]) {
    const r = relocate({ status: 302, headers: new Headers(bad ? { location: bad } : {}) });
    assert.equal(r.status, 502, bad);
  }
});

test("🔴 请求体有上限，且是**边读边数**（整段读进来再判断等于没判断）", async () => {
  const big = new Uint8Array(64);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { pulled += 1; c.enqueue(big); if (pulled > 1000) c.close(); },
  });
  const req = new Request("app://vibe/api/x", { method: "POST", body: stream, duplex: "half" } as RequestInit & { duplex: string });
  assert.equal(await readBounded(req, 100), null, "超限应当返回 null");
  assert.ok(pulled < 100, `应当很快就停下，实际拉了 ${pulled} 次`);
});

test("声明的 content-length 超限就直接拒，不白读一遍", async () => {
  const req = new Request("app://vibe/api/x", { method: "POST", body: "x", headers: { "content-length": String(MAX_PROXY_BODY + 1) } });
  assert.equal(await readBounded(req, MAX_PROXY_BODY), null);
});

test("没超限的体原样读回来", async () => {
  const req = new Request("app://vibe/api/x", { method: "POST", body: '{"a":1}' });
  const buf = await readBounded(req, MAX_PROXY_BODY);
  assert.equal(Buffer.from(buf!).toString("utf8"), '{"a":1}');
});

test("🔴 界面文件读不出来 → 带正文的 500，而不是让协议请求以网络错误告终", async () => {
  const h = createHandler({
    backend: () => null,
    uiDir: UI,
    fetch: (async () => new Response("")) as unknown as typeof globalThis.fetch,
    readFile: async () => { throw new Error("EIO: 磁盘炸了"); },
    exists: () => true,
    isFile: () => true,
  });
  const res = await h(new Request("app://vibe/index.html"));
  assert.equal(res.status, 500);
  assert.match(await res.text(), /读不出来[\s\S]*EIO/);
});

test("SPA 回退也要求 index.html 是普通文件（损坏安装里它可能是个目录）", () => {
  const exists = has(path.join(UI, "index.html"));
  assert.equal(resolveStatic(UI, "/deep-link", exists, () => false), null);
  assert.equal(resolveStatic(UI, "/deep-link", exists, () => true), path.join(UI, "index.html"));
});

import { MAX_INFLIGHT_BODY, inFlightBodyBytes } from "../src/proxy.ts";

test("🔴 外链判定要求 src 是独立属性名 —— `data-src` 不是外链，它其实是内联脚本", () => {
  assert.equal(inlineScriptHashes(`<script src="/a.js"></script>`).length, 0);
  assert.equal(inlineScriptHashes(`<script data-src="theme">var a=1</script>`).length, 1);
  assert.equal(inlineScriptHashes(`<script ng-src="x">var a=1</script>`).length, 1);
  assert.equal(inlineScriptHashes(`<script type="module" src="/a.js"></script>`).length, 0);
});

test("🔴 额度用完要还回去（漏还一次，这个进程就少一块，且再也长不回来）", async () => {
  assert.equal(inFlightBodyBytes(), 0);
  await readBounded(new Request("app://vibe/api/x", { method: "POST", body: "hello" }), 1024);
  assert.equal(inFlightBodyBytes(), 0, "读完之后额度没还");
  // 超限那条路径也要还
  const big = new Uint8Array(1024);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(big); } });
  await readBounded(new Request("app://vibe/api/x", { method: "POST", body: stream, duplex: "half" } as RequestInit & { duplex: string }), 100);
  assert.equal(inFlightBodyBytes(), 0, "超限退出之后额度没还");
});

test("总量上限存在且大于单请求上限（否则单请求上限就没意义了）", () => {
  assert.ok(MAX_INFLIGHT_BODY > MAX_PROXY_BODY);
});

test("🔴 不带 Location 的 3xx（如 304）原样透传，不许报成\"跳转异常\"", async () => {
  const h = createHandler({
    backend: () => ({ port: 1, token: "T" }),
    uiDir: UI,
    fetch: (async () => new Response(null, { status: 304, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch,
    readFile: async () => Buffer.from(""),
    exists: () => false,
    isFile: () => false,
  });
  const res = await h(new Request("app://vibe/api/x"));
  assert.equal(res.status, 304);
});

test("🔴 总量上限真的生效：两条并发请求各自没超单条上限，加起来超了 → 后来的那条被拒", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let cA!: ReadableStreamDefaultController<Uint8Array>;
  let cB!: ReadableStreamDefaultController<Uint8Array>;
  const mk = (assign: (c: ReadableStreamDefaultController<Uint8Array>) => void) =>
    new ReadableStream<Uint8Array>({ start: assign });
  const req = (s: ReadableStream<Uint8Array>) =>
    new Request("app://vibe/api/x", { method: "POST", body: s, duplex: "half" } as RequestInit & { duplex: string });

  const pA = readBounded(req(mk((c) => { cA = c; })), 1000, 100);
  cA.enqueue(new Uint8Array(60));            // 在途 60
  await tick();
  const pB = readBounded(req(mk((c) => { cB = c; })), 1000, 100);
  cB.enqueue(new Uint8Array(60));            // 在途 120 > 100
  // ⚠️ 不直接 await：没有总量上限时 pB 永远不 settle，测试会**挂住**而不是报错 ——
  //    挂住的红看不出是哪条断言，也会拖死整个套件。
  const b = await Promise.race([pB, new Promise((r) => setTimeout(() => r("没有返回"), 500))]);
  assert.equal(b, null, "第二条应当因总量超限被拒");
  // ⚠️ 不要再动 cB：readBounded 已经 cancel 过它的 reader，再 close 会抛 "Invalid state"
  cA.close();
  assert.ok(await pA, "第一条不该被牵连");
  assert.equal(inFlightBodyBytes(), 0, "两条都退出之后额度要归零");
});
