/**
 * Codex 线程驱动:用官方 TS SDK 拉起 codex 二进制(零 fork),一个研究 run = 一个 thread,每个阶段 = 一个 turn。
 * cwd = 运行目录(沙箱只放行运行目录写入);无网络;引擎路径可配置(SDK codexPathOverride);显式 CODEX_HOME;
 * 工具执行环境排除密钥类变量;每 turn 超时(AbortSignal);流级 error 视为失败;所有事件(带 run_id / seq / attempt)逐条落 events.jsonl(fsync + 全文 sha256 摘要 + 密钥脱敏)。
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";

import { CODEX_SHELL_ENV_POLICY, codexEnvFor, secretsFor, type RunConfig, type Stage } from "./config.ts";
import { nowIso } from "./fsutil.ts";
import { codexProviderConfig } from "./providers.ts";

export interface CommandRecord { command: string; exit_code: number | null; status: string }

export interface TurnOutcome {
  finalResponse: string;
  usage: Record<string, number> | null;
  commands: CommandRecord[];
  fileChanges: string[];
  itemCount: number;
  durationMs: number;
  failed: string | null;
  threadId: string | null;
}

/** 可注入的运行器接口(测试用假运行器实现同一接口) */
export interface AgentRunner {
  runTurn(stage: Stage, attempt: number, prompt: string, outputSchema?: unknown): Promise<TurnOutcome>;
  readonly threadId: string | null;
  log(stage: Stage | "orchestrator", type: string, payload?: Record<string, unknown>): void;
  /** events.jsonl 全部已写内容的 sha256(用于认证审计日志未被 agent 改动);null = 不校验 */
  eventsDigest(): string | null;
}

const GENERIC_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;

/** events.jsonl 写入器:每条 fsync,维护全文 sha256 摘要;已知密钥值与常见 key 形态在落盘前脱敏(纵深防御,主防线是工具环境不含密钥) */
export class EventsLog {
  private readonly hash = crypto.createHash("sha256");
  private readonly path: string;
  private readonly secrets: string[];
  constructor(p: string, secrets: string[] = []) { this.path = p; this.secrets = secrets.filter((x) => x.length >= 8); }
  redact(text: string): string {
    let out = text;
    for (const sec of this.secrets) out = out.split(sec).join("[REDACTED]");
    return out.replace(GENERIC_KEY_RE, "[REDACTED_KEY]");
  }
  append(obj: unknown): void {
    const line = this.redact(JSON.stringify(obj)) + "\n";
    this.hash.update(line);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const fd = fs.openSync(this.path, "a");
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  digest(): string { return this.hash.copy().digest("hex"); }
}

/**
 * Codex SDK 选项(v2.1 §5 ①②):引擎路径 codexPathOverride(空 = SDK 内置);env 只含显式 CODEX_HOME(+ api_key 模式的 CODEX_API_KEY);
 * config 注入工具执行环境策略——agent 的 shell 命令不继承任何密钥类变量(主防线;Codex 默认 ignore_default_excludes=true 即会继承)。
 */
export function codexOptionsFor(cfg: RunConfig, env: NodeJS.ProcessEnv = process.env): CodexOptions {
  // M4:非 openai provider 注入 model_provider + model_providers.<id>(base_url / env_key / wire_api / requires_openai_auth=false …);openai 原生沿用引擎默认
  const providerCfg = cfg.providerProfile ? codexProviderConfig(cfg.providerProfile) : {};
  return {
    env: codexEnvFor(cfg, env),
    config: { ...(CODEX_SHELL_ENV_POLICY as unknown as Record<string, unknown>), ...providerCfg } as unknown as NonNullable<CodexOptions["config"]>,
    ...(cfg.codexPath ? { codexPathOverride: cfg.codexPath } : {}),
  };
}

export class CodexRunner implements AgentRunner {
  private thread: Thread | null = null;
  private readonly codex: Codex;
  private readonly cfg: RunConfig;
  private readonly events: EventsLog;
  private seq = 0;
  /** 实际传给 SDK 的选项(测试可断言:含工具环境策略 / 显式 CODEX_HOME / 引擎路径) */
  readonly codexOptions: CodexOptions;

