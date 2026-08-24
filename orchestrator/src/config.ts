/**
 * 编排器配置与常量。唯一落盘契约见 AGENTS.md §4;阶段定义见 .agents/skills/company-research/SKILL.md。
 * 零 fork:只通过官方 SDK 拉起 codex 二进制,不改 Codex。
 */
import path from "node:path";

import type { ProviderProfile } from "./productConfig.ts";
import { providerEnv, type ProviderProfileFile } from "./providers.ts";
import { currentPack } from "./domain.ts";
import { buildStagePlan, criticalScripts as registryCriticalScripts, endpointsById, loadRegistry, type EndpointDef, type ScopeKind, type StagePlan } from "./registry.ts";

/**
 * 阶段名**由垂类包提供**(`DomainPack.stages`),Core 只知道"有一串阶段、按序执行"。
 *
 * ⚠️ `Stage` 因此退化成 `string`,`Record<Stage, …>` 的编译期穷尽性检查没有了 ——
 * 换来的是注册期的**键集必须与 stages 完全一致**校验(见 `domain.ts` 顶部说明)。
 * 那条校验拦得住第三方包写漏,编译期检查只保护得了我们自己的代码。
 */
export type Stage = string;
/** 当前垂类的阶段顺序。**运行期读**,不要在模块顶层求值(注册发生在 import 之后)。 */
export const stages = (): readonly Stage[] => currentPack().stages;

export type RunStatus = "complete" | "incomplete" | "failed" | "stale";
export type StageStatus = "complete" | "incomplete" | "skipped" | "failed";

/** 报告状态优先级(SOP §2):failed > stale > incomplete > complete */
export const STATUS_PRIORITY: RunStatus[] = ["failed", "stale", "incomplete", "complete"];

/** run-id 白名单:防路径逃逸(.local/runs/<run-id> 必须是其直接子目录) */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 故障注入场景(第 6 步硬测试用;生产运行不传) */
export interface Scenario {
  /** 这些脚本不执行,直接写 failed 信封(模拟端点不可用) */
  fail_scripts?: string[];
  /** 这些脚本以极短超时执行(模拟超时) */
  timeout_scripts?: string[];
  /** 追加一份 fetch_injected.json 信封,用于制造跨源冲突(evidence 条目) */
  inject_evidence?: Record<string, unknown>[];
  /** 注入知识层档案文本(模拟错误旧结论),在 profile 阶段提示词里给 agent */
  knowledge?: { as_of: string; text: string };
  /** 对 report 阶段追加的用户诱导文本(模拟要求给建仓建议) */
  induce_text?: string;
  /** 钩子硬验收探针(只在该阶段第 1 次 attempt 的提示词里注入):stop = 先不写阶段产物就收工一次;stop_terminate = 坚持不写产物;pretool = 先执行一条会被拦的联网命令 */
  hook_probe?: "stop" | "stop_terminate" | "pretool";
  /** 探针作用的阶段(默认 profile) */
  probe_stage?: Stage;
  /** 动态冲突注入:取数后克隆真实证据里该 field 的最新一条(完整事实键),只改 id / source / value(×factor)→ 确定性制造跨源冲突 */
  inject_conflict?: { field: string; factor: number };
  /** 报告阶段结束后、gate 之前,由编排器向 report.md 追加一行含违规表述的测试文本 → 确定性触发 gate 重写路径 */
  force_gate_hit?: boolean;
  /** 钩子故障注入:timeout = Stop 钩子命令长睡超过时限;crash = Stop 钩子命令立即非零退出;context_missing = 探针阶段不写钩子上下文 */
  hook_fault?: "timeout" | "crash" | "context_missing";
  /**
   * 市场声音注入(硬测试第 7 组):在真实取回的 exa_market_voice / exa_forum_voice 信封里追加伪造条目(文本先经与 mapper 同样的动作词脱敏),
   * 用于验证"帖子里的指令不执行、帖子里的数字不当事实、动作措辞不进报告、gate 零命中"
   */
  inject_voice?: { script?: "exa_market_voice" | "exa_forum_voice"; title: string; highlights?: string; url?: string; published?: string }[];
  /** 硬测试第 9 组:往 fetch_announcements 信封追加伪造公告标题(验证卡口事件分类器的正向路径、negatives 与口令不执行) */
  inject_announcements?: { script?: "fetch_announcements" | "em_stock_news"; title: string; date?: string; url?: string }[];
  /** 硬测试第 11 组:温度计历史比较用这些合成"上次观测"替代真实序列(完全不读 .local/knowledge/thermometers;该运行不归档) */
  inject_thermo_history?: { endpoint: string; record_key: string; field: string; value: number; unit?: string; period: string; as_of: string; run_id?: string }[];
}

