#!/usr/bin/env node
/**
 * 载荷装配 —— 把"跑起来需要的一切"摆成装机版的样子。
 *
 * 产出 `shell/payload/`，它会被 electron-builder 原样放进 `<App>/Contents/Resources/`：
 *
 *   payload/app/     产品根（宪法 / skills / 注册表 / calc / 编排器 + 它的 node_modules，引擎在里面）
 *   payload/ui/      界面产物（desktop 的 vite build）
 *   payload/python/  可重定位解释器 + 依赖
 *
 * ## 三条定下来的做法
 *
 * 🔴 **按允许清单拷，不按排除清单**。发行物里多一个不该有的文件（.local、密钥、测试夹具）
 *    是没人会发现的那种错；少一个则会当场报错。宁可少，不可多。
 * 🔴 **编排器发的是 .ts 源码，不编译**。它自己会按硬编码路径拉起 `orchestrator/src/run.ts`；
 *    编译成 .js 那条路当场就断，而且断在"点了开始研究之后"。宿主 Node 24 默认能剥类型（已实测）。
 * 🔴 **引擎打的是整个 npm 平台包，不是抠出来的二进制**。SDK 除了二进制还要把平台包里的
 *    `codex-path/` 塞进子进程 PATH；一旦给它显式路径，那份 PATH 会被清空。
 *
 * ## Python
 *
 * venv 底下就是 uv 的 python-build-standalone —— 那本来就是为"可重定位"造的。
 * 整棵拷走 + `site-packages` **直接塞进它自己的目录**（不建 venv、不留软链），跑真实取数验证过。
 *
 * 用法：node scripts/assemble.mjs [--out <目录>] [--skip-verify] [--skip-ui-build]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, "..");
const REPO = path.resolve(SHELL, "..");

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const OUT = path.resolve(argOf("--out") ?? path.join(SHELL, "payload"));
const SKIP_VERIFY = args.includes("--skip-verify");
const SKIP_UI_BUILD = args.includes("--skip-ui-build");

const log = (s) => process.stdout.write(`${s}\n`);
const die = (s) => { process.stderr.write(`\n✕ ${s}\n`); process.exit(1); };

/**
 * 用 `ditto` 拷贝目录：它保留权限位、符号链接与扩展属性。
 * ⚠️ 引擎二进制与 Python 解释器**必须保住执行位**，`fs.cp` 在这方面不如 ditto 稳。
 */
function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync("ditto", [src, dest], { stdio: "inherit" });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** 产品根里要发出去的东西。**清单即契约**：新增运行期依赖必须在这里登记。 */
const APP_FILES = [
  "AGENTS.md",                  // 宪法（引擎从产品根自动加载）
  ".vibe-research-root",        // 指令根标记（引擎靠它认产品根）
  "vibe-research.config.json",  // 产品默认配置
  "codex-version.json",         // 引擎版本记录
  "README.md",
];
export const APP_DIRS = [
  ".agents",       // 项目技能
  "calc",          // 确定性计算库（agent 通过 CLI 调）
  "backtest",      // 回测（后端按 `backtest.cli` 当模块跑，不在包里回测页就是坏的）
  "datasources",   // 端点注册表 + 产业标签
  "providers",     // 模型接入模板
  "knowledge",     // 知识层脚手架
  "scripts",       // init / doctor
  "docs",
];

/**
 * **刻意不发**的顶层目录。写出来不是为了好看 —— `payload_manifest.test.ts` 会拿它和
 * `APP_DIRS` 一起去跟仓库实际的顶层目录对账。
 *
 * 🔴 为什么需要这张表：`assembleApp()` 对清单里**缺**的目录会 `die()`，但对清单里**没写**的
 *    目录一无所知。`backtest/` 就是这么漏的 —— 2026-08-26 加的模块，装配脚本没人改，
 *    打出来的 App 里没有它，而**打包全程零报错**，装机后点开回测页才会炸。
 *    ⇒ 新加一个顶层目录时，要么进 APP_DIRS，要么进这里，二选一，不许都不选。
 */
export const APP_DIRS_EXCLUDED = {
  assets: "图标母图等原始素材，运行时用不到",
  build: "App 图标的 icns 与 iconset —— electron-builder 自己会把它嵌进 .app，不进载荷",
  desktop: "界面源码；发的是 vite build 产物（payload/ui），不发源码",
  orchestrator: "单独按 ORCH_ENTRIES 装配（要挑掉 test/）",
  shell: "外壳自己，由 electron-builder 打，不能自己装自己",
};
/** 编排器目录内部同样按清单来（`test/` 不发） */
const ORCH_ENTRIES = ["package.json", "package-lock.json", "tsconfig.json", "README.md", "src", "hooks", "node_modules"];