  /** 事件旁路观察者(进度渲染用)。**只观察不参与** —— 它抛错不得影响运行,见 log()。 */
  private readonly observer: ((ev: Record<string, unknown>) => void) | null;

  constructor(cfg: RunConfig, eventsPath: string, codexFactory: (opts: CodexOptions) => Codex = (o) => new Codex(o),
              observer?: (ev: Record<string, unknown>) => void) {
    this.cfg = cfg;
    this.events = new EventsLog(eventsPath, secretsFor(cfg));   // 已知密钥值落盘前脱敏(纵深)
    this.codexOptions = codexOptionsFor(cfg);
    this.codex = codexFactory(this.codexOptions);
    this.observer = observer ?? null;
  }

  eventsDigest(): string | null { return this.events.digest(); }

  get threadId(): string | null {
    return this.thread?.id ?? null;
  }

  private ensureThread(): Thread {
    if (this.thread) return this.thread;
    this.thread = this.codex.startThread({
      workingDirectory: this.cfg.runDir,    // cwd = 运行目录:workspace-write 沙箱只放行运行目录写入,产品代码 / 契约 / skills 只读(宪法与 .agents/skills 的发现见 instructions_root.ts)
      sandboxMode: "workspace-write",
      // 🔴 必开。引擎在 `exec` 入口有一道门:cwd 不在 git 仓库里就直接 exit 1,报
      //    `Not inside a trusted directory and --skip-git-repo-check was not specified.`
      //    (codex-rs/exec/src/lib.rs:798 —— 判据其实**只是 `get_git_repo_root(cwd).is_none()`**,
      //     与 `[projects] trust_level` 无关,那句话的措辞有误导性)。
      //    我们的运行目录是**产品自管的数据目录**、不是用户源码树,agent 只往里写本次运行产物,
      //    这道门保护不到任何东西,却会让两种正常安装直接跑不起来(都已实测):
      //      · 用户下载 zip 解压(没有 .git)→ 每次运行 exit 1;
      //      · 数据根在产品根之外(分离安装)→ 同上。
      skipGitRepoCheck: true,
      networkAccessEnabled: false,          // 解释阶段不联网:取数已由编排器执行,calc / jq 不需要网络(AGENTS.md §5)
      approvalPolicy: "never",              // 非交互
      webSearchMode: "disabled",            // 不联网搜索,数据只来自登记脚本
      model: this.cfg.model ?? this.cfg.providerProfile?.default_model ?? undefined,  // 未指定模型时用 provider 模板默认(openai 模板为 null → 引擎默认)
      modelReasoningEffort: this.cfg.reasoning as never,
    });
    return this.thread;
  }

  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    this.seq += 1;
    const ev = { ts: nowIso(), run_id: this.cfg.runId, seq: this.seq, stage, type, ...payload };
    this.events.append(ev);
    // 落盘在前、旁路在后:观察者出任何问题都不能影响事件账本的完整性
    if (this.observer) { try { this.observer(ev); } catch { /* 显示层永不影响运行 */ } }
  }