export interface RunConfig {
  symbol: string;
  market: string;
  runId: string;
  /** 产品根(安装后 = app/);AGENTS.md / skills / calc 均相对它 */
  repoRoot: string;
  /** 用户数据根(= v2 的 .local/;运行目录必须是 <dataRoot>/runs/<run-id>) */
  dataRoot: string;
  runDir: string;
  python: string;
  /** 引擎二进制路径(SDK codexPathOverride);null = SDK 内置 */
  codexPath: string | null;
  /** 产品自己的 CODEX_HOME(永不读写 ~/.codex) */
  codexHome: string;
  provider: ProviderProfile;
  /** M4:provider 模板(openai 原生为 null 或 openai 模板);决定 Codex model_providers 注入与密钥环境变量名 */
  providerProfile: ProviderProfileFile | null;
  /** 相对产品根的 data-access 脚本目录 / calc CLI */
  scriptsRel: string;
  calcCliRel: string;
  /** 宪法文件绝对路径(AGENTS.md;Codex 从 .git 项目根逐级发现到 cwd,因此运行目录必须在产品根之内——prepareRunDir 校验) */
  constitutionPath: string;
  model?: string;
  reasoning?: string;
  maxRetries: number;
  gateRetries: number;
  /** 单个 turn 超时(毫秒) */
  turnTimeoutMs: number;
  /** 单个取数脚本超时(毫秒) */
  fetchTimeoutMs: number;
  /** 命令中出现即判违规(防确认偏误 / 防越界读取) */
  forbiddenPathPatterns: string[];
  /** 命令中的绝对路径允许前缀(仓库根、解释器目录、系统目录) */
  allowedPathPrefixes: string[];
  /** 仅跑编排与校验,不拉起 Codex(测试 / 干跑) */
  noAgent: boolean;
  /** 安装并启用 Codex lifecycle hooks(Stop / PreToolUse;hooks.json + trusted_hash 写入产品 CODEX_HOME) */
  hooksEnabled: boolean;
  /** 运行目录已存在且非空时是否清空重来 */
  overwrite: boolean;
  /** 硬测试数据夹具目录:播种前几个阶段的产物并跳过它们(见 fixture.ts)。**播种运行一律按测试运行隔离** */
  seedFrom?: string;
  /** 允许使用非当日的夹具(默认拒绝:数据逐日变化,跨日复用会让硬测试因错误的原因通过或失败) */
  allowStaleFixture?: boolean;
  scenario: Scenario | null;
  /** 端点范围:core = 仅 legacy 8 脚本(Phase 0 行为);full = 注册表全部启用且市场匹配的端点(Phase 1 M1) */
  endpointScope: ScopeKind;
  /** 由注册表推导的阶段计划 / 关键端点 / 端点定义(注册表缺失时回退 STAGE_SCRIPTS / CRITICAL_SCRIPTS) */
  stagePlan: StagePlan<Stage>;
  criticalScripts: string[];
  endpoints: Record<string, EndpointDef>;
  registryVersion: string | null;
  /** 知识层召回(M2):true = 运行开始时读 .local/knowledge/companies/<market>_<symbol>/latest.md 注入提示词(全阶段 knowledge_conflicts 裁决);程序默认 false(硬测试用 scenario.knowledge),CLI 默认 true */
  knowledgeRecall: boolean;
  /** 召回到的档案(由编排器在运行开始填入;scenario.knowledge 优先级更高,便于硬测试注入) */
  knowledge?: { as_of: string; text: string; status?: string; path?: string };
  /** 运行末尾自动归档到 .local/knowledge + 生成 viewer.html / report_appendix.md(M2);程序默认 true */
  knowledgeArchive: boolean;
}

