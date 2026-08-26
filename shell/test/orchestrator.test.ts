import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PID_FILE, commandMatchesEntry, nodeArgsFor, reapStaleBackend, startBackend, type ReapDeps } from "../src/orchestrator.ts";
import { resolvePaths } from "../src/paths.ts";

test("装机版跑编译后的 js（不加类型剥离参数），开发期跑 .ts（要加）", () => {
  assert.deepEqual(nodeArgsFor("/x/api.js"), ["/x/api.js"]);
  assert.deepEqual(nodeArgsFor("/x/api.ts"), ["--experimental-strip-types", "/x/api.ts"]);
});

// ── reapStaleBackend ────────────────────────────────────────────────────
let clock = 0;
function reapDeps(over: Partial<ReapDeps> & { killed?: string[] }): ReapDeps & { killed: string[] } {
  const killed = over.killed ?? [];
  clock = 0;   // 假时钟：每问一次前进 1 秒，3 秒宽限期几步就走完
  return {
    readText: over.readText ?? (() => null),
    alive: over.alive ?? (() => false),
    commandOf: over.commandOf ?? (() => null),
    kill: over.kill ?? ((pid, sig) => { killed.push(`${pid}:${sig}`); }),
    remove: over.remove ?? (() => {}),
    sleep: over.sleep ?? (() => {}),
    now: over.now ?? (() => (clock += 1000)),
    killed,
  };
}

test("没有 pidfile：什么都不做", () => {
  const d = reapDeps({});
  assert.equal(reapStaleBackend("/tmp/x.pid", "/app/api.js", d), null);
  assert.deepEqual(d.killed, []);
});

test("pid 已经不在了：只删 pidfile，不开枪", () => {
  const removed: string[] = [];
  const d = reapDeps({ readText: () => "4242\n", alive: () => false, remove: (p) => { removed.push(p); } });
  assert.equal(reapStaleBackend("/tmp/x.pid", "/app/api.js", d), null);
  assert.deepEqual(d.killed, []);
  assert.deepEqual(removed, ["/tmp/x.pid"]);
});

test("🔴 pid 被系统回收给了别的程序：认不出命令行就不杀", () => {
  const d = reapDeps({
    readText: () => "4242",
    alive: () => true,
    commandOf: () => "/Applications/SomethingElse.app/Contents/MacOS/SomethingElse",
  });
  assert.equal(reapStaleBackend("/tmp/x.pid", "/app/orchestrator/src/api.js", d), null);
  assert.deepEqual(d.killed, [], "认不出来就绝不能开枪");
});

test("命令行对得上：SIGTERM，赖着不死就补 SIGKILL", () => {
  const d = reapDeps({
    readText: () => "4242",
    alive: () => true,   // 一直活着 = 宽限期走满
    commandOf: () => "/x/Electron --experimental-strip-types /app/orchestrator/src/api.js --port 0",
  });
  const msg = reapStaleBackend("/tmp/x.pid", "/app/orchestrator/src/api.js", d);
  assert.match(msg ?? "", /4242/);
  assert.deepEqual(d.killed, ["4242:SIGTERM", "4242:SIGKILL"]);
});

test("SIGTERM 之后就死了：不补 SIGKILL", () => {
  let calls = 0;
  const d = reapDeps({
    readText: () => "4242",
    alive: () => { calls += 1; return calls <= 1; },   // 第一次判活，之后就死了
    commandOf: () => "/x/node /app/orchestrator/src/api.js --port 0",
  });
  reapStaleBackend("/tmp/x.pid", "/app/orchestrator/src/api.js", d);
  assert.deepEqual(d.killed, ["4242:SIGTERM"]);
});

test("pidfile 内容不是正经 pid：删掉，不杀（1 号进程更不能碰）", () => {
  for (const raw of ["", "abc", "0", "1", "-5"]) {
    const d = reapDeps({ readText: () => raw, alive: () => true, commandOf: () => "/app/api.js" });
    assert.equal(reapStaleBackend("/tmp/x.pid", "/app/api.js", d), null, raw);
    assert.deepEqual(d.killed, [], raw);
  }
});

