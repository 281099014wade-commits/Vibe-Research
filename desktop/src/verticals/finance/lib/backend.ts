/**
 * 与**我们自己的底座**(Node 编排器)通话的一层。
 *
 * 界面整套来自开源版 Vibe-Research;它原来打的是开源版的 Python 后端(`/api/valuation`
 * 这种一问一答的语义接口)。我们的底座只有一个通用取数入口 `/fetch`(端点 id + 证据信封),
 * 外加台账 / 对话 / 辩论 / 运行。**差异全部收在这一层与 `api.ts` 的映射里**,
 * 上游的页面代码一行不用改。
 *
 * 🔴 **鉴权不在这里**:Bearer token 由 Vite 代理注入,浏览器侧不持有(见 vite.config.ts)。
 *    密钥永远不进浏览器 —— 这条与上游最大的不同,也是唯一必须改写的一层。
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 一条证据。所有端点的 evidence 元素都是这个形状,所以一套读法能服务全部端点。 */
export interface Evidence {
  id: string;
  symbol: string;
  market: string;
  field: string;
  value: number | string | null;
  unit: string;
  currency: string;
  period: string;
  as_of: string;
  source: string;
  endpoint: string;
  fetched_at: string;
  adjustment: string;
  raw_ref: string | null;
  note?: string;
  record_key?: string;
}

export interface Envelope {
  script: string;
  symbol: string;
  market: string;
  /** ok / partial / failed —— **partial 不是失败**,是"拿到一部分",要照实用而不是当空 */
  status: string;
  fetched_at: string;
  primary_source: string | null;
  used_sources: string[];
  evidence: Evidence[];
  extra?: Record<string, unknown>;
  errors: unknown[];
  missing: unknown[];
}

export interface FetchResult {
  envelope: Envelope;
  duration_ms: number;
  cached: boolean;
  fetched_at: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (e) {
    // fetch 只在网络层失败时抛。这里不能静默成空数据,否则页面把"连不上"渲染成"没有数据"
    throw new ApiError(`连接不到编排器 API:${e instanceof Error ? e.message : String(e)}`, 0, "network");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 代理错误页是 HTML,直接 res.json() 会炸在 "Unexpected token <",把真正原因埋掉
    throw new ApiError(`返回不是 JSON:${text.slice(0, 120)}`, res.status, "bad_response");
  }
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    throw new ApiError(b?.message ?? b?.error ?? `HTTP ${res.status}`, res.status, b?.error ?? String(res.status));
  }
  return body as T;
}