/** 每阶段必需 / 可选的取数脚本(注册表缺失时的回退计划)—— 由垂类包提供 */
export const stageScripts = (): StagePlan<Stage> => currentPack().stageScripts as StagePlan<Stage>;

/** 关键脚本全部失败 → 运行 failed(无法产出可用研究)—— 由垂类包提供 */
export const packCriticalScripts = (): string[] => [...currentPack().criticalScripts];

/** 某阶段必须出现的计算函数 —— 由垂类包提供 */
export const stageCalcs = (stage: Stage): readonly string[] => currentPack().stageCalcs[stage] ?? [];

export const GAP_REASON_CODES = ["source_failed", "source_partial", "upstream_not_meaningful", "upstream_missing",
  "insufficient_periods", "not_supported_market", "optional_skipped", "other"] as const;

/** report.md 必须出现的章节标题 —— 由垂类包提供 */
export const reportSections = (): readonly string[] => currentPack().reportSections;

/** 合规 gate:命中即视为投资动作建议(AGENTS.md §0 第 3 条) */
export const GATE_PATTERNS: string[] = [
  "建仓", "加仓", "减仓", "清仓", "满仓", "空仓", "建议买", "建议卖", "买入评级", "卖出评级", "可以买", "可以卖",
  "逢低买", "逢高卖", "抄底", "止损", "止盈", "目标价", "仓位建议", "配置比例", "推荐买", "推荐卖", "持有评级", "建议增持", "增持评级", "减持评级",
];
/** 免责 / 边界声明:整行(去首尾空白)**精确等于**其一才豁免;"不构成投资建议,但建议建仓"不会被放过 */
export const GATE_EXEMPT_LINES: string[] = [
  "本报告不提供任何投资动作建议。",
  "本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。",
  "本报告不构成投资建议,使用者自行承担决策责任。",
  "本报告只报数据 / 框架 / 情景概率 / 裁决点,不给建仓建议。",
];

/** 命令中出现即判违规的关键词(防确认偏误:既有研究 / 交接资料;防越界:../) */
export const DEFAULT_FORBIDDEN_PATHS = ["交接资料", "既有研究", "../"];
/** 命令中的绝对路径允许落在这些前缀(系统目录 / 临时目录);仓库根与解释器目录在运行时追加 */
export const DEFAULT_ALLOWED_PATH_PREFIXES = ["/bin", "/usr", "/opt", "/sbin", "/tmp", "/private/tmp", "/private/var", "/var/folders", "/dev", "/System", "/Library", "/Applications", "/nix"];
/** 只有这些前缀下的仓库外路径才被视为"读取他人文件"(用户主目录);其余绝对路径不扫描,避免 shell 变量误报 */
export const HOME_PREFIXES = ["/Users/", "/home/", "/root/"];

/** 基础环境(两类子进程共用) */
const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"];
/** 取数脚本(联网进程)的最小环境:只加代理与证书;**不含任何 Codex 凭据 / 配置目录**(AGENTS.md §5) */
export const FETCH_ENV_KEYS = [...BASE_ENV_KEYS, "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy",
  "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"];