// ── startBackend ────────────────────────────────────────────────────────
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; pid: number;
    exitCode: number | null; signalCode: string | null; kill: (s?: string) => boolean;
  };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 9999;
  c.exitCode = null;
  c.signalCode = null;
  c.kill = () => true;
  return c;
}

function tmpPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-shell-"));
  const p = resolvePaths({ packaged: false, resourcesPath: "/unused", repoRootForDev: root, env: { VIBE_DATA_ROOT: path.join(root, "data") } });
  return { root, p };
}

test("等 /health 真 200 才算起来，并把 pid 记下来供下次收尸", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  let health = 0;
  const be = await startBackend(p, {
    deps: {
      spawn: (() => { queueMicrotask(() => child.stderr.emit("data", "[api] listening http://127.0.0.1:51234  token 来源=env\n")); return child; }) as never,
      fetch: (async () => { health += 1; return new Response("{}", { status: health >= 2 ? 200 : 500 }); }) as never,
      now: Date.now,
      sleep: () => Promise.resolve(),
    },
    env: {},
  });
  assert.equal(be.port, 51234);
  assert.equal(be.token.length >= 32, true);
  assert.ok(health >= 2, "第一次 500 应当继续等");
  assert.equal(fs.readFileSync(path.join(p.shellStateDir, PID_FILE), "utf8").trim(), "9999");
});

test("🔴 子进程启动即退出要立刻抛，并把它自己打的话带上（否则白等满 60 秒还只说\"超时\"）", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  await assert.rejects(
    startBackend(p, {
      deps: {
        spawn: (() => {
          queueMicrotask(() => {
            child.stderr.emit("data", "[api] provider.auth=api_key 但环境变量 MIMO_API_KEY 未设置");
            child.emit("exit", 2, null);
          });
          return child;
        }) as never,
        fetch: (async () => new Response("", { status: 200 })) as never,
        now: Date.now,
        sleep: () => Promise.resolve(),
      },
      env: {},
    }),
    /启动即退出.*code=2[\s\S]*MIMO_API_KEY/,
  );
});

test("一直不应答就超时，报文里带最近输出", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  let t = 0;
  await assert.rejects(
    startBackend(p, {
      deps: {
        spawn: (() => { queueMicrotask(() => child.stdout.emit("data", "还在启动\n")); return child; }) as never,
        fetch: (async () => { throw new Error("ECONNREFUSED"); }) as never,
        now: () => (t += 10_000),
        sleep: () => Promise.resolve(),
      },
      env: {},
    }),
    /秒内没有应答[\s\S]*还在启动/,
  );
});

// ── commandMatchesEntry ────────────────────────────────────────────────
const CN_ENTRY = "/Users/simon/Documents/1-Projects/0、投资分析/VR/orchestrator/src/api.ts";
/** `ps` 在 C locale 下把非 ASCII 字节转义成这样（本机实测的形状） */
const CN_PS = "/x/Electron --experimental-strip-types /Users/simon/Documents/1-Projects/0M-cM^@M^AM-fM^JM^U/VR/orchestrator/src/api.ts --port 0";

test("🔴 安装路径带中文时也要认得出来 —— ps 会把那几个字节转义掉，整串永远对不上", () => {
  assert.equal(CN_PS.includes(CN_ENTRY), false, "前提：整串直接比是对不上的");
  assert.equal(commandMatchesEntry(CN_PS, CN_ENTRY), true);
});

test("纯 ASCII 路径退化成完整子串匹配，一点没放松", () => {
  const e = "/opt/VR/orchestrator/src/api.ts";
  assert.equal(commandMatchesEntry(`/x/node ${e} --port 0`, e), true);
  assert.equal(commandMatchesEntry("/x/node /opt/Other/orchestrator/src/api.ts --port 0", e), false);
});

