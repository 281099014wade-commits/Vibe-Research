/**
 * **运行时模型配置** —— 用户在界面上选的那一份，按请求带进来。
 *
 * 🔴 与「密钥只从环境变量读」并不冲突：这里收到的 key **一个字节都不落盘**，
 *    只被拼进一个**临时的 env 对象**交给引擎；配置文件、日志、账本都碰不到它。
 *    ⇒ 「不进配置文件」这条纪律保住了，浏览器 UI 用户也能在本机自己配。
 *
 * ⚠️ 原来的口径是「只认进程环境变量」。那条在终端里启动时没问题，
 *    但只依赖启动服务前配置 shell 环境，会让浏览器 UI 用户找不到可操作的入口。
 *    开源版（已被真实用户验证）的做法是让用户自己粘 key，
 *    这一层就是把那条路接过来。
 */
import fs from "node:fs";
import path from "node:path";

import {
  BUILTIN_OPENAI_PROFILE, PROVIDER_ID_RE, loadProviderProfile, validateProfile,
  type AuthMode, type ProviderProfileFile,
} from "./providers.ts";

/** 界面传下来的那一份。字段名与开源版一致，便于上游页面直接复用。 */
export interface LlmOverride {
  provider: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export type ResolvedRuntimeProvider =
  | {
      runtime: "codex";
      profile: ProviderProfileFile;
      auth: AuthMode;
      model: string | null;
      /** 交给引擎的环境。**只在内存里**，含用户这次给的 key */
      env: NodeJS.ProcessEnv;
    }
  | {
      runtime: "local-agent";
      agent: "claude";
      model: null;
      env: NodeJS.ProcessEnv;
    };

export class RuntimeProviderError extends Error {
  // ⚠️ 不用构造函数参数属性:`erasableSyntaxOnly` 下那不是可擦除语法(Node 剥类型跑不了)
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** CLI 订阅档：用本机已登录的引擎，**不需要 key** */
export const isCliProvider = (p: string): boolean => p.startsWith("cli-");

/**
 * 订阅档必须明确映射到真实 runtime。当前是产品自带 Codex + 本机 Claude Code；
 * 其余 CLI 没有安全适配器就拒绝。
 *
 * 🔴 界面只列已经有真实适配器的 Codex / Claude；旧 localStorage 或手工请求仍可能
 *    带来 Qwen / DeepSeek 等 `cli-*`。如果这里对所有 CLI 一律回落到自带引擎，
 *    用户选了 Claude、答案却出自 Codex —— 而且**界面上一个字都不会提示**。
 *    这正是本文件开头那条纪律说的"账单和产出来自别处"。⇒ 认不出的一律报错。
 */
const LOCAL_AGENT_BY_PROVIDER = Object.freeze({ "cli-claude": "claude" } as const);

/** 自定义端点用的固定 env 变量名 —— 只存在于内存里的这一份 env */
const RUNTIME_KEY_VAR = "VRA_RUNTIME_API_KEY";

/**
 * 把界面给的一份配置解析成引擎能用的 provider + 环境。
 *
 * 🔴 **认不出的 provider 直接报错，不回落到默认** —— 悄悄换成另一家去打，
 *    用户以为在用自己选的模型，账单和产出却来自别处，而且不会有任何提示。
 */
export function resolveRuntimeProvider(
  repoRoot: string, dataRoot: string, llm: LlmOverride, baseEnv: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeProvider {
  const id = String(llm.provider ?? "").trim();
  if (!id) throw new RuntimeProviderError("bad_provider", "没有指定 provider");

  // ① CLI 订阅：走本机已登录态，免 key
  if (isCliProvider(id)) {
    if (id === "cli-codex") {
      return {
        runtime: "codex",
        profile: BUILTIN_OPENAI_PROFILE,
        auth: "chatgpt_login",
        // 🔴 订阅档**不转发模型名**：模型由登录态决定，界面上那个 id 只是显示用的标签。
        model: null,
        env: baseEnv,
      };
    }
    if (id in LOCAL_AGENT_BY_PROVIDER) {
      return { runtime: "local-agent", agent: LOCAL_AGENT_BY_PROVIDER[id as keyof typeof LOCAL_AGENT_BY_PROVIDER], model: null, env: baseEnv };
    }
    {
      throw new RuntimeProviderError("unsupported_cli", `订阅档当前只支持 Codex 与 Claude Code，接不上 ${id}`);
    }
  }

  const key = String(llm.apiKey ?? "").trim();
  const base = String(llm.baseURL ?? "").trim();

  // ② 任意 OpenAI 兼容端点：现搭一份档案（没有实测记录，如实标出来）
  if (id === "openai-compatible" || id === "custom") {
    if (!base) throw new RuntimeProviderError("missing_base_url", "自定义端点必须填 baseURL");
    if (!key) throw new RuntimeProviderError("missing_key", "自定义端点必须填 API key");
    // ⚠️ 与 ③ 用同一把尺子：只放 http(s)。两条分支各判各的，迟早漂移
    const checked = assertHttp(base);
    // ⚠️ 手搓的档案最容易与契约漂移 —— 走一遍与磁盘模板同一把尺子
    const synthesized = validateProfile(
      {
        id: "openai-compatible", name: `自定义端点(${hostOf(checked)})`,
        // 🔴 **不能写 "chat"**:引擎 0.149.0 已彻底移除 chat 协议(providers.ts 里那条硬报错)。
        //    ⇒ 自填端点必须支持 Responses API;不支持的话这里说不了谎,只能让它在连接时报错。
        wire_api: "responses", base_url: checked, env_key: RUNTIME_KEY_VAR,
        auth_modes: ["api_key"], requires_openai_auth: false,
                // native = "端点自己会说 Responses"。这是我们对用户端点的**要求**,不是实测结论;
        //          "实测过没有"由 matrix.status 说(下面写死 unverified)。
        default_model: llm.model?.trim() || null, responses_support: "native",
        // 🔴 没跑过兼容矩阵就**别声称跑过**
        matrix: { status: "unverified", note: "用户自填端点，产品没有实测过它的兼容性" },
      },
      "用户自填端点",
    );
    return {
      runtime: "codex",
      profile: synthesized,
      auth: "api_key",
      model: llm.model?.trim() || null,
      env: { ...baseEnv, [RUNTIME_KEY_VAR]: key },
    };
  }

  // ③ 产品自带的实测模板
  if (!PROVIDER_ID_RE.test(id)) throw new RuntimeProviderError("bad_provider", `provider 名不合法:${id}`);
  if (!templateIds(repoRoot, dataRoot).includes(id)) {
    throw new RuntimeProviderError("unknown_provider", `没有这个 provider 的模板:${id}（可选见 providers/ 目录）`);
  }
  if (!key) throw new RuntimeProviderError("missing_key", `${id} 需要 API key`);
  // ⚠️ baseURL 允许覆盖（私有网关 / 填占位符），但**必须是 http(s)** —— 别让它变成一条本地文件路径。
  //    覆盖值交给 loadProviderProfile 在**校验之前**替换：带占位符的模板只有这样才用得起来。
  let profile: ProviderProfileFile;
  try {
    profile = loadProviderProfile(repoRoot, dataRoot, id, base ? assertHttp(base) : undefined).profile;
  } catch (e) {
    if (e instanceof RuntimeProviderError) throw e;
    const raw = e instanceof Error ? e.message : String(e);
    // ⚠️ 占位符这一条要说**在界面上怎么办**：模板层的原话是"复制模板到数据根去改"，
    //    那是给命令行用户的活；界面上有 Base URL 输入框，照原话说等于让人去做多余的事。
    const ph = /占位符 ([{<][^}>]+[}>])/.exec(raw);
    if (ph && !base) {
      throw new RuntimeProviderError(
        "needs_base_url", `${id} 的端点地址里有占位符 ${ph[1]}，请在 Base URL 里填上你自己的值再保存`,
      );
    }
    // 其余模板问题原样说给用户，别糊成"未知 provider"
    throw new RuntimeProviderError("bad_template", raw);
  }
  return {
    runtime: "codex",
    profile,
    auth: "api_key",
    model: llm.model?.trim() || profile.default_model,
    // 🔴 按模板声明的变量名注入。用固定名的话，模板里 env_http_headers 引用的变量就对不上了
    env: { ...baseEnv, [profile.env_key]: key },
  };
}

/**
 * baseURL 只放 http(s)，且**不许带 URL userinfo**（`https://user:pass@host` 那种）。
 *
 * ⚠️ 说清楚挡住的**只有 userinfo** —— `?api_key=…` 这类把凭据放进 query 的写法拦不住，
 *    也不打算拦：常见网关的合法参数长得一模一样，靠猜参数名去拦只会误伤
 *    （Codex 复审 r3 指出注释原来把这条说大了 —— 注释不能替代码许愿）。
 *    真正兜底的是下一条：**报错绝不回显原串**。
 *
 * 🔴 报错**绝不回显原串**：不管凭据藏在 userinfo、query 还是路径里，只要不把 URL 拼进
 *    错误消息，它就不会一路回到前端、也不会被上层记下来 —— "密钥不落盘"这条承诺
 *    在**报错路径**上才算真的成立。
 *
 * ⚠️ **刻意不做私网/回环封禁**（Codex 审计 r1 提过 SSRF）：这是**本机桌面产品**，
 *    填 URL 的人就是这台机器的主人，没有"被当跳板的服务端"这个角色；
 *    而"私有网关"是**文档化的正当用法**（MiMo 就是私有网关）。封 RFC1918 / localhost
 *    会打死真实用户，换不来对应的安全收益。
 */
function assertHttp(u: string): string {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new RuntimeProviderError("bad_base_url", "baseURL 不是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RuntimeProviderError("bad_base_url", `baseURL 只能是 http(s)，收到 ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new RuntimeProviderError("bad_base_url", "baseURL 里不要带用户名密码（user:pass@），把 key 填到下面的 API Key 里");
  }
  return u;
}

function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u.slice(0, 40); }
}