function assembleApp() {
  const app = path.join(OUT, "app");
  for (const f of APP_FILES) {
    const src = path.join(REPO, f);
    if (!fs.existsSync(src)) die(`产品根缺文件：${f}（清单与仓库对不上，先确认它是不是改名了）`);
    copyFile(src, path.join(app, f));
  }
  for (const d of APP_DIRS) {
    const src = path.join(REPO, d);
    if (!fs.existsSync(src)) die(`产品根缺目录：${d}`);
    copyTree(src, path.join(app, d));
  }
  for (const e of ORCH_ENTRIES) {
    const src = path.join(REPO, "orchestrator", e);
    if (!fs.existsSync(src)) die(`编排器缺 ${e}（node_modules 要先 npm install）`);
    const dest = path.join(app, "orchestrator", e);
    if (fs.statSync(src).isDirectory()) copyTree(src, dest); else copyFile(src, dest);
  }
  // 🔴 清单法只管到**目录级**：`ditto` 会把目录里的一切原样带走，包括工作树里那些
  //    没被 git 跟踪、但也绝不该发出去的东西。所以拷完还要过两道：
  //    垃圾（缓存、.pyc）静默清掉；私有物（.env / 密钥 / 日志 / .local）**拦下构建**。
  pruneJunk(app, { dropPycache: true });
  assertNoPrivate(app);
}

/**
 * 发行版里绝不该出现的东西。**发现就停下**，不偷偷删 ——
 * 工作树里有一个 `providers/.env`，维护者需要知道，而不是让构建替他抹掉再照常发。
 */
const PRIVATE_DIRS = new Set([".local", ".git", ".venv"]);
const PRIVATE_FILE = (name) =>
  (name.startsWith(".env") && name !== ".env.example") ||
  /\.(pem|key|p12|pfx|token|log)$/i.test(name) ||
  name === "api.token";

function assertNoPrivate(root) {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (PRIVATE_DIRS.has(e.name)) { found.push(p); continue; }
        walk(p);
      } else if (PRIVATE_FILE(e.name)) {
        found.push(p);
      }
    }
  };
  walk(root);
  if (found.length) {
    die(`这些东西不该进发行版（先从工作树里挪走再重来）：\n  ${found.slice(0, 20).map((f) => path.relative(OUT, f)).join("\n  ")}` +
      (found.length > 20 ? `\n  …共 ${found.length} 个` : ""));
  }
}

/**
 * 跟着目录一起被拷进来的开发垃圾。列举，不猜。
 * ⚠️ 这里放的是**单个目录名**，遍历时比的就是 `e.name` —— 写成 `node_modules/.cache`
 *    那种带分隔符的形式永远匹配不到（写过一次，白写）。
 * 🔴 **`__pycache__` 不在这张表里，是故意的**：那是 Python 的字节码缓存，
 *    发行版**必须带着**。实测（akshare 冷 import）：带缓存 2.8 秒，不带 21.9 秒；
 *    而 App 包在别人机器上很可能是只读的 —— 那样每一次取数都要付那 21.9 秒。
 *    它由下面的 `precompile()` 统一重新生成（比原样带走 venv 里的更干净、更全）。
 */
const JUNK_DIRS = new Set([".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache"]);
function pruneJunk(root, { dropPycache = false } = {}) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (!e.isDirectory()) {
        if (e.name === ".DS_Store") fs.rmSync(p, { force: true });
        continue;
      }
      if (JUNK_DIRS.has(e.name) || (dropPycache && e.name === "__pycache__")) {
        fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      walk(p);
    }
  };
  walk(root);
}

/**
 * 用**载荷里那个解释器**把字节码全量编一遍。
 *
 * 为什么不直接把 venv 里现成的 `__pycache__` 拷过来：那份是零散的（只有被 import 过的才有），
 * 而且里面记着 venv 的路径。这里先清干净再统一生成，得到的是完整且一致的一份。
 * 🔴 **必须用 hash 型缓存（`--invalidation-mode unchecked-hash`）**，不能用默认的 mtime 型。
 *    上一版这里写着"`ditto` 保留 mtime ⇒ 装到用户机器上依然有效" —— **那句只算了 ditto 这一步**，
 *    没算 electron-builder 自己那次 `payload → App` 的拷贝：**它不保留 mtime**。
 *    实测（已签名的包里）：`.py` 的 mtime 被重置成拷贝时刻，而 `.pyc` 记的还是原始 mtime，
 *    抽 60 个有 48 个失效 ⇒ 用户第一次用到任何模块都会重新编译，于是
 *      ① 预编那 20 秒白省了（这是做预编的**全部理由**）；
 *      ② 更糟：**重新编译会把 .pyc 写进 App 包里，当场破坏代码签名**
 *         —— 实测跑两次业务就有 505 个 .pyc 被写进去，`codesign -v --strict` 随即报
 *         `a sealed resource is missing or invalid`。
 *    hash 型缓存不看 mtime（`unchecked-hash` 连 hash 都不校验，直接用），两个问题一起解。
 * ⚠️ **必须带 `-f`**：`compileall` 认为已有的 .pyc「还新鲜」就直接跳过，**不会**因为你换了
 *    失效模式就重写它。实测漏了 `-f` 时包里 mtime 型与 hash 型混着，等于修了一半。
 * ⚠️ 代价：源文件改了而没重新预编时，会**静默用旧字节码**。在只读、已签名的发行包里
 *    源文件不会变，这个代价不存在；但**别把这个模式用到开发目录**。
 * ⚠️ 代价：报错回溯里的文件路径会显示成构建时的载荷路径，不是安装路径（只影响观感）。
 */