test("片段必须按顺序出现（乱序拼出来的命令行不算数）", () => {
  const e = "/a/中/b/c.ts";
  assert.equal(commandMatchesEntry("/b/c.ts and /a/ --port 0", e), false);
  assert.equal(commandMatchesEntry("/a/ then /b/c.ts --port 0", e), true);
});

test("完全认不出来（命令行是别的程序）→ false", () => {
  assert.equal(commandMatchesEntry("/Applications/Mail.app/Contents/MacOS/Mail", CN_ENTRY), false);
});

test("🔴 监听地址被拆成两次 data 也要认出来（流是按字节切的，不按行）", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  const be = await startBackend(p, {
    deps: {
      spawn: (() => {
        queueMicrotask(() => {
          child.stderr.emit("data", "[api] listening http://127.0.0.");
          child.stderr.emit("data", "1:51999  token 来源=env\n");
        });
        return child;
      }) as never,
      fetch: (async () => new Response("{}", { status: 200 })) as never,
      now: Date.now,
      sleep: () => Promise.resolve(),
    },
    env: {},
  });
  assert.equal(be.port, 51999);
});

test("🔴 半行里的数字不许当端口用（绑错端口比等超时糟得多）", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  let t = 0;
  await assert.rejects(
    startBackend(p, {
      deps: {
        // 只发半行、永远不换行
        spawn: (() => { queueMicrotask(() => child.stderr.emit("data", "[api] listening http://127.0.0.1:512")); return child; }) as never,
        fetch: (async () => { throw new Error("不该走到这里"); }) as never,
        now: () => (t += 10_000),
        sleep: () => Promise.resolve(),
      },
      env: {},
    }),
    /秒内没有应答[\s\S]*127\.0\.0\.1:512/,   // 残段要出现在日志里
  );
});

test("🔴 spawn 失败是异步 error 事件 —— 不接住它，主进程会被未捕获异常带崩", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  await assert.rejects(
    startBackend(p, {
      deps: {
        spawn: (() => { queueMicrotask(() => child.emit("error", new Error("spawn ENOENT"))); return child; }) as never,
        fetch: (async () => new Response("", { status: 200 })) as never,
        now: Date.now,
        sleep: () => Promise.resolve(),
      },
      env: {},
    }),
    /起不了编排器进程[\s\S]*ENOENT/,
  );
});

test("🔴 exit 之后要等管道排空再报错，否则最后几行 stderr 全丢（表现是\"没有任何输出\"）", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  await assert.rejects(
    startBackend(p, {
      deps: {
        spawn: (() => {
          queueMicrotask(() => {
            child.emit("exit", 1, null);                       // exit 先到
            queueMicrotask(() => {                             // 真正的原因随后才流出来
              child.stderr.emit("data", "[api] 缺少某个必需的环境变量\n");
              child.emit("close", 1, null);
            });
          });
          return child;
        }) as never,
        fetch: (async () => new Response("", { status: 200 })) as never,
        now: Date.now,
        sleep: () => Promise.resolve(),
      },
      env: {},
    }),
    /启动即退出[\s\S]*缺少某个必需的环境变量/,
  );
});

test("补刀之前再核一次身份：SIGTERM 后 pid 换了主人就收手，不开第二枪", () => {
  let calls = 0;
  const d = reapDeps({
    readText: () => "4242",
    alive: () => true,
    // 第一次（SIGTERM 前）认得出，第二次（SIGKILL 前）已经是别的程序了
    commandOf: () => (++calls === 1 ? "/x/node /app/orchestrator/src/api.ts --port 0" : "/Applications/Mail.app/Contents/MacOS/Mail"),
  });
  assert.equal(reapStaleBackend("/tmp/x.pid", "/app/orchestrator/src/api.ts", d), null);
  assert.deepEqual(d.killed, ["4242:SIGTERM"], "不该有第二枪");
});

test("🔴 杀不掉就不报成功，也不删 pidfile（删了下次连重试都没有）", () => {
  const removed: string[] = [];
  const d = reapDeps({
    readText: () => "4242",
    alive: () => true,                       // 两枪都没打死
    commandOf: () => "/x/node /app/orchestrator/src/api.ts --port 0",
    remove: (f) => { removed.push(f); },
  });
  const msg = reapStaleBackend("/tmp/x.pid", "/app/orchestrator/src/api.ts", d);
  assert.match(msg ?? "", /杀不掉/);
  assert.deepEqual(removed, [], "杀不掉时 pidfile 要留着");
});

