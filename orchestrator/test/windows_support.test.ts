import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { codexEnvFor, interpreterRoot, makeConfig, normalizeInterpreter } from "../src/config.ts";
import { writeHookContext } from "../src/hooks.ts";
import { privateFilePermissions, restrictPrivateFile } from "../src/fsutil.ts";
import { executableInvocation, findExecutable } from "../src/local_agent_runtime.ts";
import { CodexRunner, codexOptionsFor } from "../src/runner.ts";
import { RunToolsError, listRunFiles, readRunFile, runCalculation, writeStageOutput } from "../src/finance/run_tools_mcp.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = (prefix = "vra-win-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("Windows 安装脚本:优先 3.12 但允许其他受支持 Python 3；doctor 警告不伪装成安装失败", () => {
  const setup = fs.readFileSync(path.join(REPO, "scripts", "setup-windows.ps1"), "utf8");
  assert.match(setup, /py -3\.12 -c/);
  assert.match(setup, /else \{ & py -3 -m venv/);
  assert.match(setup, /sys\.version_info >= \(3, 11\)/);
  assert.match(setup, /\$doctorExit -notin @\(0, 2\)/);
  assert.doesNotMatch(setup, /Assert-NativeSuccess "运行产品体检"/);
});

test("Windows 路径与环境:Scripts venv、反斜杠、用户目录和 PATHEXT 都被保留", () => {
  assert.equal(normalizeInterpreter(" C:\\Users\\Simon\\VRA\\.venv\\Scripts\\python.exe "), "C:\\Users\\Simon\\VRA\\.venv\\Scripts\\python.exe");
  assert.equal(interpreterRoot("C:\\Users\\Simon\\VRA\\.venv\\Scripts\\python.exe"), "C:\\Users\\Simon\\VRA\\.venv");
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot: temp("vra windows data "), executionMode: "controlled_mcp" });
  const env = codexEnvFor(cfg, { PATH: "X", USERPROFILE: "C:\\Users\\Simon", PATHEXT: ".EXE;.CMD", SYSTEMROOT: "C:\\Windows" });
  assert.equal(env.USERPROFILE, "C:\\Users\\Simon");
  assert.equal(env.PATHEXT, ".EXE;.CMD");
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
  assert.equal(cfg.hooksEnabled, false, "Windows 受控模式不依赖 lifecycle hooks");
  assert.doesNotThrow(() => makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot: temp("vra more spaces "), executionMode: "controlled_mcp" }));
  const npmBin = temp();
  const cmd = path.join(npmBin, "claude.cmd");
  const ps1 = path.join(npmBin, "claude.ps1");
  fs.writeFileSync(cmd, "@echo off\r\n");
  fs.writeFileSync(ps1, "& node $PSScriptRoot\\cli.js @args\r\n");
  assert.equal(findExecutable("claude", { PATH: npmBin, PATHEXT: ".EXE;.CMD" }, "win32"), ps1);
  const launch = executableInvocation(ps1, ["--system-prompt", "A&B%PATH%"], { SYSTEMROOT: "C:\\Windows" }, "win32");
  assert.equal(launch.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(launch.args.slice(-2), ["--system-prompt", "A&B%PATH%"], "提示词必须作为独立 argv，不经 cmd.exe 拼接展开");
});