function precompile(pythonExe, targets) {
  for (const t of targets) {
    // -q 只报错误；编译失败（比如某个包里有 py2 语法的样例文件）不该拦住发布，所以不看退出码
    try {
      execFileSync(pythonExe, ["-m", "compileall", "-q", "-j", "0", "-f", "--invalidation-mode", "unchecked-hash", t], { stdio: "pipe", timeout: 900_000 });
    } catch {
      /* 个别文件编不了很正常（第三方包里常有故意不合法的样例）；缺的那几个只是回到懒编译 */
    }
  }
}

/**
 * 界面：**自己构建，不信任已有的 `desktop/dist`**。
 *
 * 🔴 只检查 `dist/index.html` 在不在，等于允许把**上一次**的界面打进这一次的包：
 *    整条流程会成功、验证也会成功，装出来的却是旧界面。这类"成功地做错"最难发现。
 *    ⇒ 每次装配都重新 `vite build`。要跳过（反复调外壳时）显式加 `--skip-ui-build`。
 */
function assembleUi() {
  const dist = path.join(REPO, "desktop", "dist");
  if (SKIP_UI_BUILD) {
    log("  （--skip-ui-build：沿用现有 desktop/dist）");
  } else {
    fs.rmSync(dist, { recursive: true, force: true });   // 旧产物先清掉，免得构建失败时还留着看着像成功
    execFileSync("npm", ["run", "build", "--prefix", path.join(REPO, "desktop")], { stdio: "inherit", cwd: REPO });
  }
  if (!fs.existsSync(path.join(dist, "index.html")))
    die(`界面产物不在：${dist}/index.html（vite build 没产出入口）`);
  copyTree(dist, path.join(OUT, "ui"));
}

/** venv 的 python 是个软链，指向 uv 装的 python-build-standalone —— 那棵树才是要拷的 */
function findPythonStandalone() {
  for (const venv of [path.join(REPO, ".venv"), path.join(path.dirname(REPO), ".venv")]) {
    const bin = path.join(venv, "bin", "python");
    if (!fs.existsSync(bin)) continue;
    const real = fs.realpathSync(bin);                       // …/cpython-3.12.13-…/bin/python3.12
    const root = path.resolve(path.dirname(real), "..");     // …/cpython-3.12.13-…
    if (!fs.existsSync(path.join(root, "lib"))) continue;
    return { venv, root, exe: path.basename(real) };
  }
  return null;
}

/** 只从 site-packages 里剔除**明确只属于测试**的东西；不确定的一律留着 */
const PY_DROP = [/^_pytest$/, /^pytest$/, /^pytest-[\d.]+\.dist-info$/, /^iniconfig/, /^pluggy/, /^_virtualenv/];

function assemblePython() {
  const found = findPythonStandalone();
  if (!found) die("找不到 .venv（先按 README 建虚拟环境）");
  const dest = path.join(OUT, "python");
  copyTree(found.root, dest);

  const srcSp = path.join(found.venv, "lib", "python3.12", "site-packages");
  const dstSp = path.join(dest, "lib", "python3.12", "site-packages");
  if (!fs.existsSync(srcSp)) die(`venv 里没有 site-packages：${srcSp}`);
  fs.mkdirSync(dstSp, { recursive: true });
  for (const name of fs.readdirSync(srcSp)) {
    if (PY_DROP.some((re) => re.test(name))) continue;
    const src = path.join(srcSp, name);
    if (fs.statSync(src).isDirectory()) copyTree(src, path.join(dstSp, name));
    else copyFile(src, path.join(dstSp, name));
  }
  pruneJunk(dest, { dropPycache: true });   // 先清掉 venv 带来的零散缓存，下面统一重编
  return { exe: path.join(dest, "bin", found.exe), from: found.root };
}

