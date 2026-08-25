import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { makeConfig } from "../src/config.ts";
import { MAX_STOP_BLOCKS, buildHooksJson, hookHash, hookKey, installHooks, mergeBlock, normalizedHandler, readHookLog, readStopFailed, summarizeHookLog, writeHookContext } from "../src/hooks.ts";
import { writeJson } from "../src/fsutil.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const HOOKS_DIR = path.resolve(import.meta.dirname, "..", "hooks");

function tmpRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-hooks-"));
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "stages"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "fetch"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "raw"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "calcs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# c\n");
  return repo;
}

test("hookHash:复刻 Codex 规范化(timeout 默认 600 / async false / None 字段省略 / 键排序),稳定且对等价写法收敛", () => {
  const a = hookHash("Stop", undefined, { type: "command", command: "x" });
  const b = hookHash("Stop", undefined, { type: "command", command: "x", timeout: 600, async: false });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, hookHash("Stop", undefined, { type: "command", command: "y" }));
  assert.notEqual(a, hookHash("PreToolUse", "^Bash$", { type: "command", command: "x" }));
  assert.deepEqual(normalizedHandler("Stop", { type: "command", command: "x", additionalContextLimit: 2500 }), { type: "command", command: "x", timeout: 600, async: false });
  assert.deepEqual(normalizedHandler("PreToolUse", { type: "command", command: "x", additionalContextLimit: 100, statusMessage: "s" }), { type: "command", command: "x", timeout: 600, async: false, statusMessage: "s", additionalContextLimit: 100 });
  assert.deepEqual(normalizedHandler("SessionEnd", { type: "command", command: "x", timeout: 30 }), { type: "command", command: "x", timeout: 3, async: false });
  assert.equal(hookKey("/h/hooks.json", "PreToolUse", 0, 1), "/h/hooks.json:pre_tool_use:0:1");
});

test("installHooks:写 hooks.json + 在 config.toml 末尾登记 trusted_hash(幂等;块外内容保留;hooks.json 路径 = key 前缀)", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "1", repoRoot: repo });
  fs.mkdirSync(cfg.codexHome, { recursive: true });
  fs.writeFileSync(path.join(cfg.codexHome, "config.toml"), '[projects."/x"]\ntrust_level = "trusted"\n');
  const inst = installHooks(cfg, "/usr/local/bin/node");
  const hooksJson = JSON.parse(fs.readFileSync(inst.hooksJsonPath, "utf8"));
  assert.ok(hooksJson.hooks.Stop[0].hooks[0].command.includes("orchestrator/hooks/stop.ts"));
  assert.equal(hooksJson.hooks.PreToolUse[0].matcher, "^(Bash|apply_patch)$");
  const toml = fs.readFileSync(inst.configTomlPath, "utf8");
  assert.ok(toml.startsWith('[projects."/x"]'));
  for (const st of inst.states) { assert.ok(toml.includes(`[hooks.state.${JSON.stringify(st.key)}]`)); assert.ok(toml.includes(st.trusted_hash)); assert.ok(st.key.startsWith(inst.hooksJsonPath + ":")); }
  const again = installHooks(cfg, "/usr/local/bin/node");
  assert.equal(fs.readFileSync(again.configTomlPath, "utf8"), toml); // 幂等
  assert.equal(mergeBlock("a = 1\n# >>> vibe-research hooks state (generated; do not edit) >>>\nold\n# <<< vibe-research hooks state <<<\n", "# >>> vibe-research hooks state (generated; do not edit) >>>\nnew\n# <<< vibe-research hooks state <<<"),
    "a = 1\n\n# >>> vibe-research hooks state (generated; do not edit) >>>\nnew\n# <<< vibe-research hooks state <<<\n");
  assert.deepEqual(Object.keys(buildHooksJson(cfg).hooks), ["Stop", "PreToolUse"]);
});

function runHook(name: string, cwd: string, input: Record<string, unknown>): { stdout: string; status: number | null } {
  const p = spawnSync(process.execPath, [path.join(HOOKS_DIR, name)], { cwd, input: JSON.stringify({ cwd, ...input }), encoding: "utf8", timeout: 30_000 });
  return { stdout: p.stdout, status: p.status };
}

