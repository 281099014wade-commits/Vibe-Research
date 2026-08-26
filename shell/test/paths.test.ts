import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DATA_DIR_NAME, findBundledEngine, preflight, resolveDataRoot, resolvePaths, spaceProblem } from "../src/paths.ts";

test("数据根默认在家目录下，可用 VIBE_DATA_ROOT 覆盖（测试 / 多实例靠它）", () => {
  assert.equal(resolveDataRoot({}), path.join(os.homedir(), ".vibe-research-agent"));
  assert.equal(resolveDataRoot({ VIBE_DATA_ROOT: "/tmp/x" }), "/tmp/x");
  assert.equal(resolveDataRoot({ VIBE_DATA_ROOT: "  " }), path.join(os.homedir(), ".vibe-research-agent"));
});

test("🔴 路径里有空格要当场说清楚（引擎的指令发现链会因此失效，而且是跑到一半才失效）", () => {
  assert.ok(spaceProblem("数据根", "/Users/x/Library/Application Support/VR"));
  assert.equal(spaceProblem("数据根", "/Users/x/.vibe-research"), null);
});

test("装机版一切按 Resources 布局；开发期一切在仓库里", () => {
  const packed = resolvePaths({ packaged: true, resourcesPath: "/A/Contents/Resources", repoRootForDev: "/ignored", env: { VIBE_DATA_ROOT: "/d" } });
  assert.equal(packed.repoRoot, "/A/Contents/Resources/app");
  assert.equal(packed.uiDir, "/A/Contents/Resources/ui");
  // 🔴 装机版也让 SDK 自己解析（传显式路径会让它把 codex-path 那份 PATH 清空）
  assert.equal(packed.enginePath, null);
  assert.equal(packed.engineModulesDir, "/A/Contents/Resources/app/orchestrator/node_modules/@openai");
  // 🔴 装机版与开发期跑同一份 .ts；目录结构照抄仓库（编排器会按 import.meta.url 往上两级推产品根）
  assert.equal(packed.orchestratorEntry, "/A/Contents/Resources/app/orchestrator/src/api.ts");
  assert.equal(path.resolve(path.dirname(packed.orchestratorEntry), "..", ".."), packed.repoRoot,
    "入口往上两级必须正好是产品根");
  // 🔴 用户数据绝不能落在 App 包里：那儿只读，而且升级时整个被换掉
  assert.ok(!packed.dataRoot.startsWith("/A/Contents"), packed.dataRoot);
  assert.ok(packed.codexHome.startsWith("/d"));
  assert.ok(packed.shellStateDir.startsWith("/d"));

  const dev = resolvePaths({ packaged: false, resourcesPath: "/unused", repoRootForDev: "/repo", env: { VIBE_DATA_ROOT: "/d" } });
  assert.ok(dev.orchestratorEntry.endsWith(path.join("orchestrator", "src", "api.ts")));
  assert.equal(dev.enginePath, null, "开发期让编排器自己解析引擎");
});

test("🔴 preflight 把缺什么一次说全（一条一条报会让人来回启动好几次）", () => {
  const p = resolvePaths({ packaged: true, resourcesPath: "/nowhere/Resources", repoRootForDev: "/x", env: { VIBE_DATA_ROOT: "/tmp/has space/d" } });
  const probs = preflight(p);
  assert.ok(probs.length >= 4, `应当一次报全，实际 ${probs.length} 条：\n${probs.join("\n")}`);
  assert.ok(probs.some((s) => s.includes("产品根")));
  assert.ok(probs.some((s) => s.includes("界面入口")));
  assert.ok(probs.some((s) => s.includes("引擎")));
  assert.ok(probs.some((s) => s.includes("空格")));
});

