/**
 * Electron 主进程 —— 外壳的装配根。
 *
 * 它替用户做了开发期需要两个终端才能做的事：起本机编排器、把界面装进窗口。
 * 除此之外**不做业务**：所有能力都在编排器里，外壳只负责"让它跑起来、让人看得见"。
 *
 * ## 顺序有硬约束（写错了不会报错，只会行为诡异）
 *
 * 1. `registerSchemesAsPrivileged` **必须在 app ready 之前** —— ready 之后调用无效果，
 *    表现是 `app://` 变成一个没有 origin、fetch 不了、History API 用不了的怪协议，而不是报错。
 * 2. `app.setPath("userData", …)` 必须在**单实例锁之前** —— 锁就挂在 userData 上。
 *    顺序反了会拿到"另一把锁"，两个实例同时对着同一个数据根跑。
 * 3. `protocol.handle` 必须在 ready **之后**。
 *
 * ## 三层报错通道，一层比一层原始
 *
 * | 什么坏了 | 用哪层说 |
 * |---|---|
 * | 后端起不来 / 安装缺件 | 启动页（`__shell/boot`，能列清单、能显示子进程日志）|
 * | 启动页自己都加载不了 | **系统原生对话框**（渲染进程这条路已经断了）|
 * | ready 之前就炸了 | 同上，且此时还没有窗口 |
 *
 * 🔴 后两层不是装饰。ready 之前的代码（解析路径、建目录、设 userData）一旦抛，
 *    默认结果是**主进程直接退出**：用户看到的是 Dock 图标闪一下就没了，
 *    没有任何一个字说明原因。
 *
 * ## 单实例 = 数据根级别，不是"应用级别"
 *
 * 台账是"读改写 + 排他锁"，真正的互斥来自**一个数据根只有一个进程**。
 * 所以 userData 挂在数据根底下：换数据根（`VIBE_DATA_ROOT`）＝另一把锁，可以并行跑；
 * 同一个数据根 ＝ 同一把锁，开发期的外壳与装机版也互斥。
 */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BrowserWindow, app, dialog, protocol, shell } from "electron";

import { type BootState, initialBootState, patchState, withStep } from "./boot.ts";
import { createShellHandler } from "./handler.ts";
import { decideNavigation } from "./navigation.ts";
import { PID_FILE, type Backend, reapStaleBackend, startBackend, stopChild } from "./orchestrator.ts";
import { type ShellPaths, preflight, resolveDataRoot, resolvePaths } from "./paths.ts";
import { createHandler, realFsDeps } from "./proxy.ts";

const SCHEME = "app";
const HOST = "vibe";
const BOOT_URL = `${SCHEME}://${HOST}/__shell/boot`;
const UI_URL = `${SCHEME}://${HOST}/`;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 最后一条报错通道：系统原生对话框。用在"渲染进程这条路已经不可用"的时候。
 *
 * 🔴 用 `showMessageBox`（异步）而不是 `showErrorBox`（同步阻塞）：后者会把主进程的事件循环
 *    卡在那儿直到用户点确定 —— 报错顺手把进程按住，是最不该有的副作用。
 * ⚠️ 代价：`showMessageBox` 要 app ready 之后才能用。目前所有调用点都在 ready 之后
 *    （ready 之前的失败走启动页那条路，见 bootstrapProblems）。
 */
/**
 * 🔴 去重按**内容**，不按"弹过没有"。一个全局布尔会让第一次失败之后的所有致命错误
 *    全部哑掉 —— 关掉窗口再从 Dock 打开、后来又坏在别的地方，用户一句提示都收不到。
 */
let lastDialog = "";
/** 这一次加载启动页的失败，已经跟用户说过了吗（`did-fail-load` 与 loadURL 的 reject 会各来一次）*/
let bootFailureReported = false;
function fatalDialog(title: string, body: string): void {
  const key = `${title}\u0000${body}`;
  if (key === lastDialog) return; // 同一条失败弹一次就够了
  lastDialog = key;
  try {
    void dialog.showMessageBox({ type: "error", title, message: title, detail: body, buttons: ["好"] });
  } catch {
    /* 连对话框都弹不出来就真没辙了；至少别在这里再抛一次 */
  }
}

// ── 1. ready 之前必须做完的 ────────────────────────────────────────────────

/**
 * `standard` 让它有正常的 origin / 相对路径 / History API；
 * `secure` 让它算作安全上下文；`supportFetchAPI` + `corsEnabled` 让页面能 fetch 自己；
 * `stream` 让处理器可以直接把后端的响应流转出去（不必整段读进内存）。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function describeDataRoot(): string {
  try {
    return resolveDataRoot();
  } catch {
    return process.env.VIBE_DATA_ROOT ?? "~/.vibe-research";
  }
}

/**
 * 🔴 这一段**允许失败，但不许把程序带走**。
 *    `VIBE_DATA_ROOT` 指到一个同名文件、家目录不可写、setPath 被拒 —— 都会抛在这里，
 *    而这里比窗口早。抛出去 = 闪退无提示；接住 = 一会儿在启动页上把原因写清楚。
 */