  async runTurn(stage: Stage, attempt: number, prompt: string, outputSchema?: unknown): Promise<TurnOutcome> {
    const thread = this.ensureThread();
    const t0 = Date.now();
    const outcome: TurnOutcome = { finalResponse: "", usage: null, commands: [], fileChanges: [], itemCount: 0, durationMs: 0, failed: null, threadId: null };
    this.log(stage, "turn.prompt", { attempt, chars: prompt.length });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.turnTimeoutMs);
    try {
      const { events } = await thread.runStreamed(prompt, { ...(outputSchema ? { outputSchema } : {}), signal: ac.signal });
      for await (const ev of events) {
        this.record(stage, attempt, ev, outcome);
        if (ev.type === "turn.failed") { outcome.failed = ev.error?.message ?? "turn.failed"; break; }
        if (ev.type === "error") { outcome.failed = `stream error: ${ev.message}`; break; }
      }
    } catch (e) {
      outcome.failed = ac.signal.aborted ? `turn 超时(${this.cfg.turnTimeoutMs} ms)` : e instanceof Error ? e.message : String(e);
      this.log(stage, "turn.exception", { attempt, message: outcome.failed });
    } finally {
      clearTimeout(timer);
    }
    outcome.durationMs = Date.now() - t0;
    outcome.threadId = thread.id;
    this.log(stage, "turn.done", { attempt, duration_ms: outcome.durationMs, commands: outcome.commands.length, failed: outcome.failed, usage: outcome.usage });
    return outcome;
  }

  private record(stage: Stage, attempt: number, ev: ThreadEvent, outcome: TurnOutcome): void {
    switch (ev.type) {
      case "thread.started": this.log(stage, "thread.started", { attempt, thread_id: ev.thread_id }); break;
      case "turn.started": this.log(stage, "turn.started", { attempt }); break;
      case "turn.completed": outcome.usage = ev.usage as unknown as Record<string, number>; this.log(stage, "turn.completed", { attempt, usage: ev.usage }); break;
      case "turn.failed": this.log(stage, "turn.failed", { attempt, error: ev.error }); break;
      case "error": this.log(stage, "stream.error", { attempt, message: ev.message }); break;
      case "item.completed": outcome.itemCount += 1; this.recordItem(stage, attempt, ev.item, outcome); break;
      default: break; // item.started / item.updated 不落盘
    }
  }

  private recordItem(stage: Stage, attempt: number, item: ThreadItem, outcome: TurnOutcome): void {
    switch (item.type) {
      case "command_execution":
        outcome.commands.push({ command: item.command, exit_code: item.exit_code ?? null, status: item.status });
        this.log(stage, "command", { attempt, command: item.command.slice(0, 4000), exit_code: item.exit_code ?? null, status: item.status, output_tail: (item.aggregated_output ?? "").slice(-2000) });
        break;
      case "file_change":
        outcome.fileChanges.push(...item.changes.map((c) => c.path));
        this.log(stage, "file_change", { attempt, status: item.status, changes: item.changes });
        break;
      case "agent_message": outcome.finalResponse = item.text; this.log(stage, "agent_message", { attempt, text: item.text.slice(0, 4000) }); break;
      case "reasoning": this.log(stage, "reasoning", { attempt, text: item.text.slice(0, 1000) }); break;
      case "error": this.log(stage, "item.error", { attempt, message: item.message }); break;
      case "web_search": this.log(stage, "web_search", { attempt, query: item.query }); break;
      case "mcp_tool_call": this.log(stage, "mcp_tool_call", { attempt, server: item.server, tool: item.tool, status: item.status, arguments: item.arguments }); break;
      case "todo_list": this.log(stage, "todo_list", { attempt, items: item.items }); break;
      default: break;
    }
  }
}

/** 实际拉起的 codex 二进制版本:有 codexPath 则问它;否则问 SDK 内置二进制(与 PATH 上的 codex 无关) */
export function sdkCodexVersion(codexPath: string | null = null): { version: string; binary: string | null } {
  if (codexPath) {
    try {
      const p = spawnSync(codexPath, ["--version"], { encoding: "utf8", timeout: 15_000 });
      return { version: (p.stdout || "").trim() || "unknown", binary: codexPath };
    } catch { return { version: "unknown", binary: codexPath }; }
  }
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@openai/codex/package.json");
    const triple: Record<string, string> = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl", "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" };
    const t = triple[`${process.platform}-${process.arch}`];
    const platformPkg = `@openai/codex-${process.platform}-${process.arch}`;
    const pp = req.resolve(`${platformPkg}/package.json`, { paths: [path.dirname(pkgJson)] });
    const bin = path.join(path.dirname(pp), "vendor", t, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    const p = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return { version: (p.stdout || "").trim() || "unknown", binary: bin };
  } catch {
    return { version: "unknown", binary: null };
  }
}