test("Stop 钩子脚本:缺产物 → block(最多 MAX_STOP_BLOCKS 次)→ 仍不合格则 continue:false + 终止标记(不算正常收工);产物合格 → 放行;无上下文 → 放行但出声", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "r1" });
  const runDir = cfg.runDir;
  writeJson(path.join(runDir, "manifest.json"), { run_id: "r1" });
  let r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.status, 0); assert.equal(r.stdout, ""); // 无上下文 → 放行
  assert.ok(readHookLog(runDir).some((e) => e.decision === "error" && /上下文缺失/.test(e.reason ?? "")));
  writeHookContext(cfg, "profile", 1);
  for (let i = 0; i < MAX_STOP_BLOCKS; i++) {
    r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: i > 0 });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.ok(out.reason.includes("缺产物:stages/profile.json") && out.reason.includes(`第 ${i + 1}/${MAX_STOP_BLOCKS} 次`));
  }
  r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: true }); // 第三次仍缺 → 终止本轮
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, false);
  const marker = readStopFailed(runDir);
  assert.ok(marker && marker.stage === "profile" && marker.attempt === 1 && marker.blocks === MAX_STOP_BLOCKS);
  // 新一轮(attempt 2):计数独立;产物齐全(取数无账本 → 账本类错误不 block,留给编排器)→ 放行
  writeHookContext(cfg, "profile", 2);
  writeJson(path.join(runDir, "stages", "profile.json"), { stage: "profile", status: "incomplete", summary: "x", evidence_ids: [], calculation_ids: [], gaps: [{ operation: "fetch_quote", reason_code: "source_failed", detail: "x" }, { operation: "fetch_profile", reason_code: "source_failed", detail: "x" }, { operation: "fetch_trade_calendar", reason_code: "source_failed", detail: "x" }], quote_decision: "unknown_unverified", quote_decision_reason: "x", moat_tag: "待补" });
  r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.stdout, "");
  const sum = summarizeHookLog(readHookLog(runDir));
  assert.equal(sum.stop_blocks, MAX_STOP_BLOCKS); assert.equal(sum.stop_terminations, 1); assert.equal(sum.errors, 1);
  // cwd 与上下文不一致(伪造上下文 / 换目录)→ 放行但记 error
  const other = path.join(repo, ".local", "runs", "r2"); fs.mkdirSync(other, { recursive: true }); writeJson(path.join(other, "manifest.json"), {});
  fs.mkdirSync(path.join(other, ".vibe"), { recursive: true }); fs.copyFileSync(path.join(runDir, ".vibe", "hook-context.json"), path.join(other, ".vibe", "hook-context.json"));
  r = runHook("stop.ts", other, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.stdout, "");
  assert.ok(readHookLog(other).some((e) => e.decision === "error" && /不一致/.test(e.reason ?? "")));
});

test("PreToolUse 钩子脚本:自跑取数脚本 / 读禁区 / 改写受保护产物 / 联网 → block;普通 calc 命令 → 放行;apply_patch 触及 fetch/ → block", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "r1", python: "/tmp/venv/bin/python" });
  const runDir = cfg.runDir;
  writeHookContext(cfg, "financials", 1);
  const bash = (command: string) => runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  let r = bash(`python3 ${repo}/.agents/skills/data-access/scripts/fetch_quote.py --symbol 300308`);
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("cat ../../../交接资料/x.md");
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash(`echo x > ${runDir}/fetch/fetch_quote.json`);
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("curl https://example.com");
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("printf '{}' > .vibe/hook-context.json"); // 相对路径写钩子上下文
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("rm .vibe/hooks.log; echo x >> fetch/fetch_quote.json");
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash(`/tmp/venv/bin/python ${repo}/calc/cli.py quarterize --args '{}' --evidence ev-1 --run-dir ${runDir} > ${runDir}/calcs/01_q.json`);
  assert.equal(r.stdout, "");
  r = bash("jq . fetch/fetch_financials.json");
  assert.equal(r.stdout, "");
  r = runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: fetch/fetch_quote.json\n+x\n*** End Patch" } });
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Add File: stages/financials.json\n+{}\n*** End Patch" } });
  assert.equal(r.stdout, "");
  r = runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Add File: ../../../evil.json\n+{}\n*** End Patch" } });
  assert.equal(JSON.parse(r.stdout).decision, "block");
  const sum = summarizeHookLog(readHookLog(runDir));
  assert.equal(sum.pre_tool_use_blocks, 8);
  assert.equal(sum.errors, 0);
});