let paths: ShellPaths | null = null;
let bootstrapProblems: string[] = [];
try {
  paths = resolvePaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // 开发期：`electron .` 在 shell/ 下跑，appPath 就是 shell/，产品根是它的上一级
    repoRootForDev: path.dirname(app.getAppPath()),
  });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  // userData 挂到数据根底下：一个数据根一把锁（见文件头）
  app.setPath("userData", paths.shellStateDir);
} catch (e) {
  paths = null;
  bootstrapProblems = [
    `准备数据目录失败：${msg(e)}`,
    `数据目录是 ${describeDataRoot()} —— 确认它可写，并且不是一个同名的普通文件`,
  ];
}

/**
 * 单实例锁**只在数据根准备好时才上**。
 *
 * 🔴 上面那一步失败时 `paths` 是 null，锁会落回 Electron 的默认 userData —— 那把锁保护的
 *    根本不是我们的数据根，却足以让这个"本该显示错误"的实例在这里静默退出。
 *    结果又回到了要修的那件事：闪退，一个字都没有。
 *    没有数据根 = 没有要互斥的东西 ⇒ 不上锁，让它活着把原因说完。
 */
if (paths && !app.requestSingleInstanceLock()) {
  // 已经有一个实例在跑同一个数据根。第二个立刻退出，由第一个把窗口调到前面来。
  app.quit();
  process.exit(0);
}

// ── 2. 状态 ───────────────────────────────────────────────────────────────

let state: BootState = initialBootState(app.getName());
/** spawn 的那一刻就有（早于"服务能用了"）—— 清理只认它 */
let backendChild: ChildProcess | null = null;
/** `/health` 真 200 之后才有 */
let backend: Backend | null = null;
let win: BrowserWindow | null = null;

const onBootPage = (): boolean =>
  win !== null && !win.isDestroyed() && win.webContents.getURL().startsWith(BOOT_URL);

/** 窗口现在落在**界面**上吗（启动页也在同一个源下，要排掉）*/
const onUiPage = (w: BrowserWindow): boolean => {
  const at = w.webContents.getURL();
  return at.startsWith(UI_URL) && !at.startsWith(BOOT_URL);
};

function setState(next: BootState): void {
  state = next;
  // 启动页自己也在轮询；这里额外推一把让变化立刻可见。
  // 页面按 revision 判重，重画之后不会再触发一次，不会来回刷。
  // 🔴 `ready` 不重画：这一刻紧接着就是"导航到界面"，再 reload 一次等于两条导航抢窗口。
  //    实测（启动页故意做坏时）能把界面挤掉、停在启动页上 —— 而且看起来像"界面加载失败"。
  if (next.phase !== "ready" && onBootPage()) win!.webContents.reload();
}

function fail(problems: string[], log = ""): void {
  const wasOnBoot = onBootPage();
  setState(patchState(state, { phase: "failed", problems, log }));
  // 不在启动页上（比如界面加载到一半失败）就把用户带回去看原因
  if (!wasOnBoot && win && !win.isDestroyed()) void navigate(win, BOOT_URL);
}

function stopBackend(): void {
  if (backendChild) stopChild(backendChild);
  backendChild = null;
  backend = null;
}

// ── 3. 窗口 ───────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    // 与启动页同色：不给白底闪一下的机会（界面默认深色）
    backgroundColor: "#0b0d11",
    title: app.getName(),
    webPreferences: {
      // 🔴 渲染进程一点 Node 都不给：界面是纯网页，它需要的一切都从 app:// 走。
      //    token 只在主进程闭包里，连 preload 桥都不需要 —— 没有桥就没有桥可以被滥用。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // 新窗口 = 用户又试了一次。去重记录清零，否则"关掉再从 Dock 打开"那次会一声不吭。
  lastDialog = "";

  w.once("ready-to-show", () => w.show());

  // 外部链接交给系统浏览器；其余一律挡（见 navigation.ts）
  w.webContents.setWindowOpenHandler(({ url }) => {
    const d = decideNavigation(url, { scheme: SCHEME, host: HOST });
    if (d.action === "external") void shell.openExternal(d.url);
    // 同源也不给开新窗口：本应用是单窗口，页内跳转走 will-navigate 那条路
    return { action: "deny" };
  });

  w.webContents.on("will-navigate", (event, url) => {
    const d = decideNavigation(url, { scheme: SCHEME, host: HOST });
    if (d.action === "allow") return;
    event.preventDefault();
    if (d.action === "external") void shell.openExternal(d.url);
  });

  /**
   * 加载失败的两种，处理方式完全不同：
   * - 界面加载不起来 → 退回启动页把原因写清楚（启动页还能用）；
   * - **启动页自己**加载不起来 → 渲染进程这条路已经断了，只能上系统对话框。
   *   🔴 这一支原来只是 `return`：结果是一个空窗口 + 一行没人看的日志。
   */
  w.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ABORTED，被新导航取代，正常
    if (validatedURL.startsWith(BOOT_URL)) {
      bootFailureReported = true;   // 这一次已经说过了，别让 navigate 的 catch 再弹一个
      fatalDialog(
        `${app.getName()} 没能显示启动界面`,
        [`${errorDescription}（${errorCode}）`, "", ...state.problems, state.log].filter(Boolean).join("\n"),
      );
      return;
    }
    fail(
      [
        `界面加载失败（${errorDescription} ${errorCode}）：${validatedURL}`,
        app.isPackaged ? "安装包可能不完整，重装一次" : "先跑 npm run build --prefix desktop 生成界面产物",
      ],
      state.log,
    );
  });

  w.on("closed", () => {
    win = null;
  });
  return w;
}