/**
 * 装完就地验一遍。
 * 🔴 **不验等于不知道**：这一步的失败（少一个文件、丢了执行位、Python 拷坏了）
 *    在装机版上表现为"点开之后某个功能不工作"，离原因十万八千里。
 */
function verify(pythonExe) {
  const app = path.join(OUT, "app");

  // ① Python 能跑，且关键依赖导得进来
  const probe = "import sys, akshare, pandas, lxml, curl_cffi, ssl, sqlite3; print(sys.prefix)";
  const prefix = execFileSync(pythonExe, ["-c", probe], { encoding: "utf8", timeout: 180_000 }).trim();
  if (!prefix.startsWith(OUT)) die(`Python 的 sys.prefix 没跟着搬过来：${prefix}`);
  log(`  ✓ Python 可用，sys.prefix = ${prefix}`);

  // ② 真取一次数（拿不到网络也要能明确报出来，而不是装完了才发现）
  const fetchScript = path.join(app, ".agents", "skills", "data-access", "scripts", "fetch_quote.py");
  if (!fs.existsSync(fetchScript)) die(`取数脚本没打进来：${fetchScript}`);
  const out = execFileSync(pythonExe, [fetchScript, "--symbol", "300308"], { encoding: "utf8", timeout: 180_000 });
  const env = JSON.parse(out);
  if (!env.evidence?.length) die(`取数跑通了但没有证据：${out.slice(0, 300)}`);
  log(`  ✓ 真实取数 ${env.status}，${env.evidence.length} 条证据`);

  // ③ 引擎二进制在，且能执行
  const openai = path.join(app, "orchestrator", "node_modules", "@openai");
  const bin = findEngine(openai);
  if (!bin) die(`引擎二进制没打进来：${openai} 下没有 vendor/*/bin/codex`);
  const ver = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 60_000 }).trim();
  log(`  ✓ 引擎可执行：${ver}`);

  // ④ 界面入口在
  if (!fs.existsSync(path.join(OUT, "ui", "index.html"))) die("界面入口 ui/index.html 不在");
  log("  ✓ 界面产物在位");

  // ⑤ 字节码真的编上了 —— 只看"目录在不在"会漏掉"只编了一半"
  const sp = path.join(OUT, "python", "lib", "python3.12", "site-packages");
  const cached = fs.readdirSync(sp).filter((n) => fs.existsSync(path.join(sp, n, "__pycache__"))).length;
  if (cached < 10) die(`字节码没编上（site-packages 下只有 ${cached} 个包有 __pycache__）—— 装机版每次取数都会慢二十秒`);
  log(`  ✓ 字节码已预编（${cached} 个包带缓存）`);
}

function findEngine(modulesDir) {
  if (!fs.existsSync(modulesDir)) return null;
  for (const pkg of fs.readdirSync(modulesDir).sort()) {
    const vendor = path.join(modulesDir, pkg, "vendor");
    if (!fs.existsSync(vendor)) continue;
    for (const triple of fs.readdirSync(vendor).sort()) {
      const bin = path.join(vendor, triple, "bin", "codex");
      if (fs.existsSync(bin) && fs.existsSync(path.join(vendor, triple, "codex-package.json"))) return bin;
    }
  }
  return null;
}

function sizeOf(p) {
  try {
    return execFileSync("du", ["-sh", p], { encoding: "utf8" }).split("\t")[0];
  } catch {
    return "?";
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────
/**
 * 🔴 只有**作为脚本被运行**时才装配。
 *    没有这道门的话，任何人 `import` 这个文件（比如棘轮想读一下 APP_DIRS）都会
 *    **把整个载荷重装一遍** —— 慢，而且是一次谁都没打算触发的副作用。
 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}

function main() {
if (os.platform() !== "darwin") die("目前只装配 macOS 载荷（ditto 是 macOS 工具）");
log(`装配到 ${OUT}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

log("· 产品根");
assembleApp();
log("· 界面");
assembleUi();
log("· Python");
const py = assemblePython();

log("· 预编译字节码（发行版多半装在只读位置，现在不编，用户每次取数都要多等二十秒）");
precompile(py.exe, [path.join(OUT, "python", "lib"), path.join(OUT, "app")]);

if (SKIP_VERIFY) {
  log("· 跳过验证（--skip-verify）");
} else {
  log("· 验证");
  verify(py.exe);
}

log("");
for (const d of ["app", "ui", "python"]) log(`  ${d.padEnd(8)} ${sizeOf(path.join(OUT, d))}`);
log(`  ${"合计".padEnd(7)} ${sizeOf(OUT)}`);
log("\n完成。");

}