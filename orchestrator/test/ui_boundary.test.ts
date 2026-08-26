import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "desktop", "src");

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
 * 🔴 与后端的纯净度棘轮同一个道理:**光靠"我记得别这么写"守不住**。
 *    后端那条抓到过 32 处结构性耦合,而人眼看代码时它们全都"看着很正常"。
 */
test("🔴 Core UI 不许 import 垂类 —— 依赖方向单向:垂类 → Core,永不反向", () => {
  const bad: string[] = [];
  for (const f of walk(path.join(SRC, "core"))) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/from\s+"([^"]+)"/g)) {
      if (/verticals\//.test(m[1]!)) bad.push(`${rel(f)} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `Core 里出现了对垂类的 import(换个行业就搬不动了):\n  ${bad.join("\n  ")}`);
});

test("🔴 只有组装根可以 import 垂类 —— 别处 import 等于绕开注册点", () => {
  const roots = new Set(["main.tsx"]);
  const bad: string[] = [];
  for (const f of walk(SRC)) {
    const r = rel(f);
    if (roots.has(r) || r.startsWith("verticals/")) continue;
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/from\s+"([^"]+)"/g)) {
      if (/verticals\//.test(m[1]!)) bad.push(`${r} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `只有 main.tsx 能接垂类:\n  ${bad.join("\n  ")}`);
});

test("Core UI 里不许出现行业词(它换个行业要能原样搬走)", () => {
  // 与后端棘轮同一批词的子集;只查 Core,垂类里出现金融词是**正常**的
  // ⚠️ 与后端棘轮同步扩过一次(2026-08-26):Core 的表单组件里曾写死 cost=成本 /
  //    decision_point=裁决点 一整张表,而当时的词表**一个都没收录** —— 棘轮全绿。
  //    收词优先收完整术语;"证伪 / 目标"这类二字词会命中普通中文,反而制造噪音。
  const WORDS = ["持仓", "涨停", "复盘", "板块", "行情", "标的", "estimates", "valuation",
    "成本", "建仓", "仓位", "裁决点", "证伪条件", "开盘", "收盘", "换手", "账户", "论点", "股票"];
  const hits: string[] = [];
  for (const f of walk(path.join(SRC, "core"))) {
    const s = fs.readFileSync(f, "utf8");
    for (const w of WORDS) if (s.includes(w)) hits.push(`${rel(f)}:${w}`);
  }
  assert.deepEqual(hits, [], `Core UI 出现行业词:\n  ${hits.join("\n  ")}`);
});

test("垂类 UI 声明与页面表双向对得上(注册期会炸,这里提前到测试)", () => {
  // ⚠️ 不动态 import .tsx —— Node 的测试跑不了 JSX。按文本解析同样能双向查,
  //    而且不依赖前端构建链(测试不该因为前端工具链变动而红)。
  const src = fs.readFileSync(path.join(SRC, "verticals", "finance", "lib", "nav.ts"), "utf8");
  const navPaths = [...src.matchAll(/\{\s*path:\s*"([^"]+)"/g)].map((m) => m[1]!);
  const pagesBlock = src.slice(src.indexOf("pages: {"));
  const pagePaths = [...pagesBlock.matchAll(/"(\/[a-z0-9/_-]*)":/g)].map((m) => m[1]!);
  assert.ok(navPaths.length >= 5 && pagePaths.length >= 5, `解析出来太少,正则可能失效:nav=${navPaths.length} pages=${pagePaths.length}`);
  assert.deepEqual(navPaths.filter((p) => !pagePaths.includes(p)), [], "有导航项没有对应页面(点了白屏)");
  assert.deepEqual(pagePaths.filter((p) => !navPaths.includes(p)), [], "有页面不在导航里(永远点不到)");
  const def = /defaultPath:\s*"([^"]+)"/.exec(src)?.[1];
  assert.ok(def && pagePaths.includes(def), `默认路径 ${def} 要有页面`);

  // 🔴 详情路由(`/sectors/:key` 这类)**故意不进导航**,所以上面那条"孤儿页"校验不该管它们。
  //    它们之所以没被 pagePaths 的正则捞进来,是因为 `detailRoutes` 声明在 `pages: {` 之前 ——
  //    **这是个巧合式的豁免**,把它写成显式断言:一旦有人把 detailRoutes 挪到 pages 之后,
  //    这里会先红,而不是让"孤儿页"那条给出一个看不懂的报错。
  const detailBlock = /detailRoutes:\s*\{([^}]*)\}/.exec(src)?.[1] ?? "";
  const detailPaths = [...detailBlock.matchAll(/"([^"]+)":/g)].map((m) => m[1]!);
  assert.ok(src.indexOf("detailRoutes:") < src.indexOf("pages: {"), "detailRoutes 要声明在 pages 之前(上面的 pagePaths 正则是从 pages 处开始切的)");
  assert.deepEqual(detailPaths.filter((p) => !p.includes(":")), [], "detailRoutes 里的路径必须带参数段 —— 不带的说明它该进导航");
  assert.deepEqual(detailPaths.filter((p) => navPaths.includes(p)), [], "同一路径不能既在导航又在 detailRoutes");
  // 静态父路径必须存在 —— 只查"带参数段"挡不住 `/nowhere/:id` 这种照样点不到的孤儿(审计 pages-r1-P3)
  assert.deepEqual(
    detailPaths.filter((p) => !pagePaths.includes(p.slice(0, p.indexOf("/:")))),
    [],
    "detailRoutes 的静态父路径要在 pages 里,否则它谁也点不到",
  );
});