export const backend = {
  health: () => call<{ ok: boolean; version: string }>("/health"),
  product: () => call<ProductInfo>("/product"),

  /**
   * 取一个端点。**默认读上次的快照**(见 service.fetchEndpoint):
   * 打开页面不重跑上游,真取数只发生在用户点刷新时。
   */
  fetch: (endpoint: string, opts: { symbol?: string; args?: Record<string, unknown>; refresh?: boolean } = {}) =>
    call<FetchResult>("/fetch", {
      method: "POST",
      body: JSON.stringify({
        endpoint,
        ...(opts.symbol ? { symbol: opts.symbol } : {}),
        ...(opts.args ? { args: opts.args } : {}),
        ...(opts.refresh ? { refresh: true } : {}),
      }),
    }),

  ledger: () =>
    call<{
      kinds: Record<string, { label: string; properties: Record<string, unknown>; required: string[] }>;
      labels: { fields: Record<string, string>; enums: Record<string, string> };
      records: Record<string, LedgerRecord[]>;
      issues: Record<string, { id: string; why: string }[]>;
    }>("/ledger"),
  ledgerSave: (kind: string, record: Record<string, unknown>) =>
    call<LedgerRecord>(`/ledger/${encodeURIComponent(kind)}`, { method: "POST", body: JSON.stringify(record) }),
  ledgerDelete: (kind: string, id: string) =>
    call<{ removed: boolean }>(`/ledger/${encodeURIComponent(kind)}/delete`, { method: "POST", body: JSON.stringify({ id }) }),

  /**
   * 一轮对话。
   * ⚠️ `session` **必须按页面分开传**：后端按 session 维护线程，而前端只发最后一句 ——
   *    全站共用 "default" 的话，后端那条线程会把所有页面的对话串成一段，
   *    而界面上每页各自干净，这种不一致从界面上完全看不出来。
   */
  chat: (message: string, session = "default", signal?: AbortSignal) =>
    call<{ session: string; reply: string; redacted: number; duration_ms: number }>("/chat", {
      method: "POST",
      body: JSON.stringify({ session, message }),
      signal,
    }),

  /** 垂类工具:清单由后端下发,前端**不写死一份**(写死的那份迟早与真实实现对不上) */
  tools: () => call<{ tools: { name: string; label: string }[] }>("/tools"),
  /**
   * 跑一个垂类工具。
   * ⚠️ 这类工具要先取数再算,**几十秒**很正常 —— 调用方要自己给足耐心与进度反馈。
   * 🔴 返回的 JSON 由工具自己定形状(比如"被拦住"与"出错了"分开),这里原样透传。
   */
  runTool: <T>(name: string, body: unknown, signal?: AbortSignal) =>
    call<T>(`/tool/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify(body), signal }),
  debateStart: (symbol: string) => call<DebateState>("/debate", { method: "POST", body: JSON.stringify({ symbol }) }),
  debateAdvance: (id: string) =>
    call<DebateState>(`/debate/${encodeURIComponent(id)}/advance`, { method: "POST", body: "{}" }),

  /** 端点观测序列(跨运行累积)。⚠️ 只在**完整研究运行**时追加,手动点看板不写 —— 稀疏是正常的 */
  series: (endpoint: string) =>
    call<{ endpoint: string; observations: ThermoObservation[]; exists: boolean; unreadable: boolean; dropped: number }>(
      `/series/${encodeURIComponent(endpoint)}`,
    ),

  runs: (limit = 50) => call<RunListItem[]>(`/runs?limit=${limit}`),
  report: (id: string) =>
    call<{ run_id: string; report: string | null; appendix: string | null }>(`/runs/${encodeURIComponent(id)}/report`),
};

export interface LedgerRecord {
  id: string;
  kind: string;
  created_at: string;
  updated_at: string;
  [field: string]: unknown;
}

/** `/product` 的脱敏投影。🔴 只有环境变量**名**与一个布尔,**没有密钥值** */
export interface ProductInfo {
  version: string;
  provider: {
    name: string;
    profile: string | null;
    wire_api: string;
    base_url: string | null;
    auth: string;
    env_key: string;
    key_present: boolean;
  };
  defaults: Record<string, unknown>;
  paths: { data_root: string; codex_home: string; python: string };
  sources: string[];
  auth_error: string | null;
}

export interface DebateStage {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed";
  text: string;
  error?: string;
}
export interface DebateState {
  id: string;
  symbol: string;
  evidence_count: number;
  gaps: string[];
  stages: DebateStage[];
  /** 跑完了。**不代表跑成了** —— 看 outcome */
  done: boolean;
  outcome: "running" | "completed" | "completed_with_errors" | "failed";
}
export interface ThermoObservation {
  run_id: string; run_date: string; as_of: string; fetched_at: string;
  record_key: string; field: string; value: number | string | null;
  unit: string; period: string; raw_ref: string | null; source: string;
}
export interface RunListItem {
  run_id: string;
  status: string | null;
  symbol: string | null;
  started_at: string | null;
  finished_at: string | null;
  stages_done: number | null;
  stages_total: number | null;
  test_scenario: boolean;
}

/* ---------- 信封读法 ---------- */

/**
 * 资料期的可比形式:把每一段数字**补齐到 8 位**再比。
 *
 * 🔴 直接用字符串比 period 是错的:`"2026-10-31" < "2026-9-30"` 为**真**(字符 `1` < `9`),
 *    月份没补零时"取最新"会取到旧的那条 —— 而两个值都是真数,看不出取错了。
 *    补齐之后 `2026-00000010-...` > `2026-00000009-...`,顺序才对。
 *    也顺带让 `FY2026 / FY2027`、纯日期这些形状都能比。
 */
export function periodKey(period: string | undefined): string {
  return (period ?? "").replace(/\d+/g, (d) => d.padStart(8, "0"));
}

export interface Row {
  key: string;
  note: string;
  fields: Record<string, Evidence | undefined>;
}

/**
 * 取数层是**长表**:同一个信封里 N 个 record_key × M 个 field 平铺成一串证据。
 * 页面要的是"一行一个对象",所以统一透视一次 —— 每处各写一遍分组逻辑,迟早写出不一样的口径。
 */
export function rows(env: Envelope | undefined): Row[] {
  const byKey = new Map<string, Row>();
  for (const e of env?.evidence ?? []) {
    if (!e.record_key) continue; // 没有 record_key 的是整体指标,单独取
    let r = byKey.get(e.record_key);
    if (!r) {
      r = { key: e.record_key, note: e.note ?? "", fields: {} };
      byKey.set(e.record_key, r);
    }
    /**
     * 同一个 key+field 出现多条(多个报告期 / 修订版)时:**取资料期最新的那条**。
     * 🔴 原来是"保留第一条",等于把口径押在后端的返回顺序上 ——
     *    上游哪天改了排序,页面就会从最新一期悄悄切到旧一期,数字全变但不报错。
     *    "最新" 是个确定性规则,不依赖顺序。
     */
    const prev = r.fields[e.field];
    if (!prev || periodKey(e.period) > periodKey(prev.period)) r.fields[e.field] = e;
    if (!r.note && e.note) r.note = e.note;
  }
  return [...byKey.values()];
}

/**
 * 整体指标。优先取"没有 record_key 的那一条";
 *
 * 🔴 **单标的端点会把代码写进 record_key**(`tx_quote` 的每条都是 `record_key: "300308"`),
 *    只认"没有 record_key"会一条都找不到 —— 而 `num()` 把找不到读成 null、页面再兜底成 0,
 *    表现是**现价 / PE / 市值全是 0**,不报错、不空白,看着像"这只股票就是 0"。
 *    ⇒ 整份信封只有一个 record_key 时(即它本来就只讲一个标的),取那一条。
 *    多个 record_key 时**不猜**,返回 undefined —— 那种信封本来就该用 rows() 读。
 */
export function scalar(env: Envelope | undefined, field: string): Evidence | undefined {
  const hit = env?.evidence.find((e) => e.field === field && !e.record_key);
  if (hit) return hit;
  const keys = new Set((env?.evidence ?? []).map((e) => e.record_key).filter(Boolean));
  if (keys.size !== 1) return undefined;
  return env?.evidence.find((e) => e.field === field);
}

/**
 * 取数值。**取不到给 null 不给 0** —— 0 会被读成"确实是零",而真相是"没有"。
 *
 * 🔴 空字符串必须先挡掉:`Number("")` 与 `Number("   ")` 都等于 **0**,
 *    且 `Number.isFinite(0)` 为真 ⇒ 上游用 "" 表达"这个字段没有"时,
 *    这里会一路放行成 0,现价 / 市值 / PE 全变成 0,**而这个函数的注释还写着给 null**。
 *    (这正是本层反复出现的那一类:不报错、不空白、值是错的。)
 */
export function num(e: Evidence | undefined): number | null {
  if (!e || e.value === null) return null;
  if (typeof e.value === "string" && e.value.trim() === "") return null;
  const n = typeof e.value === "number" ? e.value : Number(e.value);
  return Number.isFinite(n) ? n : null;
}

export function str(e: Evidence | undefined): string {
  return e && e.value !== null ? String(e.value) : "";
}

/** 数值,取不到时给 0 —— **只用在上游类型写死了 number 的地方**,别拿它当默认读法 */
export const num0 = (e: Evidence | undefined): number => num(e) ?? 0;

/** 保留两位,给不出就 null */
export function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

/**
 * note 里的 `键=值;键=值` 片段(新闻 / 研报类端点一致采用)。
 * 🔴 只按白名单精确取,不做通用 split —— 正文里本身就含分号,通用切分会切出一堆垃圾键且不报错。
 */
const KV_KEYS = [
  "source", "url", "link", "published", "domain", "topic", "name", "kind", "author",
  "orgSName", "emRatingName", "indvInduName", "pdfUrl", "reason", "type", "进度", "报告期",
  // ⚠️ 白名单漏一个键,前一个键的值就会把它连同后面的内容一起吞掉
  //    (漏 industry 时 source 取出来是 "MIT Tech Review AI;industry=ai")
  "industry", "n_offers", "gpu", "depreciation_line_usd",
  // 🔴 新加的键**必须登记在这儿**：白名单外的键会被安静地丢掉，界面上表现为
  //    "那一行就是不显示"，而代码里明明取了 —— 这次现货卡的"可租 X / 共 Y 张"
  //    与观测时间就是这么消失的。
  "asof_ts", "available_gpus", "total_gpus",
  // 🔴 **同一个坑的第三次**(前两次:研报的 industry、GPU 现货卡的可租张数)。
  //    个股研究页的板块名 / 龙头 / 涨跌、大宗交易的买卖方全在 note 里,
  //    没登记 → noteKV 取到 undefined → 上层回退成"把整条 note 当文本显示",
  //    界面上出现 `板块代码=BK0438;当日涨跌=-0.38%;龙头=五芳斋` 这种内部字符串。
  "买方", "卖方", "当日涨跌", "龙头", "板块代码", "概念",
] as const;
/**
 * 🔴 **取哪些键靠白名单,但"值到哪结束"不能靠白名单。**
 *    终止符只认白名单时,只要 note 里出现一个没登记的键(`predictThisYearEps=` / `industry=`),
 *    上一个键的值就会把它连同后面的内容一起吞掉 —— 界面上表现为
 *    「评级 = 买入; predictThisYearEps=32.41; ...」这种一眼假但不报错的值。
 *    ⇒ 终止符改成**任何"标识符="形状**(ASCII 标识符,或白名单里那几个中文键),
 *      再加一个键就不用回来改这里。
 */
// ASCII 标识符 **或** 2-8 字的中文键(`资料期=` 这种)。前者覆盖 predictThisYearEps 一类,
// 后者覆盖取数层里的中文字段名 —— 只写白名单里那几个中文键,等于对没登记的中文键继续失效。
// ⚠️ 中文键要从**一个字**起算(`年=2026`)。写 {2,8} 的话单字键仍会被上一个字段吞掉,
//    而注释宣称的是"任何标识符形状" —— 又是一次代码没做到注释承诺的事。
const KV_TERM = "(?:[A-Za-z_][A-Za-z0-9_]*|[\\u4e00-\\u9fa5]{1,8})=";
// ⚠️ 第三个终止符 `;<末尾一段不含等号的文字>$`:note 常以一句**没有键的尾注**收尾
//    (`;单位按东财数据中心口径`、护栏句)。不挡的话最后一个键的值会把它一起吞掉 ——
//    界面上就是「卖方 = 广发证券…营业部;单位按东财数据中心口径」这种一眼假但不报错的值。
//    只在**字符串末尾**且**那一段不含 `=`** 时匹配,所以不会误伤正常的 `k=v;k=v`。
const KV = new RegExp(
  `(?:^|;)\\s*(${KV_KEYS.join("|")})=([\\s\\S]*?)(?=;\\s*${KV_TERM}|;\\s*读法:|;\\s*[^;=]+$|$)`,
  "g",
);

export function noteKV(note: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (note ?? "").matchAll(KV)) {
    const k = m[1];
    const v = m[2];
    if (k && v !== undefined && !(k in out)) out[k] = v.trim();
  }
  return out;
}

const notWiredError = (what: string) =>
  new ApiError(`「${what}」还没接到底座上(不是没有数据,是这条链路还没做)`, 501, "not_wired");

/**
 * 这一块底座还没接 —— **返回一个被拒绝的 Promise**。
 *
 * 🔴 不返回空数组:返回空会让页面显示"这里没有数据",而真相是"这条链路还没做",
 *    两件事的处置完全不同。
 * 🔴🔴 **必须是异步拒绝,不能同步 throw**。签名写着 `(): Promise<T>` 的函数如果
 *    同步抛,调用方的 `.catch()` **根本挂不上** —— 异常在 Promise 存在之前就冲出去了,
 *    直接掀掉整个页面(实测:落地页因此白屏,错误是"全球指数还没接")。
 *    ⇒ 页面里那些 `api.xxx().catch(() => {})` 的降级,只有异步拒绝才接得住。
 */
export function notWired<T = never>(what: string): Promise<T> {
  return Promise.reject(notWiredError(what));
}

/** 同步语境用的版本(函数体本身是 async 时,里面 throw 会自动变成拒绝) */
export function throwNotWired(what: string): never {
  throw notWiredError(what);
}