test("Windows 研究线程:Shell / unified exec 全关、只读沙箱、只挂受控 MCP", async () => {
  const codexHome = temp();
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    "[mcp_servers.evil]",
    'url = "https://evil.invalid/mcp"',
    "[profiles.legacy.mcp_servers.\"dotted.name\"]",
    'command = "evil.exe"',
    "",
  ].join("\n"));
  const python = process.platform === "win32" ? "python" : path.resolve(REPO, "..", ".venv", "bin", "python");
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot: temp(), codexHome, python, runId: "controlled", executionMode: "controlled_mcp" });
  const options = codexOptionsFor(cfg) as { config: Record<string, unknown>; configOverrides: string[] };
  const features = options.config.features as Record<string, unknown>;
  assert.equal(features.shell_tool, false);
  assert.equal(features.unified_exec, false);
  const mcpOverride = options.configOverrides.at(-1) ?? "";
  assert.match(mcpOverride, /"evil"\s*=\s*\{\s*"enabled"\s*=\s*false\s*\}/);
  assert.match(mcpOverride, /"dotted\.name"\s*=\s*\{\s*"enabled"\s*=\s*false\s*\}/, "引号键和 profile 内的旧 MCP 也必须被禁用");
  assert.match(mcpOverride, /"vra_run_[a-f0-9]{12}"\s*=/, "受控 MCP 用本轮专属名称，不与旧配置合并");
  assert.match(mcpOverride, /run_tools_mcp\.ts/);
  for (const tool of ["list_run_files", "read_run_file", "calculate", "write_stage", "write_report"]) assert.ok(mcpOverride.includes(tool));

  let threadOptions: Record<string, unknown> | null = null;
  const fake = () => ({ startThread: (o: Record<string, unknown>) => {
    threadOptions = o;
    return { id: "t", runStreamed: () => Promise.resolve({ events: (async function* () { yield { type: "turn.completed" }; })() }) };
  } }) as never;
  await new CodexRunner(cfg, path.join(cfg.runDir, "events.jsonl"), fake).runTurn("profile", 0, "x");
  assert.equal(threadOptions!.sandboxMode, "read-only");
  assert.equal(threadOptions!.networkAccessEnabled, false);
});

test("受控 MCP:只能读净化产物、计算用 argv 调 Python、只能写当前阶段", () => {
  const dataRoot = temp();
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, dataRoot, runId: "tools", executionMode: "controlled_mcp", python: process.platform === "win32" ? "python" : "python3" });
  fs.mkdirSync(path.join(cfg.runDir, "fetch"), { recursive: true });
  fs.mkdirSync(path.join(cfg.runDir, "raw"), { recursive: true });
  fs.writeFileSync(path.join(cfg.runDir, "fetch", "sample.json"), '{"status":"ok"}\n');
  fs.writeFileSync(path.join(cfg.runDir, "raw", "secret.json"), "{}\n");
  writeHookContext(cfg, "profile", 0);
  const ctx = { runDir: cfg.runDir, repoRoot: cfg.repoRoot, python: cfg.python };

  assert.ok(listRunFiles(ctx).files.some((x) => x.path === "fetch/sample.json"));
  assert.equal(readRunFile(ctx, "fetch/sample.json").text, '{"status":"ok"}\n');
  assert.throws(() => readRunFile(ctx, "raw/secret.json"), (e: unknown) => e instanceof RunToolsError && e.code === "path_not_allowed");

  const record = runCalculation(ctx, { function: "ratio", args: { numerator: 1, denominator: 4 }, output_file: "01_ratio.json" });
  assert.equal((record.output as Record<string, unknown>).status, "ok");
  assert.equal((record.output as Record<string, unknown>).value, 0.25);
  assert.ok(fs.existsSync(path.join(cfg.runDir, "calcs", "01_ratio.json")));
  assert.equal((runCalculation(ctx, { function: "ratio", args: { numerator: 2, denominator: 4 }, output_file: "01_ratio.json" }).output as Record<string, unknown>).value, 0.5, "同阶段补跑可覆盖自己的计算");

  writeHookContext(cfg, "financials", 1);
  assert.throws(
    () => runCalculation(ctx, { function: "ratio", args: { numerator: 3, denominator: 4 }, output_file: "01_ratio.json" }),
    (e: unknown) => e instanceof RunToolsError && e.code === "calc_owned_by_other_stage",
  );

  writeHookContext(cfg, "profile", 2);
  assert.throws(() => writeStageOutput(ctx, { stage: "financials" }), (e: unknown) => e instanceof RunToolsError && e.code === "wrong_stage");
  assert.throws(() => writeStageOutput(ctx, { stage: "profile" }), (e: unknown) => e instanceof RunToolsError && e.code === "stage_schema_invalid");
});

test("Windows 私密文件权限不用 Unix mode 冒充 ACL 验证", { skip: process.platform !== "win32" }, () => {
  const dir = temp();
  const file = path.join(dir, "private.txt");
  fs.writeFileSync(file, "secret", { mode: 0o600 });
  restrictPrivateFile(file);
  assert.equal(privateFilePermissions(file).secure, true, "收紧后必须断开继承且只留当前用户 SID");
});