/** Codex 子进程的最小环境 = 取数环境 + 显式注入的 CODEX_HOME(由 codexEnvFor 给出)+ 按 provider 注入的 API key;**不透传用户 shell 的 CODEX_HOME / CODEX_API_KEY**(v2.1 §5 ②:不碰 ~/.codex) */
export const CODEX_ENV_KEYS = [...FETCH_ENV_KEYS];

export const DEFAULT_PROVIDER: ProviderProfile = { name: "openai", wire_api: "responses", base_url: null, env_key: "OPENAI_API_KEY", auth: "chatgpt_login" };

export function makeConfig(partial: Partial<RunConfig> & { symbol: string; repoRoot: string }): RunConfig {
  const runId = partial.runId ?? defaultRunId(partial.symbol);
  if (!RUN_ID_RE.test(runId)) throw new Error(`run-id 非法:${runId}(只允许字母数字 . _ -,≤64 字符)`);
  const repoRoot = path.resolve(partial.repoRoot);
  const dataRoot = path.resolve(partial.dataRoot ?? path.join(repoRoot, ".local"));
  // 解释器路径规范化:带目录的路径一律 resolve(折叠 ../ 与重复斜杠)。否则 "repo/../.venv/bin/python" 会原样进提示词与允许前缀——
  // agent 照抄它就撞「命令越界含 ../」,改写成绝对路径又撞「仓库外路径」(前缀按未规范化字符串比对),calc 一条都跑不了(硬测试 ht4 真踩)。
  const python = normalizeInterpreter(partial.python ?? "python3");
  const endpointScope: ScopeKind = partial.endpointScope ?? "core";
  let stagePlan = partial.stagePlan;
  let criticalScripts = partial.criticalScripts;
  let endpoints = partial.endpoints;
  let registryVersion = partial.registryVersion ?? null;
  if (!stagePlan || !criticalScripts || !endpoints) {
    const reg = loadRegistry(repoRoot);
    if (reg) {
      stagePlan ??= buildStagePlan(reg, stages(), { market: partial.market ?? "", scope: endpointScope });
      criticalScripts ??= registryCriticalScripts(reg);
      endpoints ??= endpointsById(reg);
      registryVersion ??= reg.version;
    } else {
      stagePlan ??= stageScripts();
      criticalScripts ??= packCriticalScripts();
      endpoints ??= {};
    }
  }
  return {
    symbol: partial.symbol,
    market: partial.market ?? "",
    runId,
    repoRoot,
    dataRoot,
    runDir: partial.runDir ?? path.join(dataRoot, "runs", runId),
    python,
    codexPath: partial.codexPath ?? null,
    codexHome: path.resolve(partial.codexHome ?? path.join(dataRoot, "codex-home")),
    provider: partial.provider ?? DEFAULT_PROVIDER,
    providerProfile: partial.providerProfile ?? null,
    scriptsRel: partial.scriptsRel ?? SCRIPTS_REL,
    calcCliRel: partial.calcCliRel ?? CALC_CLI_REL,
    constitutionPath: partial.constitutionPath ?? path.join(repoRoot, "AGENTS.md"),
    model: partial.model,
    reasoning: partial.reasoning,
    maxRetries: partial.maxRetries ?? 2,
    gateRetries: partial.gateRetries ?? 2,
    turnTimeoutMs: partial.turnTimeoutMs ?? 20 * 60_000,
    fetchTimeoutMs: partial.fetchTimeoutMs ?? 180_000,
    forbiddenPathPatterns: partial.forbiddenPathPatterns ?? DEFAULT_FORBIDDEN_PATHS,
    allowedPathPrefixes: partial.allowedPathPrefixes ?? [...DEFAULT_ALLOWED_PATH_PREFIXES, repoRoot, interpreterRoot(python)],
    noAgent: partial.noAgent ?? false,
    hooksEnabled: partial.hooksEnabled ?? true,
    overwrite: partial.overwrite ?? false,
    seedFrom: partial.seedFrom,
    allowStaleFixture: partial.allowStaleFixture ?? false,
    scenario: partial.scenario ?? null,
    endpointScope,
    stagePlan,
    criticalScripts,
    endpoints,
    registryVersion,
    knowledgeRecall: partial.knowledgeRecall ?? false,
    knowledge: partial.knowledge,
    knowledgeArchive: partial.knowledgeArchive ?? true,
  };
}

