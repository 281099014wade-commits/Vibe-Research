/**
 * 拉起本机编排器，并**等到它真的能应答**再放行。
 *
 * 🔴 「进程起来了」不等于「服务能用了」。spawn 拿到的只是一个 pid ——
 *    这时候去 loadURL，界面第一批请求全部 ECONNREFUSED，用户看到的是一屏错误。
 *    ⇒ 必须轮询 `/health` 直到真的 200。
 * 🔴 **token 只活在内存里**：外壳生成一个随机 token，用 `VRA_API_TOKEN` 传给编排器，
 *    自己留一份给请求补 Authorization 头。**不落盘、不进渲染进程。**
 *    （开发期 Vite 是从 `.local/api.token` 读的；装机版连那个文件都不该产生。）
 * 🔴 **端口取 0 让系统分配**：写死端口会在用户已经占用它时启动失败，
 *    而那种失败长得像「产品坏了」。实际端口从编排器的输出里读。
 * 🔴 **上一轮的孤儿要先收掉**。外壳被 `kill -9`（或任何来不及跑退出钩子的死法）时，
 *    子进程会被过继给 init 活下来。它照样握着台账的排他锁 ——
 *    下次打开产品，写台账会莫名其妙地失败，而界面上没有任何线索指向"上一次没退干净"。
 *    ⇒ 启动前按 pidfile 收尸；**收之前必须核对命令行**，pid 是会被系统回收再分配的。
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ShellPaths } from "./paths.ts";

export interface Backend {
  port: number;
  token: string;
  child: ChildProcess;
  /** 最近若干行日志。启动失败时要把它给用户看 —— 不然只能得到一句"启动失败" */
  recentLog: () => string;
  stop: () => void;
}

export const START_TIMEOUT_MS = 60_000;
const LOG_KEEP_LINES = 60;
/** 单次 /health 请求的超时；总期限由 START_TIMEOUT_MS 管 */
const HEALTH_TIMEOUT_MS = 3_000;
/** 子进程 exit 之后再等这么久让管道里的残余日志流出来（close 先到就不等） */
const LOG_DRAIN_MS = 400;
/** 一直没有换行时，攒到这么长就当成一行处理 */
const MAX_PENDING_LINE = 8_192;

/** 编排器启动时打印的监听地址，形如 `http://127.0.0.1:8765` */
const PORT_RE = /http:\/\/127\.0\.0\.1:(\d+)/;

/**
 * 我们启动编排器时**一定**会带的参数。
 * 🔴 spawn 与"认不认得出这个进程"共用同一个常量：分开写迟早漂移，
 *    而漂移的表现是收尸从此静默失效（谁也不会注意到）。
 */
export const PORT_FLAG = "--port";

