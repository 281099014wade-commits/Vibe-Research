import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { currentPlugin } from "../src/plugin.ts";
import { ServiceError, assertArgs, pageQuery, type ServiceContext } from "../src/service.ts";
import type { EndpointDef } from "../src/registry.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ctx = (): ServiceContext =>
  ({ repoRoot: REPO, dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-page-")), python: process.env.VRA_PYTHON ?? "python3", node: process.execPath, providerEnvKey: null }) as ServiceContext;

test("🔴 页面按名字要数据,端点 id 只活在垂类声明里(界面上不该印出端点名)", () => {
  const qs = currentPlugin().pageQueries ?? {};
  assert.ok(Object.keys(qs).length >= 3, "至少声明了几屏");
  for (const [name, def] of Object.entries(qs)) {
    assert.ok(def.title && def.intent, `${name} 要有标题与"在回答什么"`);
    assert.ok(def.blocks.length > 0, name);
    for (const b of def.blocks) {
      assert.match(b.id, /^[a-z][a-z0-9_]*$/, `${name}.${b.id} 块 id 要是稳定标识`);
      assert.ok(b.title, `${name}.${b.id} 要有给人看的标题`);
      assert.ok(b.endpoint, `${name}.${b.id} 要指明端点`);
    }
    // 块 id 在一屏内唯一 —— 撞了前端会拿错块
    const ids = def.blocks.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, `${name} 的块 id 有重复:${ids.join(",")}`);
  }
});

test("🔴 声明里引用的端点必须真的存在于注册表(否则整块永远 missing 且只有跑起来才知道)", () => {
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, "datasources", "registry.json"), "utf8")) as { endpoints: { id: string }[] };
  const known = new Set(reg.endpoints.map((e) => e.id));
  for (const [name, def] of Object.entries(currentPlugin().pageQueries ?? {})) {
    for (const b of def.blocks) assert.ok(known.has(b.endpoint), `${name}.${b.id} 引用了不存在的端点 ${b.endpoint}`);
  }
  const pc = currentPlugin().pageContext;
  if (pc) assert.ok(known.has(pc.endpoint), `pageContext 引用了不存在的端点 ${pc.endpoint}`);
});

test("🔴 上下文注入是**按块**的:不吃那个参数的端点不许被硬塞(第一版就是这么把一屏全弄 missing 的)", () => {
  // 🔴 用**代码真正用的那把尺子**(assertArgs),不要自己按注册表的 `args` 推 ——
  //    那个字段是**默认值**不是**允许集**(允许集还含 GLOBAL_ARG_KEYS)。
  //    我第一版就是拿默认值当允许集,于是测试报了一条根本不存在的错。同一个不变量只能有一种判法。
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, "datasources", "registry.json"), "utf8")) as { endpoints: EndpointDef[] };
  const byId = new Map(reg.endpoints.map((e) => [e.id, e]));
  const injectKeys = { date: "2026-08-25" }; // 与 FINANCE_PAGE_CONTEXT.resolve 的 inject 对齐
  for (const [name, def] of Object.entries(currentPlugin().pageQueries ?? {})) {
    for (const b of def.blocks) {
      if (!b.injectContext) continue;
      const ep = byId.get(b.endpoint);
      assert.ok(ep, `${name}.${b.id}:注册表里没有 ${b.endpoint}`);
      assert.doesNotThrow(
        () => assertArgs(ep, { ...(b.args ?? {}), ...injectKeys }),
        `${name}.${b.id} 声明了 injectContext,但 ${b.endpoint} 不接受注入的参数`,
      );
    }
  }
});

test("未知查询名当场报错,并列出可用的", async () => {
  await assert.rejects(
    () => pageQuery(ctx(), { query: "nosuch" }),
    (e: unknown) => e instanceof ServiceError && e.code === "unknown_query" && /可用:/.test(e.message),
  );
});