/** 产品自带的模板清单（只说"有没有这份模板"，**不代表跑过兼容矩阵**） */
export function templateIds(repoRoot: string, dataRoot: string): string[] {
  return Object.keys(templateMatrix(repoRoot, dataRoot)).sort();
}

/**
 * 每份模板**自己声明的**兼容矩阵状态：`baseline` / `partial` / `pass` = 真跑过；
 * `untested` = 只是写好了模板、**没跑过**。
 *
 * 🔴 界面靠这个打「已实测」标。**不能用"目录里有这个文件"当判据** ——
 *    6 份模板里只有 2 份真跑过（openai=baseline、mimo=partial），另外 4 份是 `untested`。
 *    按文件存在来标，界面上会出现 4 条**假的「已实测」**（Codex 审计 r2 P2，核实属实）。
 *    产品的立身之本是不拿没验过的冒充验过的，这一处正好是反例。
 * ⚠️ 这里**不做 validateProfile**：带占位符的模板（百炼那三份）按设计会被它拒掉，
 *    而"它跑没跑过矩阵"与"用户填没填占位符"是两件事。读不动 / 读坏的当 unknown。
 */
export function templateMatrix(repoRoot: string, dataRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 用户数据根后读 ⇒ 用户自己放的同名模板覆盖产品那份（与 loadProviderProfile 的优先级一致）
  for (const dir of [path.join(repoRoot, "providers"), path.join(dataRoot, "providers")]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { matrix?: { status?: unknown } };
        const st = raw.matrix?.status;
        out[id] = typeof st === "string" && st ? st : "unknown";
      } catch {
        out[id] = "unknown";
      }
    }
  }
  return out;
}
