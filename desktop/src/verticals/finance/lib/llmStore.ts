/**
 * 用户模型配置的**唯一存放处**（localStorage，不上传、不进仓库、不落盘）。
 *
 * 🔴 单独成一个模块，是为了让**传输层 `backend.chat` 自己**就能读到它 ——
 *    放在 `llm.ts` 里会与 `backend.ts` 形成循环依赖，于是只能由调用方逐个记得传，
 *    而**记不住就是默认行为**：实测里 Agent 面板（`FinanceAiDock`）与 `agents.ts`
 *    两条最常用的路都没传，用户在界面上选的模型根本没生效 —— 对话照常成功、
 *    照常有答案，只是出自另一家，**界面上一个字都看不出来**。
 *    ⇒ 防线只守住三个入口里的一个，就等于没有防线。
 */

/** 用户自己那一份存在这儿 */
export const LLM_KEY = "vr-llm";

export interface LlmConfig {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

/** CLI 订阅档：用本机已登录的引擎，免 API key */
const isCli = (p: string): boolean => p.startsWith("cli-");

/**
 * 这份配置**后端收不收**。
 *
 * 🔴 口径必须与 `orchestrator/src/runtime_provider.ts` 一致。两边各判一半的后果是分岔的：
 *    前端严一点 ⇒ 明明能用的配置被判「坏了」（`cli-codex` 不填 model、模板只填 provider+key
 *    都属此列，后端接受得好好的）；前端松一点 ⇒ 用户看到"已配置"、一提问才报错。
 *    （Codex 复审 r3 指出，实跑两端确认过。）
 * ⚠️ 只判**形状**，不判 provider 认不认识 —— 那是后端的事，它给的错误码更可行动。
 */
function isUsable(c: LlmConfig): boolean {
  if (!c.provider) return false;
  if (isCli(c.provider)) return true;                                   // 订阅档：免 key，模型由登录态定
  if (c.provider === "openai-compatible" || c.provider === "custom") {
    return Boolean(c.baseURL && c.apiKey);                              // 自填端点：端点 + key 必给，model 可空
  }
  return Boolean(c.apiKey);                                             // 产品模板：key 必给，baseURL / model 可从模板取
}

/**
 * 本地这份配置的状态。
 *
 * 🔴 **三种情况必须分开**，不能都返回 null：
 *    - `none`（真没配）才允许回落到后端默认；
 *    - `broken`（存着但读不懂 / 字段不全）当没配 = **静默换一家去打**，
 *      对话照常有答案，用户完全看不出自己选的模型没生效；
 *    - `unavailable`（隐私模式、存储被策略拒绝）同理，而且每次打开都会重演。
 *    （Codex 审计 r2 P2，核实属实。）
 */
export type LlmStatus = "none" | "ok" | "broken" | "unavailable";

export interface LlmRead {
  status: LlmStatus;
  config: LlmConfig | null;
}

export function readUserLlm(): LlmRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LLM_KEY);
  } catch {
    return { status: "unavailable", config: null };
  }
  if (!raw) return { status: "none", config: null };
  try {
    const c = JSON.parse(raw) as Partial<LlmConfig>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const cfg: LlmConfig = {
      provider: str(c.provider), baseURL: str(c.baseURL), apiKey: str(c.apiKey), model: str(c.model),
    };
    return isUsable(cfg) ? { status: "ok", config: cfg } : { status: "broken", config: null };
  } catch {
    return { status: "broken", config: null };
  }
}

/** 用户自己配的那一份（没配 / 坏了都返回 null）。**要分清哪种，用 `readUserLlm`。** */
export function loadUserLlm(): LlmConfig | null {
  return readUserLlm().config;
}

/** 存不下时抛错 —— 静默失败会让用户以为配好了，下次打开又是空的 */
export function saveUserLlm(cfg: LlmConfig): void {
  localStorage.setItem(LLM_KEY, JSON.stringify(cfg));
}

/**
 * 清除。**失败要抛**，并且**回读确认**真的没了。
 * 🔴 吞掉异常的话，界面会说"已清除"，而旧 key 还躺在 localStorage 里、
 *    下一次提问照样被发出去 —— 界面说的和事实相反，这比报错难查得多。
 */
export function clearUserLlm(): void {
  localStorage.removeItem(LLM_KEY);
  if (localStorage.getItem(LLM_KEY) !== null) throw new Error("本地存储没能删掉这条配置");
}
