/**
 * 外壳的路径解析 —— **开发期与装机版是两套根，这一层错了后面全错。**
 *
 * | 东西 | 开发期 | 装机版 |
 * |---|---|---|
 * | 产品根（注册表 / skills / calc） | 仓库根 | `<App>/Contents/Resources/app` |
 * | 界面产物 | `desktop/dist` | `<App>/Contents/Resources/ui` |
 * | Python | 仓库上一级的 `.venv` | `<App>/Contents/Resources/python` |
 * | 引擎二进制 | 编排器自己解析 | `<App>/Contents/Resources/engine/codex` |
 * | **用户数据** | 仓库里的 `.local` | **`~/.vibe-research`** |
 *
 * 🔴 装机版的用户数据**绝不能**落在 App 包里：那儿是只读的，而且升级时整个目录被换掉。
 * 🔴 数据根路径**不能含空格** —— 引擎的指令发现链对此敏感（见 `docs/instructions-root.md`），
 *    所以不能用 `~/Library/Application Support`（自带空格）。这条不是偏好，是硬约束。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShellPaths {
  /** 打包过没有 */
  packaged: boolean;
  /** 产品根：AGENTS.md / datasources / .agents/skills / calc 所在 */
  repoRoot: string;
  /**
   * 编排器入口。**开发期与装机版是同一份 `.ts` 源码。**
   *
   * 🔴 一度打算编译成 JS 再发。放弃了，理由是编译反而更脆：
   *    ① 编排器**自己会按硬编码路径拉起 `orchestrator/src/run.ts`**（研究运行），
   *       编译后那个文件叫 `.js`，那条路径当场就断，而且断在"点了开始研究之后"，不是启动时；
   *    ② 发出去的东西与我们测过的东西不再是同一份字节。
   *    宿主 Node 24 默认就能剥类型（已实测：不带 flag 也能跑起 api.ts），
   *    而 `erasableSyntaxOnly` 早就打开着 —— 这份源码本来就是"能被剥"的。
   *    真要哪天剥不动，表现是启动时一句语法错、直接显示在启动页上，不是静默。
   */
  orchestratorEntry: string;
  /** 界面产物目录（内有 index.html） */
  uiDir: string;
  /** Python 解释器绝对路径 */
  python: string;
  /**
   * 引擎二进制的**显式覆盖**；null = 让 SDK 自己解析。
   *
   * 🔴 装机版也是 null，**故意的**。SDK 的解析除了二进制本身，还会把平台包里的
   *    `codex-path/` 目录塞进子进程的 PATH；而一旦传了显式路径，SDK 会把那份
   *    PATH 列表清空（`pathDirs = []`，见 codex-sdk 的 CodexExec 构造函数）。
   *    ⇒ 我们把**整个平台包**原样打进 `orchestrator/node_modules`，让它照常解析。
   */
  enginePath: string | null;
  /**
   * 引擎平台包所在目录（`@openai`），只给体检看：确认那 200 多 MB 的二进制真的打进来了。
   * 🔴 不写死平台三元组 —— 扫 `vendor/<任意>/bin/codex`，省得多一份会漂移的映射表。
   */
  engineModulesDir: string;
  /** 用户数据根 */
  dataRoot: string;
  /** 引擎 home */
  codexHome: string;
  /** 外壳自己的状态目录（Electron 的 userData + 后端 pidfile 都放这儿）*/
  shellStateDir: string;
}

/**
 * 数据根：允许用 `VIBE_DATA_ROOT` 覆盖（测试 / 多实例用），否则 `~/.vibe-research-agent`。
 *
 * 🔴 **不能用 `~/.vibe-research`** —— 那个名字已经被开源版 Vibe Research 看板占着
 *    （里面有它的 portfolio.json / myreports / monitor）。装机版往那儿写，
 *    等于两个产品共用一个数据目录：谁也不会报错，但迟早互相覆盖。
 *    这是装完真跑一次才发现的 —— 目录本来就在，看着像"我们之前建的"。
 */
export const DATA_DIR_NAME = ".vibe-research-agent";

export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VIBE_DATA_ROOT?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), DATA_DIR_NAME);
}

/**
 * 🔴 路径里有空格就**当场说清楚**，不要等到引擎在某个深处报一句看不懂的错。
 *    这类问题最难查的地方在于：它不是启动就崩，而是跑到一半某个阶段莫名其妙不工作。
 */
export function spaceProblem(label: string, p: string): string | null {
  return /\s/.test(p)
    ? `${label}的路径里有空格，引擎的指令发现链会因此失效：${p}（换一个不含空格的位置，比如 ~/.vibe-research-agent）`
    : null;
}