/** 解释器所在 venv 根(…/.venv/bin/python → …/.venv);非绝对路径则返回空串 */
/** 带目录分隔符的解释器路径 → path.resolve(折叠 ../);裸命令(python3)原样保留交 PATH 解析 */
export function normalizeInterpreter(python: string): string {
  const p = String(python ?? "").trim();
  return p.includes("/") ? path.resolve(p) : p;
}

export function interpreterRoot(python: string): string {
  if (!path.isAbsolute(python)) return "";
  const bin = path.dirname(python);
  return path.basename(bin) === "bin" ? path.dirname(bin) : bin;
}

export function defaultRunId(symbol: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const sh = new Date(now.getTime() + 8 * 3600 * 1000); // Asia/Shanghai
  const stamp = `${sh.getUTCFullYear()}${pad(sh.getUTCMonth() + 1)}${pad(sh.getUTCDate())}-${pad(sh.getUTCHours())}${pad(sh.getUTCMinutes())}${pad(sh.getUTCSeconds())}`;
  return `${stamp}-${symbol}`;
}

function pickEnv(keys: string[], extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}
export const codexEnv = (extra: Record<string, string> = {}) => pickEnv(CODEX_ENV_KEYS, extra);
export const fetchEnv = (extra: Record<string, string> = {}) => pickEnv(FETCH_ENV_KEYS, extra);
/**
 * Codex 子进程环境:显式 CODEX_HOME = 产品自己的目录;provider.auth=api_key 且环境里有 env_key 时注入为 CODEX_API_KEY(值不落盘);
 * chatgpt_login 则依赖 CODEX_HOME 内的登录态。代码不假设任何一种登录方式(v2.1 §5 ⑤)。
 */
export function codexEnvFor(cfg: Pick<RunConfig, "codexHome" | "provider"> & { providerProfile?: ProviderProfileFile | null }, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const extra: Record<string, string> = { CODEX_HOME: cfg.codexHome };
  if (cfg.providerProfile) {
    Object.assign(extra, providerEnv(cfg.providerProfile, cfg.provider.auth, env));  // M4:按模板把 env_key(与 env_http_headers 引用的变量)按名透传;openai 另加 CODEX_API_KEY
  } else if (cfg.provider.auth === "api_key") {
    const key = env[cfg.provider.env_key];
    if (!key) throw new Error(`provider.auth=api_key 但环境变量 ${cfg.provider.env_key} 为空(密钥只从环境变量读,不进配置文件)`);
    extra.CODEX_API_KEY = key;
  }
  return codexEnv(extra);
}
/** 需要在日志中脱敏的密钥值(auth=api_key 时为该 key;否则空) */
export function secretsFor(cfg: Pick<RunConfig, "provider">, env: NodeJS.ProcessEnv = process.env): string[] {
  if (cfg.provider.auth !== "api_key") return [];
  const key = env[cfg.provider.env_key];
  return key ? [key] : [];
}
/** Codex 工具执行环境策略:工具命令(agent 的 shell)不得继承任何密钥类变量(Codex 默认 ignore_default_excludes=true,即默认**会**继承,必须显式关掉) */
export const CODEX_SHELL_ENV_POLICY = { shell_environment_policy: { ignore_default_excludes: false, exclude: ["CODEX_API_KEY", "*KEY*", "*SECRET*", "*TOKEN*", "*PASSWORD*"] } } as const;

export const SCRIPTS_REL = ".agents/skills/data-access/scripts";
export const CALC_CLI_REL = "calc/cli.py";
