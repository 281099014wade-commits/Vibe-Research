#!/usr/bin/env node
/**
 * Windows 原生研究执行层(stdio MCP)。
 *
 * Codex 的 Windows PowerShell Hook 目前存在上游缺口，因此 Windows 研究线程不开放 Shell，
 * 也不给 workspace 写权限。模型只能经这里读取本次运行的净化产物、调用确定性 calc、写当前阶段 JSON / 报告。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { atomicWrite, readJsonIfExists, writeJson } from "../fsutil.ts";
import { readHookContext } from "../hooks.ts";
import { validateStageOutput } from "../schemas.ts";
import { productVersion } from "../version.ts";
import "./register.ts";

const MAX_READ_CHARS = 1_000_000;
const CALC_FILE_RE = /^\d{2}_[a-z0-9][a-z0-9_]{0,80}\.json$/;
const CALC_FUNCTION_RE = /^[a-z][a-z0-9_]{0,80}$/;
const CALC_OWNERS_REL = path.join(".vibe", "calc-owners.json");

export interface RunToolsContext {
  runDir: string;
  repoRoot: string;
  python: string;
}

export class RunToolsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "RunToolsError"; this.code = code; }
}

function currentStage(ctx: RunToolsContext): string {
  const turn = readHookContext(ctx.runDir);
  if (!turn?.stage || path.resolve(turn.run_dir) !== path.resolve(ctx.runDir)) {
    throw new RunToolsError("turn_context_missing", "当前阶段上下文缺失或与运行目录不一致");
  }
  return turn.stage;
}

function safeReadable(ctx: RunToolsContext, rel: string): string {
  const normalized = String(rel ?? "").replaceAll("\\", "/");
  const allowed = normalized === "conflicts.json" || normalized === "report.md" ||
    /^(fetch|calcs|stages)\/[A-Za-z0-9._-]+\.json$/.test(normalized);
  if (!allowed || normalized.includes("..")) throw new RunToolsError("path_not_allowed", `不允许读取:${rel}`);
  const target = path.resolve(ctx.runDir, ...normalized.split("/"));
  const root = path.resolve(ctx.runDir);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) {
    throw new RunToolsError("file_unavailable", `文件不存在或不是普通文件:${rel}`);
  }
  return target;
}

function boundedText(text: string, offset = 0, limit = 200_000): { text: string; offset: number; next_offset: number | null; total_chars: number } {
  const start = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, text.length));
  const size = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 200_000, MAX_READ_CHARS));
  const end = Math.min(text.length, start + size);
  return { text: text.slice(start, end), offset: start, next_offset: end < text.length ? end : null, total_chars: text.length };
}

export function listRunFiles(ctx: RunToolsContext): { files: { path: string; bytes: number }[]; stage: string } {
  const files: { path: string; bytes: number }[] = [];
  for (const dir of ["fetch", "calcs", "stages"]) {
    const base = path.join(ctx.runDir, dir);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).filter((x) => /^[A-Za-z0-9._-]+\.json$/.test(x)).sort()) {
      const file = path.join(base, name);
      const st = fs.lstatSync(file);
      if (st.isFile() && !st.isSymbolicLink()) files.push({ path: `${dir}/${name}`, bytes: st.size });
    }
  }
  for (const name of ["conflicts.json", "report.md"]) {
    const file = path.join(ctx.runDir, name);
    if (fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()) files.push({ path: name, bytes: fs.statSync(file).size });
  }
  return { files, stage: currentStage(ctx) };
}

export function readRunFile(ctx: RunToolsContext, rel: string, offset?: number, limit?: number): ReturnType<typeof boundedText> & { path: string } {
  const file = safeReadable(ctx, rel);
  const text = fs.readFileSync(file, "utf8");
  return { path: rel.replaceAll("\\", "/"), ...boundedText(text, offset, limit) };
}

export function runCalculation(ctx: RunToolsContext, input: {
  function: string; args: Record<string, unknown>; evidence_ids?: string[]; calculation_ids?: string[]; output_file: string;
}): Record<string, unknown> {
  const stage = currentStage(ctx);
  if (!CALC_FUNCTION_RE.test(input.function)) throw new RunToolsError("bad_function", "计算函数名格式非法");
  if (!CALC_FILE_RE.test(input.output_file)) throw new RunToolsError("bad_output_file", "output_file 必须形如 01_forward_pe.json");
  const calcDir = path.join(ctx.runDir, "calcs");
  fs.mkdirSync(calcDir, { recursive: true });
  const scratchDir = path.join(ctx.runDir, ".vibe");
  fs.mkdirSync(scratchDir, { recursive: true });
  const ownersFile = path.join(ctx.runDir, CALC_OWNERS_REL);
  const owners = readJsonIfExists<Record<string, string>>(ownersFile) ?? {};
  const target = path.join(calcDir, input.output_file);
  if (fs.existsSync(target) && owners[input.output_file] !== stage) {
    throw new RunToolsError("calc_owned_by_other_stage", `${input.output_file} 已由 ${owners[input.output_file] ?? "先前运行"} 阶段创建，当前 ${stage} 阶段不得覆盖`);
  }
  const argsFile = path.join(scratchDir, `calc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeJson(argsFile, input.args ?? {});
  const cli = path.join(ctx.repoRoot, "calc", "cli.py");
  const argv = [cli, input.function, "--args-file", argsFile, "--run-dir", ctx.runDir];
  if (input.evidence_ids?.length) argv.push("--evidence", ...input.evidence_ids);
  if (input.calculation_ids?.length) argv.push("--calc", ...input.calculation_ids);
  let proc;
  try {
    proc = spawnSync(ctx.python, argv, { cwd: ctx.runDir, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  } finally {
    try { fs.unlinkSync(argsFile); } catch { /* best effort */ }
  }
  if (proc.error) throw new RunToolsError("calc_start_failed", `计算器无法启动:${proc.error.message}`);
  let record: Record<string, unknown>;
  try { record = JSON.parse(proc.stdout || "") as Record<string, unknown>; }
  catch { throw new RunToolsError("calc_bad_output", `计算器未返回合法 JSON(退出码 ${proc.status ?? "unknown"})`); }
  atomicWrite(target, `${JSON.stringify(record, null, 2)}\n`);
  owners[input.output_file] = stage;
  writeJson(ownersFile, owners);
  return record;
}