export function resolvePaths(opts: {
  packaged: boolean;
  resourcesPath: string;
  repoRootForDev: string;
  env?: NodeJS.ProcessEnv;
}): ShellPaths {
  const env = opts.env ?? process.env;
  const dataRoot = resolveDataRoot(env);
  const codexHome = path.join(dataRoot, "codex-home");
  const shellStateDir = path.join(dataRoot, "shell");

  if (opts.packaged) {
    const res = opts.resourcesPath;
    return {
      packaged: true,
      repoRoot: path.join(res, "app"),
      // 🔴 目录结构**照抄仓库**：编排器里有几处用 `import.meta.url` 往上两级推产品根，
      //    压平一层会让它推到 Resources 上去（而不是 Resources/app），且不报错。
      orchestratorEntry: path.join(res, "app", "orchestrator", "src", "api.ts"),
      uiDir: path.join(res, "ui"),
      python: path.join(res, "python", "bin", "python3.12"),
      enginePath: null,
      engineModulesDir: path.join(res, "app", "orchestrator", "node_modules", "@openai"),
      dataRoot,
      codexHome,
      shellStateDir,
    };
  }

  // 开发期：一切都在仓库里，Python 用 .venv（与 orchestrator 的 detectPython 同源：仓库内 → 上一级）
  const repoRoot = opts.repoRootForDev;
  const venvCandidates = [
    path.join(repoRoot, ".venv", "bin", "python"),
    path.join(path.dirname(repoRoot), ".venv", "bin", "python"),
  ];
  return {
    packaged: false,
    repoRoot,
    orchestratorEntry: path.join(repoRoot, "orchestrator", "src", "api.ts"),
    uiDir: path.join(repoRoot, "desktop", "dist"),
    python: venvCandidates.find((p) => fs.existsSync(p)) ?? "python3",
    enginePath: null,
    engineModulesDir: path.join(repoRoot, "orchestrator", "node_modules", "@openai"),
    dataRoot,
    codexHome,
    shellStateDir,
  };
}

/**
 * 启动前把「缺什么」**一次说全**。
 *
 * 🔴 一条一条报会让用户来回启动好几次：修好 Python 才发现界面产物也没有。
 * ⚠️ 返回的是**人话清单**，不是异常 —— 这些是安装 / 构建问题，不是崩溃。
 */
type Need = "dir" | "file" | "exec";

/**
 * 🔴 **不能只查"在不在"**。`existsSync` 对目录、FIFO、没有执行位的文件一律返回 true，
 *    于是"预检通过"却在 spawn 时报 `EISDIR` / `ENOEXEC` / `EACCES` ——
 *    故障被推迟到一个不说人话的地方。
 *    尤其 `exec`：打包时漏掉执行位是很常见的一类失误，而它在这里一查就出来。
 */
function checkPath(target: string, kind: Need): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return "找不到";
  }
  if (kind === "dir") return st.isDirectory() ? null : "不是一个目录";
  if (!st.isFile()) return "不是一个普通文件";
  if (kind === "exec") {
    try {
      fs.accessSync(target, fs.constants.X_OK);
    } catch {
      return "没有执行权限";
    }
  }
  return null;
}

/**
 * 在平台包目录里找那个真正的引擎二进制。
 * 只认"新布局"（`vendor/<三元组>/bin/codex` 且同级有 `codex-package.json`）——
 * 与 SDK 自己的判据同口径，免得体检说"在"而 SDK 说"找不到"。
 */
export function findBundledEngine(modulesDir: string): string | null {
  let pkgs: string[];
  try {
    pkgs = fs.readdirSync(modulesDir);
  } catch {
    return null;
  }
  for (const pkg of pkgs.sort()) {
    const vendor = path.join(modulesDir, pkg, "vendor");
    let triples: string[];
    try {
      triples = fs.readdirSync(vendor);
    } catch {
      continue;
    }
    for (const triple of triples.sort()) {
      const bin = path.join(vendor, triple, "bin", "codex");
      if (fs.existsSync(bin) && fs.existsSync(path.join(vendor, triple, "codex-package.json"))) return bin;
    }
  }
  return null;
}

export function preflight(p: ShellPaths): string[] {
  const problems: string[] = [];
  const incomplete = p.packaged ? "安装包不完整，重装一次" : null;
  const need: [string, string, Need, string][] = [
    ["产品根", p.repoRoot, "dir", incomplete ?? "仓库路径不对"],
    ["编排器入口", p.orchestratorEntry, "file", incomplete ?? "编排器源码不在预期位置"],
    // 🔴 查的是 index.html **这个文件**，不是界面目录：升级残留 / 构建没跑完时目录常常在、文件不在，
    //    只查目录就会"预检通过、切界面时才失败"。
    ["界面入口", path.join(p.uiDir, "index.html"), "file", incomplete ?? "先跑 npm run build --prefix desktop"],
  ];
  // python3 = 回退到 PATH 里找，那种情况下存在与否由 spawn 时决定，这里不误报
  if (p.python !== "python3") need.push(["Python", p.python, "exec", incomplete ?? "先建 .venv"]);
  if (p.enginePath) need.push(["引擎", p.enginePath, "exec", incomplete ?? "引擎二进制缺失"]);

  for (const [label, target, kind, fix] of need) {
    const bad = checkPath(target, kind);
    if (bad) problems.push(`${label}${bad}：${target}（${fix}）`);
  }
  if (!p.enginePath) {
    const engine = findBundledEngine(p.engineModulesDir);
    if (!engine) {
      problems.push(`找不到引擎二进制：${p.engineModulesDir} 下没有 vendor/*/bin/codex（${incomplete ?? "cd orchestrator && npm install"}）`);
    } else {
      const bad = checkPath(engine, "exec");
      if (bad) problems.push(`引擎${bad}：${engine}（${incomplete ?? "重新 npm install"}）`);
    }
  }
  const space = spaceProblem("数据根", p.dataRoot);
  if (space) problems.push(space);
  return problems;
}