/**
 * 导航，且**无论成败都把窗口显示出来**。
 * 🔴 `show:false` + `ready-to-show` 是防白屏的标准做法，但它有个前提：页面得加载成功。
 *    加载失败时那个事件可能永远不来，窗口就永久隐藏 —— 用户什么都看不到，
 *    连"没能启动"四个字都看不到。
 * 🔴 也**绝不能把异常抛给调用方**：`await loadURL` 失败一旦冒泡，后面的 `boot()` 整个不执行
 *    （既不体检也不起后端），而用户只看到一个空窗口。
 */
async function navigate(w: BrowserWindow, url: string): Promise<void> {
  if (url.startsWith(BOOT_URL)) bootFailureReported = false;   // 新的一次尝试
  try {
    await w.loadURL(url);
  } catch (e) {
    /**
     * 界面那一支由 `did-fail-load` 负责说明；启动页这一支只剩原生对话框。
     * ⚠️ 但 `did-fail-load` 通常**已经**为同一次失败弹过一个了（loadURL 的 reject
     *    就是在它之后触发的），两边正文还不一样 —— 按内容去重挡不住，会连着弹两个框。
     *    ⇒ 靠这个标志判"这一次说过没有"。
     */
    if (url.startsWith(BOOT_URL) && !bootFailureReported) {
      bootFailureReported = true;
      fatalDialog(`${app.getName()} 没能显示启动界面`, msg(e));
    }
  } finally {
    if (!w.isDestroyed() && !w.isVisible()) w.show();
  }
}

// ── 4. 启动流程 ───────────────────────────────────────────────────────────

/** 同一时刻只允许一条启动流程（重开窗口会再走一遍，两条并行会起出两个后端）*/
let booting = false;

async function boot(): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    await bootOnce();
  } finally {
    booting = false;
  }
}

async function bootOnce(): Promise<void> {
  setState(withStep(state, "preflight", { state: "doing" }));
  if (!paths) {
    setState(withStep(state, "preflight", { state: "failed" }));
    fail(bootstrapProblems);
    return;
  }
  const problems = preflight(paths);
  if (problems.length) {
    setState(withStep(state, "preflight", { state: "failed" }));
    fail(problems);
    return;
  }
  setState(withStep(state, "preflight", { state: "done" }));

  // 上一轮没退干净的后端要先收掉：它还握着排他锁（见 orchestrator.reapStaleBackend）
  const reaped = reapStaleBackend(path.join(paths.shellStateDir, PID_FILE), paths.orchestratorEntry);
  setState(withStep(state, "backend", { state: "doing", detail: reaped ?? "首次启动会慢一些" }));
  const t0 = Date.now();
  try {
    backend = await startBackend(paths, { onSpawn: (c) => { backendChild = c; } });
  } catch (e) {
    // detail 清掉：失败之后还挂着"首次启动会慢一些"读着像它还在等
    setState(withStep(state, "backend", { state: "failed", detail: undefined }));
    fail(["本机服务没能起来。下面是它自己打出来的最后几行 —— 原因通常就在里面。"], msg(e));
    return;
  }
  setState(withStep(state, "backend", { state: "done", detail: `${((Date.now() - t0) / 1000).toFixed(1)} 秒` }));

  /**
   * 🔴 后端**起来之后**也会死（崩溃、被外部杀掉、OOM）。不管这件事的话，
   *    `backend` 会一直是真的：界面上每个请求都变成 502，重开窗口还照样直奔界面 ——
   *    应用一直连着一个已经不存在的端口，只能整个退出重来。
   */
  const be = backend;
  backendChild?.once("exit", (code, signal) => {
    if (backend !== be) return;   // 我们自己停的（stopBackend 会先把它置空）
    backend = null;
    backendChild = null;
    fail(
      [`本机服务意外退出（code=${code} signal=${signal}）。关掉窗口再打开会重新启动它。`],
      be.recentLog(),
    );
  });

  setState(withStep(state, "ui", { state: "done" }));
  setState(patchState(state, { phase: "ready" }));
  if (!win || win.isDestroyed()) return;
  await navigate(win, UI_URL);
  /**
   * 🔴 **正面确认界面真的接管了窗口**，而不是靠 `did-fail-load` 会不会来。
   *    导航被取消、被另一条导航顶掉这类情况不产生 did-fail-load，
   *    而 `phase` 已经是 ready —— 启动页那边看到 ready 就不再自我刷新，
   *    于是窗口会永久停在"正在启动"上。这一句把那种沉默变成一条明确的失败。
   */
  // 🔴 `state.phase === "ready"` 这个条件不能省：`did-fail-load` 已经把**具体**原因
  //    （错误码、URL、怎么办）写进去并把 phase 改成 failed 了；这里再 fail 一次
  //    会把它盖成一句没有信息量的通用话 —— 这正是"正面确认"本身引入的回归。
  // 🔴 判据是"**落在界面上**"，不是"不在启动页上"：被顶掉的导航可能停在 about:blank
  //    或一个错误页，那两种都不是启动页，排除法会把它们当成功。
  if (state.phase === "ready" && !win.isDestroyed() && !onUiPage(win)) {
    fail(["界面没能接管窗口（导航被取消或被顶掉）。关掉窗口重开一次试试。"], state.log);
  }
}