export interface SpawnDeps {
  spawn: typeof spawn;
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realDeps: SpawnDeps = {
  spawn,
  fetch: (...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

/** 装机版入口是编译好的 js；开发期是 .ts，要 Node 的类型剥离 */
export function nodeArgsFor(entry: string): string[] {
  return path.extname(entry) === ".ts" ? ["--experimental-strip-types", entry] : [entry];
}

export async function startBackend(
  paths: ShellPaths,
  opts: {
    nodeExec?: string;
    deps?: Partial<SpawnDeps>;
    env?: NodeJS.ProcessEnv;
    /**
     * spawn 成功的**那一刻**回调，早于"服务能用了"。
     * 🔴 调用方必须靠它拿到子进程：从 spawn 到 /health 通，中间有几百毫秒到几十秒，
     *    这期间用户按 Cmd-Q 的话，只认返回值的清理逻辑**找不到这个子进程**，它会活下来
     *    继续占着排他锁（Codex shell-r1 P2）。
     */
    onSpawn?: (child: ChildProcess) => void;
    /** 单次 /health 的超时（测试用；默认 HEALTH_TIMEOUT_MS）*/
    healthTimeoutMs?: number;
  } = {},
): Promise<Backend> {
  const d = { ...realDeps, ...opts.deps };
  const token = crypto.randomBytes(24).toString("hex");

  fs.mkdirSync(paths.dataRoot, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    VRA_API_TOKEN: token,
    VRA_REPO_ROOT: paths.repoRoot,
    VRA_DATA_ROOT: paths.dataRoot,
    VRA_CODEX_HOME: paths.codexHome,
    VRA_PYTHON: paths.python,
    // 🔴 **别让 Python 往 App 包里写 .pyc**：包是已签名的，写进去当场破坏签名
    //    （实测跑两次业务写进 505 个 .pyc，`codesign -v --strict` 立刻报
    //    `a sealed resource is missing or invalid`）。
    // ⚠️ 这是**第二道**防线：第一道是装配时用 hash 型字节码缓存
    //    （`--invalidation-mode unchecked-hash`），让 Python 压根不需要重新编译。
    //    这一道兜的是"某个模块没被预编到"的漏网情形 —— 代价只是那个模块每次现编。
    PYTHONDONTWRITEBYTECODE: "1",
    ...(paths.enginePath ? { VRA_CODEX_PATH: paths.enginePath } : {}),
    // 用 Electron 自带的 Node 跑子进程时必须置位,否则它会当成 Electron 再开一个窗口
    ELECTRON_RUN_AS_NODE: "1",
  };

  const child = d.spawn(
    opts.nodeExec ?? process.execPath,
    [...nodeArgsFor(paths.orchestratorEntry), PORT_FLAG, "0"],
    { env, cwd: paths.repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  opts.onSpawn?.(child);

  // 记下 pid 供下次启动收尸。写失败不算致命（收尸是兜底，不是主路径）
  try {
    fs.mkdirSync(paths.shellStateDir, { recursive: true });
    fs.writeFileSync(path.join(paths.shellStateDir, PID_FILE), `${child.pid ?? ""}\n`, "utf8");
  } catch { /* 兜底机制自身失败不该拦住启动 */ }

  const lines: string[] = [];
  let portFromLog: number | null = null;
  /**
   * 🔴 **按行攒，不按 chunk 攒**。stdout 是字节流，`http://127.0.0.1:49152` 完全可能被拆成
   *    `http://127.0.0.` + `1:49152\n` 两次 data —— 各自都匹配不上，于是"后端明明起来了，
   *    外壳等满 60 秒把它杀掉，还说没有应答"。
   * 🔴 端口**只从完整行里认**：拿半行去匹配会从 `…:512` 里抠出一个 512 来，绑到一个错端口上，
   *    那比等超时糟得多。行一直不来就走超时那条路，日志里带上残段。
   */
  const pushLine = (line: string) => {
    if (!line.trim()) return;
    lines.push(line);
    if (lines.length > LOG_KEEP_LINES) lines.shift();
    const m = PORT_RE.exec(line);
    if (m && portFromLog === null) portFromLog = Number(m[1]);
  };
  /**
   * 🔴 **每条流一个缓冲**。stdout 与 stderr 是两条独立的字节流，共用一个残段缓冲会把
   *    "stdout 的半行 + stderr 的一整行" 拼成一行不存在的东西 —— 轻则端口认不出来
   *    （白等 60 秒再把健康的后端杀掉），重则拼出一个错误的端口号。
   */
  const tails: (() => string)[] = [];
  const makeCollector = () => {
    let pending = "";
    tails.push(() => pending);
    return (chunk: Buffer | string) => {
      pending += String(chunk);
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) pushLine(line);
      // 一直没有换行也不能无限攒（那是内存泄漏，也让日志看不到东西）
      if (pending.length > MAX_PENDING_LINE) { pushLine(pending); pending = ""; }
    };
  };
  child.stdout?.on("data", makeCollector());
  child.stderr?.on("data", makeCollector());

  /** 未成行的残段也要给出来 —— 失败原因经常就卡在最后半行上 */
  const recentLog = () => [...lines, ...tails.map((t) => t().trim())].filter(Boolean).join("\n");

  /**
   * 🔴 `spawn` 失败（可执行文件不在 / 没有执行位 / cwd 不存在）是**异步的 `error` 事件**，
   *    不是抛出来的异常。ChildProcess 没有 `error` 监听时，Node 会把它升级成未捕获异常 ——
   *    主进程直接崩，窗口什么都不显示。
   */
  let spawnError: Error | null = null;
  child.on("error", (e) => { spawnError = e; });

  // 🔴 子进程提前退出要**立刻**知道 —— 否则白等满 60 秒才报「超时」，
  //    而真实原因（比如缺密钥）第一行就打出来了，「超时」把它盖掉了
  let exited: { code: number | null; signal: string | null } | null = null;
  let exitedAt = 0;
  let closed = false;
  child.on("exit", (code, signal) => { exited = { code, signal }; exitedAt = d.now(); });
  // `close` 在 stdio 全部关闭后才来 —— ⚠️ 只等 `exit` 就抛的话，最后几行 stderr
  // 还在管道里没被读出来，用户看到的是"(没有任何输出)"，而真正的原因就在那几行里。
  child.on("close", () => { closed = true; });

  const deadline = d.now() + START_TIMEOUT_MS;
  while (d.now() < deadline) {
    if (spawnError !== null) {
      const e: Error = spawnError;
      throw new Error(`起不了编排器进程：${e.message}\n（命令：${opts.nodeExec ?? process.execPath}）`);
    }
    if (exited !== null && (closed || d.now() - exitedAt > LOG_DRAIN_MS)) {
      const e: { code: number | null; signal: string | null } = exited;
      throw new Error(`编排器启动即退出（code=${e.code} signal=${e.signal}）：\n${recentLog() || "(没有任何输出)"}`);
    }
    if (portFromLog !== null) {
      try {
        // ⚠️ 单次请求必须有超时：端口收得下连接却永远不回应答时，
        //    `await fetch` 会一直挂着 —— 外层那个 60 秒的期限根本轮不到判断。
        const res = await d.fetch(`http://127.0.0.1:${portFromLog}/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS),
        });
        if (res.ok) return { port: portFromLog, token, child, recentLog, stop: () => stopChild(child) };
      } catch {
        /* 还没监听上 / 这次没答上来，继续等 */
      }
    }
    await d.sleep(150);
  }

  stopChild(child);
  throw new Error(`编排器 ${START_TIMEOUT_MS / 1000} 秒内没有应答。最近输出：\n${recentLog() || "(没有任何输出)"}`);
}

/**
 * 关掉子进程。
 * ⚠️ 先 SIGTERM 给它把文件写完的机会 —— 台账是「读改写 + 排他锁」，硬杀会留下锁残留；
 *    宽限期过了再 SIGKILL。
 */
export function stopChild(child: ChildProcess, graceMs = 3000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* 已经没了 */
  }
  const t = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }, graceMs);
  if (typeof t.unref === "function") t.unref();
  child.once("exit", () => clearTimeout(t));
}

/** pidfile：外壳记下"我拉起的那个后端"，供下次启动收尸 */
export const PID_FILE = "backend.pid";

/** SIGTERM 之后给它多久把文件写完 */
export const REAP_GRACE_MS = 3000;
/** SIGKILL 之后再等多久确认它真的没了（信号送达 ≠ 进程已从进程表消失）*/
export const KILL_CONFIRM_MS = 500;

export interface ReapDeps {
  readText: (p: string) => string | null;
  /** 进程活着吗（`process.kill(pid, 0)` 的封装）*/
  alive: (pid: number) => boolean;
  /** 该进程的完整命令行；取不到返回 null */
  commandOf: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  remove: (p: string) => void;
  /** 同步等一小会儿（测试注入成空实现，免得每跑一次测试就真等 3 秒）*/
  sleep: (ms: number) => void;
  now: () => number;
}

export const realReapDeps: ReapDeps = {
  readText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  commandOf: (pid) => {
    try {
      // 🔴 locale 钉死成 C：`ps` 会**按 locale 决定要不要转义非 ASCII 字节**
      //    （默认 locale 下中文路径打成 `0M-cM^@M^A…`，en_US.UTF-8 下又原样打）。
      //    与其依赖用户的 locale，不如钉死成一种行为，再用只认 ASCII 片段的比法（见 commandMatchesEntry）。
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", env: { LC_ALL: "C" } }).trim() || null;
    } catch {
      return null;  // 进程没了 / ps 不可用：当作"认不出来"，宁可不杀
    }
  },
  kill: (pid, signal) => { try { process.kill(pid, signal); } catch { /* 已经没了 */ } },
  remove: (p) => { try { fs.rmSync(p); } catch { /* 本来就没有 */ } },
  sleep: sleepSync,
  now: () => Date.now(),
};

/**
 * 命令行看着像不像"跑着我们这个入口"。
 *
 * 🔴 不能直接 `cmd.includes(entry)`：安装路径里只要有一个非 ASCII 字符（中文目录名很常见），
 *    `ps` 就会把那几个字节转义掉，整串永远对不上 —— 表现是**收尸永远不生效、也不报错**，
 *    只有在中文路径的机器上才看得见。（这台机器的路径带中文，正是靠它才发现的。）
 * ⇒ 把入口路径按非 ASCII 处切成若干片段，要求它们**按顺序**都出现在命令行里。
 *    纯 ASCII 路径退化成一次完整子串匹配，一点没放松。
 * ⚠️ 诚实说明：这只是"pid 被系统回收给别人"的护栏，不是身份证明 ——
 *    同一产品的另一份安装理论上也能匹配上。pid 本身来自我们自己写的 pidfile，
 *    这一层只负责挡住"这个数字现在是别人了"。
 */
export function commandMatchesEntry(cmd: string, entry: string): boolean {
  const parts = entry.split(/[^\x20-\x7E]+/).filter((p) => p.length >= 3);
  if (!parts.length) return false;   // 整条路径都是非 ASCII：认不出来就不杀
  let at = 0;
  for (const part of parts) {
    const i = cmd.indexOf(part, at);
    if (i < 0) return false;
    at = i + part.length;
  }
  /**
   * 🔴 光"命令行里出现过这条路径"是不够的：`vim /…/api.ts`、`grep -r … /…/api.ts`
   *    统统能匹配上，然后我们就朝一个正在编辑源码的编辑器开枪。
   *    ⇒ 还要求路径**后面**跟着我们启动时一定会带的参数（见 PORT_FLAG）——
   *    这是"它被当作入口执行"的结构性证据，不是"它被当作参数提到"。
   */
  return cmd.indexOf(PORT_FLAG, at) >= 0;
}

/**
 * 收掉上一轮遗留的后端。返回一句人话说明做了什么（没做事就返回 null）。
 *
 * 🔴 **认不出来就不杀**：pid 会被系统回收再分配，照着一个陈旧的数字开枪，
 *    打中的可能是用户正在用的任何程序。判据 = 命令行里含**我们的编排器入口路径**
 *    （见 commandMatchesEntry）；对不上就只删 pidfile。
 * ⚠️ **判不出"是不是这个数据根的"**：数据根只在子进程的环境变量里，不在命令行上。
 *    `ps -E` 能连环境一起打出来，但那会把 API key 一并读进内存 —— 不值得，所以不做。
 *    ⇒ 残余风险：pid 被回收、且新主人恰好是**同一份源码的另一个实例**时会被误杀。
 *    pid 本身来自我们自己写在这个数据根下的 pidfile，这一层只负责挡住"这个数字现在是别人了"。
 */
export function reapStaleBackend(pidFile: string, entry: string, deps: ReapDeps = realReapDeps): string | null {
  const raw = deps.readText(pidFile);
  if (raw === null) return null;
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 1) { deps.remove(pidFile); return null; }
  if (!deps.alive(pid)) { deps.remove(pidFile); return null; }

  const cmd = deps.commandOf(pid);
  if (!cmd || !commandMatchesEntry(cmd, entry)) {
    // 这个 pid 已经是别人了（或者认不出来）。**不杀**，只把过期的 pidfile 删掉。
    deps.remove(pidFile);
    return null;
  }

  deps.kill(pid, "SIGTERM");
  const deadline = deps.now() + REAP_GRACE_MS;
  while (deps.now() < deadline && deps.alive(pid)) {
    // 同步等：这一步发生在开窗口之前，几十毫秒的阻塞看不出来，
    // 而"没收干净就往下走"会直接撞上排他锁
    deps.sleep(60);
  }
  if (deps.alive(pid)) {
    /**
     * 🔴 补刀之前**再核一次身份**。它刚收到 SIGTERM 就退了，而 pid 在这三秒里被系统
     *    分配给了别的程序 —— 这时 `alive(pid)` 是真的，开枪打中的却是别人。
     *    （SIGTERM 那一枪之前核过一次，不代表 SIGKILL 这一枪也核过。）
     */
    const again = deps.commandOf(pid);
    if (!again || !commandMatchesEntry(again, entry)) { deps.remove(pidFile); return null; }
    deps.kill(pid, "SIGKILL");
    // ⚠️ 信号发出去不等于进程已经从进程表里消失，还要几毫秒。
    //    立刻判一次就说"杀不掉"，是把一次正常的收尸报成失败。
    const hard = deps.now() + KILL_CONFIRM_MS;
    while (deps.now() < hard && deps.alive(pid)) deps.sleep(30);
  }
  /**
   * 🔴 **杀不掉就别说杀掉了，也别删 pidfile**。`kill` 把权限错误一类的异常吞掉了，
   *    这里只能靠"它还活着吗"来判断。报成功而实际没死 = 用户看到一句错误的解释，
   *    旧进程仍握着锁让新后端起不来；再把唯一的线索（pidfile）删掉，下次连重试的机会都没有。
   */
  if (deps.alive(pid)) return `上一次的本机服务（pid ${pid}）杀不掉，可能要手动结束它`;
  deps.remove(pidFile);
  return `收掉了上一次没退干净的本机服务（pid ${pid}）`;
}

/** 同步睡一小会儿（Atomics.wait 在 Node 主线程是允许的；比忙等省 CPU、比 spawn 一个 sleep 干净）*/
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
