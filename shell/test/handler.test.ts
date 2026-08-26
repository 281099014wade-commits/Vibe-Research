import assert from "node:assert/strict";
import { test } from "node:test";

import { initialBootState, patchState } from "../src/boot.ts";
import { createShellHandler } from "../src/handler.ts";

function make(opts: { nonce?: () => string } = {}) {
  let state = initialBootState("测试产品");
  const innerCalls: string[] = [];
  const h = createShellHandler({
    state: () => state,
    inner: async (req) => {
      innerCalls.push(new URL(req.url).pathname);
      return new Response("inner", { status: 200 });
    },
    nonce: opts.nonce,
  });
  return { h, innerCalls, set: (s: typeof state) => { state = s; } , get: () => state };
}

test("/__shell/state 是 JSON 且绝不缓存（缓存住 = 进度永远停在第一帧）", async () => {
  const { h } = make();
  const res = await h(new Request("app://vibe/__shell/state"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  const body = await res.json() as { phase: string; revision: number };
  assert.equal(body.phase, "starting");
  assert.equal(typeof body.revision, "number");
});

test("state 每次都取最新的，不是启动时的快照", async () => {
  const { h, set, get } = make();
  set(patchState(get(), { phase: "failed" }));
  const body = await (await h(new Request("app://vibe/__shell/state"))).json() as { phase: string };
  assert.equal(body.phase, "failed");
});

test("🔴 CSP 里的 nonce 与 HTML 里的是同一个 —— 分两处各生成一次会永远对不上", async () => {
  const { h } = make();
  const res = await h(new Request("app://vibe/__shell/boot"));
  const csp = res.headers.get("content-security-policy") ?? "";
  const html = await res.text();
  const m = /'nonce-([^']+)'/.exec(csp);
  assert.ok(m, `CSP 里没有 nonce：${csp}`);
  assert.ok(html.includes(`nonce="${m![1]}"`), "HTML 里的 nonce 与 CSP 对不上");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("每次响应的 nonce 都不一样（固定 nonce 等于没有 nonce）", async () => {
  const { h } = make();
  const a = /'nonce-([^']+)'/.exec((await h(new Request("app://vibe/__shell/boot"))).headers.get("content-security-policy")!)![1];
  const b = /'nonce-([^']+)'/.exec((await h(new Request("app://vibe/__shell/boot"))).headers.get("content-security-policy")!)![1];
  assert.notEqual(a, b);
});

test("🔴 未知的 /__shell/* 到此为止，不回退给静态（否则界面目录里放个同名文件就能顶替真状态）", async () => {
  const { h, innerCalls } = make();
  for (const p of ["/__shell/whatever", "/__shell/", "/__shell/state/extra", "/__shell/state/%2e%2e/x", "/__shell/boot.html"]) {
    const res = await h(new Request(`app://vibe${p}`));
    assert.equal(res.status, 404, p);
  }
  assert.deepEqual(innerCalls, [], "外壳前缀下的请求不该落到 inner");
});

test("`..` 由 URL 解析吃掉：它变成一个普通静态请求，而不是外壳路由", async () => {
  const { h, innerCalls } = make();
  await h(new Request("app://vibe/__shell/state/../../index.html"));
  // 规范化之后 pathname 就是 /index.html —— 不再命中外壳前缀，也拿不到 state
  assert.deepEqual(innerCalls, ["/index.html"]);
});

test("非外壳路由原样交给 inner", async () => {
  const { h, innerCalls } = make();
  assert.equal(await (await h(new Request("app://vibe/api/health"))).text(), "inner");
  await h(new Request("app://vibe/assets/x.js"));
  assert.deepEqual(innerCalls, ["/api/health", "/assets/x.js"]);
});
