import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "desktop", "src");
const FINANCE = path.join(SRC, "verticals", "finance");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p);

/**
 * 前端的 Core / 垂类边界。
 *
 * 🔴 **2026-08-26 界面整套换成开源版 Vibe-Research 之后,前端的形状变了**:
 *    整套 UI(外壳 / 导航 / 组件 / 页面)都在 `verticals/finance/` 里,
 *    Core 只剩 `src/` 顶层那几个文件(组装根 + 全局样式)。
 *    ⇒ 断言必须跟着改。旧版查的是 `src/core/` 与 `lib/nav.ts`,那两样**已经不存在**,
 *      而 `walk()` 对不存在的目录返回空数组 ⇒ 前三条会**全绿地什么都没查**。
 *      (第四条读文件才炸出来 —— 否则这条棘轮会静默失效,那正是它最该防的事。)
 */

const coreFiles = () =>
  walk(SRC).filter((f) => !rel(f).startsWith("verticals" + path.sep));

test("🔴 Core UI 确实存在 —— 目录改名 / 搬走时,后面几条不许静默变成空查", () => {
  const files = coreFiles().map(rel);
  assert.ok(files.includes("main.tsx"), `没找到组装根 main.tsx,现有 Core 文件:${files.join(", ")}`);
  assert.ok(fs.existsSync(FINANCE), "垂类目录 verticals/finance 不在了");
  assert.ok(walk(FINANCE).length > 20, `垂类文件太少(${walk(FINANCE).length}),路径大概不对`);
});

test("🔴 只有组装根可以 import 垂类 —— 别处 import 等于绕开注册点", () => {
  const roots = new Set(["main.tsx"]);
  const bad: string[] = [];
  for (const f of coreFiles()) {
    const r = rel(f);
    if (roots.has(r)) continue;
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/from\s+"([^"]+)"/g)) {
      if (/verticals\//.test(m[1]!)) bad.push(`${r} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `只有 main.tsx 能接垂类:\n  ${bad.join("\n  ")}`);
});

test("Core UI 里不许出现行业词(它换个行业要能原样搬走)", () => {
  // ⚠️ 收词优先收完整术语;"证伪 / 目标"这类二字词会命中普通中文,反而制造噪音。
  const WORDS = ["持仓", "涨停", "复盘", "板块", "行情", "标的", "estimates", "valuation",
    "成本", "建仓", "仓位", "裁决点", "证伪条件", "开盘", "收盘", "换手", "账户", "论点", "股票"];
  const hits: string[] = [];
  for (const f of coreFiles()) {
    const s = fs.readFileSync(f, "utf8");
    for (const w of WORDS) if (s.includes(w)) hits.push(`${rel(f)}:${w}`);
  }
  assert.deepEqual(hits, [], `Core UI 出现行业词:\n  ${hits.join("\n  ")}`);
});

test("导航与路由双向对得上 —— 有导航没路由=点了白屏,有路由没导航=永远点不到", () => {
  // ⚠️ 不动态 import .tsx —— Node 的测试跑不了 JSX。按文本解析同样能双向查。
  const routerSrc = fs.readFileSync(path.join(FINANCE, "router.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");

  const routes = [...routerSrc.matchAll(/\{\s*path:\s*"([^"]+)"/g)].map((m) => m[1]!);
  const navTos = [...layoutSrc.matchAll(/\bto:\s*"(\/[^"]*)"/g)].map((m) => m[1]!);
  assert.ok(routes.length >= 10 && navTos.length >= 10,
    `解析出来太少,正则可能失效:routes=${routes.length} nav=${navTos.length}`);

  // 参数路由(`/sectors/:key`)覆盖它的静态前缀 —— 导航里的子项走的就是这条
  const staticRoutes = routes.filter((p) => !p.includes(":"));
  const paramPrefixes = routes.filter((p) => p.includes(":")).map((p) => p.slice(0, p.indexOf("/:")));
  const reachable = (to: string) =>
    staticRoutes.includes(to) || paramPrefixes.some((pre) => to.startsWith(pre + "/"));

  assert.deepEqual(navTos.filter((t) => !reachable(t)), [], "有导航项没有对应路由(点了白屏)");

  // 反向:每条静态路由要么在导航里,要么是重定向根 `/`
  const orphan = staticRoutes.filter((p) => p !== "/" && !navTos.includes(p));
  assert.deepEqual(orphan, [], "有路由不在导航里(永远点不到)");

  // 参数路由的静态父路径必须真的存在,否则它谁也点不到
  assert.deepEqual(paramPrefixes.filter((p) => p !== "" && !staticRoutes.includes(p)), [],
    "参数路由的静态父路径要有页面");
});
