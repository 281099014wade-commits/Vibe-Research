import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { APP_DIRS, APP_DIRS_EXCLUDED } from "../scripts/assemble.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 装机版载荷的两条对账。
 *
 * 🔴 起因是真漏过一次：`backtest/` 2026-08-26 加进仓库，装配脚本的清单没人改，
 *    打出来的 App 里就是没有它 —— 而**打包全程零报错、验证也过**，
 *    装机后点开回测页才会炸（后端把 `backtest.cli` 当 Python 模块跑）。
 *    清单法只挡得住"列了但缺"，挡不住"压根没列"。
 */

/** 仓库顶层的源码目录（跳过隐藏目录与构建产物） */
function topLevelDirs(): string[] {
  const skip = new Set(["node_modules", "dist", "release", "payload", "__pycache__"]);
  return fs
    .readdirSync(REPO, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !skip.has(e.name))
    .map((e) => e.name)
    .sort();
}

test("🔴 前提：真的读到了仓库顶层目录 —— 路径算错时不许静默变成空查", () => {
  const dirs = topLevelDirs();
  assert.ok(dirs.length >= 6, `只读到 ${dirs.length} 个顶层目录（${dirs.join(",")}），路径大概不对`);
  for (const must of ["calc", "orchestrator", "desktop", "shell"]) {
    assert.ok(dirs.includes(must), `没看到 ${must}，REPO 解析错了：${REPO}`);
  }
});

test("🔴 每个顶层目录都要有归属：要么发，要么明写不发", () => {
  const ship = new Set(APP_DIRS as string[]);
  const skip = new Set(Object.keys(APP_DIRS_EXCLUDED as Record<string, string>));
  const orphans = topLevelDirs().filter((d) => !ship.has(d) && !skip.has(d));
  assert.deepEqual(
    orphans,
    [],
    `这些目录既没进 APP_DIRS 也没进 APP_DIRS_EXCLUDED：${orphans.join(", ")}\n` +
      "  新加顶层目录时二选一，不许都不选 —— 漏了的表现是「装机版少了这块功能，而打包零报错」。",
  );
  // 反向也查：清单里写了、仓库里却没有 —— 装配时会 die，但这里先说清楚是哪一个
  for (const d of ship) assert.ok(fs.existsSync(path.join(REPO, d)), `APP_DIRS 里的 ${d} 在仓库里不存在`);
  for (const d of skip) assert.ok(fs.existsSync(path.join(REPO, d)), `APP_DIRS_EXCLUDED 里的 ${d} 在仓库里不存在（该删掉这条了）`);
});

test("🔴 回测要发出去 —— 后端把它当 Python 模块跑，不在包里这页就是坏的", () => {
  assert.ok((APP_DIRS as string[]).includes("backtest"), "backtest 必须在 APP_DIRS 里");
  const plugin = fs.readFileSync(path.join(REPO, "orchestrator", "src", "finance", "plugin.ts"), "utf8");
  // 这条断言是"为什么必须发"的依据本身：模块名改了就该重新想一遍要发什么
  assert.ok(/module:\s*"backtest\./.test(plugin), "垂类包不再按 backtest.* 跑模块了？重新核对 APP_DIRS");
});

test("🔴 三处版本号必须一致 —— 用户眼里只有一个产品版本", () => {
  // 侧栏读 desktop/package.json；/health 与 MCP 握手读 orchestrator/package.json；
  // dmg 文件名与 App 版本读 shell/package.json。分叉过一次（对外 0.5.0 vs 包 0.1.0），
  // 表现是"这个 bug 在哪个版本"无从查起。
  const ver = (p: string): string =>
    (JSON.parse(fs.readFileSync(path.join(REPO, p, "package.json"), "utf8")) as { version?: string }).version ?? "";
  const got = { orchestrator: ver("orchestrator"), desktop: ver("desktop"), shell: ver("shell") };
  const uniq = [...new Set(Object.values(got))];
  assert.equal(uniq.length, 1, `版本分叉了：${JSON.stringify(got)}`);
  assert.match(uniq[0]!, /^\d+\.\d+\.\d+$/, `版本号格式不对：${uniq[0]}`);
});