test("装齐了就没有问题（否则上一条可能是\"永远都在报\"）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-res-"));
  const res = path.join(root, "Resources");
  fs.mkdirSync(path.join(res, "app", "orchestrator", "src"), { recursive: true });
  fs.mkdirSync(path.join(res, "ui"), { recursive: true });
  fs.mkdirSync(path.join(res, "python", "bin"), { recursive: true });
  const vendor = path.join(res, "app", "orchestrator", "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin");
  fs.mkdirSync(path.join(vendor, "bin"), { recursive: true });
  fs.writeFileSync(path.join(res, "app", "orchestrator", "src", "api.ts"), "");
  fs.writeFileSync(path.join(res, "ui", "index.html"), "<html></html>");
  fs.writeFileSync(path.join(res, "python", "bin", "python3.12"), "", { mode: 0o755 });
  fs.writeFileSync(path.join(vendor, "bin", "codex"), "", { mode: 0o755 });
  fs.writeFileSync(path.join(vendor, "codex-package.json"), "{}");
  const p = resolvePaths({ packaged: true, resourcesPath: res, repoRootForDev: "/x", env: { VIBE_DATA_ROOT: path.join(root, "data") } });
  assert.deepEqual(preflight(p), []);
});

test("🔴 只查\"在不在\"不够：目录冒充文件、二进制没有执行位，都要在这里说出来", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bad-"));
  const res = path.join(root, "Resources");
  fs.mkdirSync(path.join(res, "app", "orchestrator", "src", "api.ts"), { recursive: true }); // 入口是个目录
  fs.mkdirSync(path.join(res, "ui", "index.html"), { recursive: true });                     // 界面入口是个目录
  fs.mkdirSync(path.join(res, "python", "bin"), { recursive: true });
  const vendor2 = path.join(res, "app", "orchestrator", "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin");
  fs.mkdirSync(path.join(vendor2, "bin"), { recursive: true });
  fs.writeFileSync(path.join(res, "python", "bin", "python3.12"), "", { mode: 0o644 });       // 没有执行位
  fs.writeFileSync(path.join(vendor2, "bin", "codex"), "", { mode: 0o644 });                  // 引擎也没有执行位
  fs.writeFileSync(path.join(vendor2, "codex-package.json"), "{}");
  const p = resolvePaths({ packaged: true, resourcesPath: res, repoRootForDev: "/x", env: { VIBE_DATA_ROOT: path.join(root, "data") } });
  const probs = preflight(p);
  assert.ok(probs.some((s) => s.includes("编排器入口") && s.includes("不是一个普通文件")), probs.join("\n"));
  assert.ok(probs.some((s) => s.includes("界面入口") && s.includes("不是一个普通文件")), probs.join("\n"));
  assert.ok(probs.some((s) => s.includes("Python") && s.includes("没有执行权限")), probs.join("\n"));
  assert.ok(probs.some((s) => s.includes("引擎") && s.includes("没有执行权限")), probs.join("\n"));
});

test("产品根是个文件而不是目录，也要报出来", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bad2-"));
  const res = path.join(root, "Resources");
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, "app"), "");
  const p = resolvePaths({ packaged: true, resourcesPath: res, repoRootForDev: "/x", env: { VIBE_DATA_ROOT: path.join(root, "data") } });
  assert.ok(preflight(p).some((s) => s.includes("产品根") && s.includes("不是一个目录")));
});

test("🔴 引擎二进制没打进来要报出来（那是 200 多 MB 的大件，最容易在打包环节掉）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-noeng-"));
  const res = path.join(root, "Resources");
  fs.mkdirSync(path.join(res, "app", "orchestrator", "node_modules", "@openai"), { recursive: true });
  const p = resolvePaths({ packaged: true, resourcesPath: res, repoRootForDev: "/x", env: { VIBE_DATA_ROOT: path.join(root, "data") } });
  assert.ok(preflight(p).some((s) => s.includes("找不到引擎二进制")), preflight(p).join("\n"));
});

test("与 SDK 同口径：光有 bin/codex、缺 codex-package.json 不算数（否则体检说在、SDK 说找不到）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-eng2-"));
  const v = path.join(root, "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin");
  fs.mkdirSync(path.join(v, "bin"), { recursive: true });
  fs.writeFileSync(path.join(v, "bin", "codex"), "", { mode: 0o755 });
  assert.equal(findBundledEngine(path.join(root, "@openai")), null);
  fs.writeFileSync(path.join(v, "codex-package.json"), "{}");
  assert.equal(findBundledEngine(path.join(root, "@openai")), path.join(v, "bin", "codex"));
});

test("🔴 数据根不许叫 .vibe-research —— 那个名字是开源版看板的（portfolio.json / myreports 都在里面）", () => {
  assert.equal(DATA_DIR_NAME, ".vibe-research-agent");
  assert.notEqual(DATA_DIR_NAME, ".vibe-research");
});