export function writeStageOutput(ctx: RunToolsContext, stageOutput: Record<string, unknown>): { written: string; stage: string } {
  const stage = currentStage(ctx);
  if (stageOutput.stage !== stage) throw new RunToolsError("wrong_stage", `当前阶段是 ${stage}，不能写 ${String(stageOutput.stage)}`);
  const errors = validateStageOutput(stage, stageOutput);
  if (errors.length) throw new RunToolsError("stage_schema_invalid", errors.slice(0, 8).join("; "));
  const rel = `stages/${stage}.json`;
  writeJson(path.join(ctx.runDir, ...rel.split("/")), stageOutput);
  return { written: rel, stage };
}

export function writeReport(ctx: RunToolsContext, markdown: string, stageOutput?: Record<string, unknown>): { written: string[] } {
  const stage = currentStage(ctx);
  if (stage !== "report") throw new RunToolsError("wrong_stage", "只有 report 阶段可以写报告");
  if (!markdown.trim() || markdown.length > 2_000_000) throw new RunToolsError("bad_report", "报告为空或超过 2,000,000 字符");
  if (stageOutput) writeStageOutput(ctx, stageOutput);
  else if (!readJsonIfExists(path.join(ctx.runDir, "stages", "report.json"))) throw new RunToolsError("report_stage_missing", "首次写报告必须同时提交 stage_output");
  atomicWrite(path.join(ctx.runDir, "report.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return { written: ["report.md", "stages/report.json"] };
}

function result(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function wrap<T>(fn: () => T) {
  try { return result(fn()); }
  catch (error) {
    if (error instanceof RunToolsError) return result({ error: error.code, message: error.message }, true);
    console.error(`[vra-run-tools] ${error instanceof Error ? error.message : String(error)}`);
    return result({ error: "internal" }, true);
  }
}

export function buildRunToolsServer(ctx: RunToolsContext): McpServer {
  const server = new McpServer({ name: "vra-run-tools", version: productVersion() });
  server.registerTool("list_run_files", { title: "列出本次运行文件", description: "列出本次运行可读的 fetch/calcs/stages JSON、冲突集和报告。", inputSchema: {} }, () => wrap(() => listRunFiles(ctx)));
  server.registerTool("read_run_file", { title: "读取本次运行文件", description: "只读本次运行的净化 JSON 或报告；大文件可用 offset/limit_chars 分段。", inputSchema: { path: z.string(), offset: z.number().int().min(0).optional(), limit_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional() } },
    (a) => wrap(() => readRunFile(ctx, a.path, a.offset, a.limit_chars)));
  server.registerTool("calculate", { title: "确定性计算", description: "调用产品 calc 纯函数并把结果写入 calcs/。所有输入证据和上游 calculation id 必须完整列出。", inputSchema: {
    function: z.string(), args: z.record(z.string(), z.unknown()), evidence_ids: z.array(z.string()).optional(), calculation_ids: z.array(z.string()).optional(), output_file: z.string(),
  } }, (a) => wrap(() => runCalculation(ctx, a)));
  server.registerTool("write_stage", { title: "写当前阶段产物", description: "按当前阶段 schema 写 stages/<stage>.json；不能写别的阶段。", inputSchema: { stage_output: z.record(z.string(), z.unknown()) } },
    (a) => wrap(() => writeStageOutput(ctx, a.stage_output)));
  server.registerTool("write_report", { title: "写研究报告", description: "只在 report 阶段写 report.md；首次调用同时提交 report 阶段 JSON，合规重写时可只传 markdown。", inputSchema: { markdown: z.string(), stage_output: z.record(z.string(), z.unknown()).optional() } },
    (a) => wrap(() => writeReport(ctx, a.markdown, a.stage_output)));
  return server;
}

function contextFromEnv(): RunToolsContext {
  const runDir = process.env.VRA_RUN_DIR;
  const repoRoot = process.env.VRA_REPO_ROOT;
  const python = process.env.VRA_PYTHON;
  if (!runDir || !repoRoot || !python) throw new RunToolsError("missing_context", "缺少 VRA_RUN_DIR / VRA_REPO_ROOT / VRA_PYTHON");
  return { runDir: path.resolve(runDir), repoRoot: path.resolve(repoRoot), python };
}

async function main(): Promise<void> {
  await buildRunToolsServer(contextFromEnv()).connect(new StdioServerTransport());
}

if (process.argv[1] && /run_tools_mcp\.ts$/i.test(process.argv[1])) {
  main().catch((error) => { console.error(`[vra-run-tools] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