test("🔴 单次 /health 挂住不返回时要能被掐断 —— 否则外层那个 60 秒的期限根本轮不到判断", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  let t = 0;
  let aborts = 0;
  await assert.rejects(
    startBackend(p, {
      healthTimeoutMs: 40,
      deps: {
        spawn: (() => { queueMicrotask(() => child.stderr.emit("data", "[api] listening http://127.0.0.1:51888\n")); return child; }) as never,
        // 永远不应答，只认 abort —— 没有超时的话这个 Promise 永远不 settle
        fetch: ((_u: string, init: { signal?: AbortSignal }) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener("abort", () => { aborts += 1; rej(new Error("aborted")); });
          })) as never,
        now: () => (t += 5_000),
        sleep: () => Promise.resolve(),
      },
      env: {},
    }),
    /秒内没有应答/,
  );
  assert.ok(aborts >= 1, "应当至少被掐断过一次");
});

test("🔴 路径只是被当参数提到（编辑器 / grep）不算 —— 它后面必须跟着我们启动时一定带的参数", () => {
  const e = "/opt/VR/orchestrator/src/api.ts";
  assert.equal(commandMatchesEntry(`vim ${e}`, e), false);
  assert.equal(commandMatchesEntry(`grep -r listening ${e}`, e), false);
  assert.equal(commandMatchesEntry(`tail -f ${e}`, e), false);
  assert.equal(commandMatchesEntry(`/x/node ${e} --port 0`, e), true);
  // --port 出现在路径**之前**也不算（那不是"它被当入口执行"的形状）
  assert.equal(commandMatchesEntry(`/x/node --port 0 ${e}`, e), false);
});

test("🔴 stdout 与 stderr 各自缓冲：两条流交错不许被拼成一行", async () => {
  const { p } = tmpPaths();
  const child = fakeChild();
  // ⚠️ 用假时钟：一旦这条回归，端口认不出来会让它**真等 60 秒**才红 —— 慢的红等于没人看。
  let t = 0;
  const be = await startBackend(p, {
    deps: {
      spawn: (() => {
        queueMicrotask(() => {
          child.stdout.emit("data", "[api] listening http://127.0.0.");   // stdout 半行
          child.stderr.emit("data", "[warn] 某个无关的警告\n");           // stderr 插进来一整行
          child.stdout.emit("data", "1:51777  token 来源=env\n");         // stdout 的后半行
        });
        return child;
      }) as never,
      fetch: (async () => new Response("{}", { status: 200 })) as never,
      now: () => (t += 5_000),
      sleep: () => Promise.resolve(),
    },
    env: {},
  });
  assert.equal(be.port, 51777);
  assert.match(be.recentLog(), /无关的警告/);
});

test("SIGKILL 之后给一小段时间确认，别把一次正常收尸报成\"杀不掉\"", () => {
  const killed: string[] = [];
  let hardKilled = false;
  let lag = 0;
  let clock = 0;
  const d = reapDeps({
    killed,
    readText: () => "4242",
    // SIGTERM 期间一直赖着；SIGKILL 之后还要两拍才从进程表消失
    alive: () => (!hardKilled ? true : lag++ < 2),
    commandOf: () => "/x/node /app/orchestrator/src/api.ts --port 0",
    kill: (pid, sig) => { killed.push(`${pid}:${sig}`); if (sig === "SIGKILL") hardKilled = true; },
    now: () => (clock += 100),
  });
  const msg = reapStaleBackend("/tmp/x.pid", "/app/orchestrator/src/api.ts", d);
  assert.deepEqual(killed, ["4242:SIGTERM", "4242:SIGKILL"]);
  assert.match(msg ?? "", /收掉了/, `不该报成杀不掉：${msg}`);
});