async function start(): Promise<void> {
  const p = paths;
  protocol.handle(
    SCHEME,
    createShellHandler({
      state: () => state,
      // 路径都没解析出来时，除了外壳自己那几条路由，其余一律 404 ——
      // 拿一个空 uiDir 去查文件会解析到进程当前目录上去
      inner: p
        ? createHandler({
            // 启动完成前 backend 为 null，proxy 会回 503 而不是把请求当成"没数据"
            backend: () => (backend ? { port: backend.port, token: backend.token } : null),
            uiDir: p.uiDir,
            // ⚠️ 用全局 fetch（undici），**不用 `net.fetch`**：后者走 Electron 的会话与系统代理配置，
            //    而我们打的是 127.0.0.1 —— 让系统代理插进本机回环通信是纯粹的风险，没有收益。
            fetch: (...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a),
            ...realFsDeps,
          })
        : async () => new Response("Not Found", { status: 404 }),
    }),
  );

  win = createWindow();
  await navigate(win, BOOT_URL);
  await boot();
}

app.whenReady().then(start).catch((e) => {
  // 走到这里说明连"把失败显示出来"都失败了
  fatalDialog(`${app.getName()} 启动失败`, msg(e));
});

/**
 * 重新开窗（Dock 图标 / 第二个实例）。
 *
 * 🔴 去哪儿由"**后端还在不在**"决定，不由 `state.phase` 决定。
 *    phase 一旦被一次偶发的界面加载失败改成 failed，就再也不会自己变回来 ——
 *    后端明明还健康，应用却从此永远只显示失败页，只能整个退出重开。
 *    后端在 = 值得再试一次界面；真再失败一次，新的原因会重新写进来。
 */
function reopen(): void {
  win = createWindow();
  if (backend) {
    setState(patchState(state, { phase: "ready", problems: [], log: "" }));
    void navigate(win, UI_URL);
    return;
  }
  // 没有后端就**真的重来一遍** —— 失败页上写着"重开会重新启动它"，那句话得是真的。
  setState(initialBootState(app.getName()));
  void navigate(win, BOOT_URL).then(boot);
}

app.on("second-instance", () => {
  if (!win || win.isDestroyed()) {
    reopen();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on("activate", () => {
  if (win && !win.isDestroyed()) return;
  reopen();
});

app.on("window-all-closed", () => {
  // macOS 惯例：关窗不退出（Dock 图标还在，点一下回来）。后端跟着留着 ——
  // 正在跑的研究不该因为关了个窗口就被掐掉。
  if (process.platform !== "darwin") app.quit();
});

/** 退出时收子进程：先 SIGTERM 给它把文件写完（有排他锁），宽限期后 SIGKILL */
app.on("before-quit", stopBackend);

/**
 * 最后一道：主进程无论怎么走到尽头都别留下孤儿。
 * ⚠️ 这里只能做同步的事，所以直接 SIGKILL —— 走到这一步已经没有优雅退出的机会了。
 * ⚠️ 主进程被 `kill -9` 时这一句也不会执行；那种情况下子进程会变成孤儿，
 *    靠下次启动的 `reapStaleBackend` 收拾。
 */
process.on("exit", () => {
  backendChild?.kill("SIGKILL");
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => app.quit());
}
