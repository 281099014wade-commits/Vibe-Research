/**
 * 编排器 API 客户端。
 * 🔴 **类型是手抄的,不是生成的** —— 下面每个接口都对应 orchestrator/src/service.ts 的导出接口,
 *    改后端形状时这里必须跟着改(注释里标了行号锚点)。前端不做兜底猜测:后端没给的字段就是没有,
 *    别在这里编默认值,否则页面会把"缺数据"渲染成"数据是 0"。
 * 鉴权:开发期由 Vite 代理注入 Bearer(见 vite.config.ts),浏览器侧不持有 token。
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (e) {
    // fetch 只在网络层失败时抛;这里不能静默成空数据,否则页面会显示"没有运行"而不是"连不上"
    throw new ApiError(0, "network", e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 后端异常时可能返回 HTML(代理错误页 / 反代插页),把前 120 字带上比"Unexpected token <"有用得多
    throw new ApiError(res.status, "bad_response", `返回不是 JSON:${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    throw new ApiError(res.status, b?.error ?? String(res.status), b?.message ?? b?.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

/* ---------- 与 service.ts 一一对应的形状 ---------- */

/** service.ts:144 EndpointSummary */
export interface EndpointSummary {
  id: string;
  title?: string;
  layer?: string;
  market: string[];
  source?: string;
  compliance?: string;
  symbol_kind?: string;
  stages: Record<string, string>;
  enabled: boolean;
  auth_env?: string;
  computed?: boolean;
  notes?: string;
  args?: Record<string, unknown>;
}

/**
 * 一条证据。**所有端点的 evidence 元素都是这个形状**(实测 tx_quote / 温度计 / 头条一致),
 * 所以一套渲染器能服务全部端点 —— 别为某个页面另开一种"更方便"的结构。
 */
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
  /** 原始落盘文件的相对路径;`null` 表示这条不是抓来的(如合成/注入) */
  raw_ref: string | null;
  note?: string;
  record_key?: string;
}

/** 取数信封。取数脚本的统一返回契约。 */
export interface Envelope {
  script: string;
  symbol: string;
  market: string;
  /** ok / partial / failed —— **partial 不是失败**,是"拿到一部分",要照实显示而不是当空 */
  status: string;
  fetched_at: string;
  primary_source: string | null;
  used_sources: string[];
  evidence: Evidence[];
  extra?: Record<string, unknown>;
  errors: unknown[];
  /** 明确说明"这几项没拿到" —— 缺口是要显示的信息,不是要藏起来的瑕疵 */
  missing: unknown[];
}

/** service.ts:167 FetchResult */
/** service.ts `PageBlockResult` —— 一屏里的一块 */
export interface PageBlock {
  id: string;
  title: string;
  note?: string;
  /** 默认收起(数据照常取回,收的只是显示) */
  collapsed?: boolean;
  status: "ok" | "missing";
  error?: string;
  fetched_at?: string;
  cached?: boolean;
  envelope?: Envelope;
  /** 这一块允许用户改的参数键(后端白名单)+ 当前生效值。**照它渲染选择器,不自己写死可选项** */
  user_args?: string[];
  applied_args?: Record<string, unknown>;
}

/** service.ts `PageResult` —— 一屏数据 */
export interface PageResult {
  query: string;
  title: string;
  intent: string;
  /** 业务上下文(这一页在看哪一天、为什么)。不需要解析的页面为 null */
  context: Record<string, unknown> | null;
  blocks: PageBlock[];
  /** 整屏最旧的取数时刻 —— 整页新鲜度不能好过它最差的那一块 */
  oldest_fetched_at: string | null;
  /** 各块取数时刻跨了不同的天。只在每块标"X 分钟前"不够,用户会把一屏当成同一时刻的快照 */
  mixed_ages: boolean;
}

export interface FetchResult {
  envelope: Envelope;
  exit_code: number | null;
  out_dir: string;
  duration_ms: number;
  stderr_tail: string;
  /** true = 这份是**上次取的快照**,没有重新取数 */
  cached: boolean;
  /** 这份数据什么时候取到的。**必须显示** —— 拿旧数据不说是旧的等于骗人 */
  fetched_at: string;
}

/** service.ts:200 StartResult */
export interface StartResult {
  run_id: string;
  run_dir: string;
  log: string;
  pid: number | undefined;
}

/** service.ts:225 RunStatus */
export interface RunStatus {
  run_id: string;
  exists: boolean;
  status: string | null;
  exit_code: number | null;
  stages: { stage: string; status: string; attempts: number }[];
  evidence_count: number | null;
  calculation_count: number | null;
  finished_at: string | null;
  last_events: Record<string, unknown>[];
  report: boolean;
  viewer: string | null;
}

/** service.ts:281 listRuns 的元素 */
export interface RunListItem {
  run_id: string;
  status: string | null;
  symbol: string | null;
  started_at: string | null;
  finished_at: string | null;
  /**
   * 跑完了几个阶段 / 一共几个。**读不出来时是 null,不是 0** ——
   * 0 会被读成"一个阶段都没跑",而真相是"不知道"。
   */
  stages_done: number | null;
  stages_total: number | null;
  /** 注入了合成数据的测试运行:结论不能当真实研究看 */
  test_scenario: boolean;
}

/** service.ts:256 getReport */
export interface ReportResult {
  run_id: string;
  report: string | null;
  appendix: string | null;
}

/** service.ts:261 getEvidence */
export interface EvidenceResult {
  run_id: string;
  total: number;
  items: Record<string, unknown>[];
}

/** knowledge.ts:51 KnowledgeRecall(path 已被 service 层改成相对路径) */
export interface KnowledgeRecall {
  path: string;
  as_of: string;
  status: "fresh" | "stale";
  valid_days: number;
  text: string;
  truncated: boolean;
  run_id: string | null;
}

/**
 * 用户自有台账。**与研究产物是两回事**:研究产物是取来的事实(带证据 id、可复算),
 * 台账是用户自己写下的东西 —— 页面上不要把它俩混在一张表里显示。
 */
export interface LedgerKindDef {
  label: string;
  /** JSON Schema 片段;表单按它渲染字段(类型 / 枚举 / 长度) */
  properties: Record<string, unknown>;
  required: string[];
}

/** service.ts `ledgerIssues` 的回报项:哪条记录不合契约、哪儿不合 */
export interface LedgerIssue {
  id: string;
  why: string;
}

export interface LedgerRecord {
  id: string;
  kind: string;
  created_at: string;
  updated_at: string;
  [field: string]: unknown;
}

/** 自由对话的一轮。`redacted > 0` = 有行触发产出红线被移除,界面要说出来 */
export interface ChatTurnResult {
  session: string;
  reply: string;
  redacted: number;
  duration_ms: number;
}

/** 导入转写的一条草稿。**没有 id/kind/created_at** —— 那是真正落库时 Core 才给的 */
export interface IngestDraft {
  /** 缺了哪些必填字段。非空 = 这条按现状存不进去,界面要禁掉「确认写入」并说清缺什么 */
  missing_required?: string[];
  source_file: string;
  fields: Record<string, unknown>;
  /** agent 自己说哪里没看清;非空 = 这条要重点核 */
  uncertain: string[];
}

export interface IngestResult {
  batch: string;
  kind: string;
  dir: string;
  drafts: IngestDraft[];
  warnings: string[];
  duration_ms: number;
}

/** service.ts `productInfo` —— 有效配置的**脱敏投影**(不含任何密钥值) */
export interface ProductInfo {
  version: string;
  provider: {
    name: string;
    profile: string | null;
    wire_api: string;
    base_url: string | null;
    auth: string;
    /** 环境变量的**名字**,不是它的值 */
    env_key: string;
    /** 那个环境变量有没有被设。只有布尔,没有内容 */
    key_present: boolean;
  };
  defaults: Record<string, unknown>;
  paths: { data_root: string; codex_home: string; python: string };
  /** 这份配置由哪几层合出来的(产品默认 ← 用户配置 ← 环境变量) */
  sources: string[];
  /** 缺密钥之类的问题;null = 没问题 */
  auth_error: string | null;
}

/** debate.ts `DebateState` —— 一场多空辩论的状态 */
export interface DebateStage {
  id: string;
  label: string;
  status: "pending" | "done" | "failed";
  text: string;
  error?: string;
}

export interface DebateState {
  id: string;
  symbol: string;
  /** 资料包里有多少条证据 —— 双方是在多少事实上打 */
  evidence_count: number;
  /** 哪些来源没取到。**必须显示** —— 少一块,辩论的地基就窄一截 */
  gaps: string[];
  stages: DebateStage[];
  /** 跑完了(不再有待跑的)。**这不代表跑成了** —— 看 `outcome` */
  done: boolean;
  /** 🔴 全部阶段都失败时 `done` 也是 true;只看 done 会把"五段全空"显示成"正常完成" */
  outcome: "running" | "completed" | "completed_with_errors" | "failed";
}

/* ---------- 端点 ---------- */

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/health"),

  /**
   * 产品当前的有效配置(设置页用)。
   * 🔴 **后端只给 `env_key`(变量名)与 `key_present`(布尔),永远不给密钥值** ——
   *    所以这一页是**只读**的:换 provider 要动配置文件 + 环境变量,
   *    界面上没有、也不该有"把 key 粘进来"的输入框。
   */
  product: () => request<ProductInfo>("/product"),

  /**
   * 开一场多空辩论:资料包在这一刻**现拉**,之后所有角色共用同一份。
   * 🔴 双方看到的是同一份数字,谁也不能靠编数字赢 —— 这是这个功能唯一的价值所在。
   */
  debateStart: (symbol: string) =>
    request<DebateState>("/debate", { method: "POST", body: JSON.stringify({ symbol }) }),

  /** 跑下一个阶段。一次一个 —— 界面据此逐段显示,不用干等整场 */
  debateAdvance: (id: string) =>
    request<DebateState>(`/debate/${encodeURIComponent(id)}/advance`, { method: "POST", body: "{}" }),

  endpoints: (f: { layer?: string; market?: string; q?: string; enabledOnly?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (f.layer) p.set("layer", f.layer);
    if (f.market) p.set("market", f.market);
    if (f.q) p.set("q", f.q);
    if (f.enabledOnly) p.set("enabled_only", "1");
    const qs = p.toString();
    return request<EndpointSummary[]>(`/endpoints${qs ? `?${qs}` : ""}`);
  },

  /**
   * 取**一屏**数据。页面只说要哪个查询,不点名物理端点 ——
   * 端点 id、参数、分页上限全在垂类的声明里(后端 `Plugin.pageQueries`)。
   */
  page: (query: string, opts?: { symbol?: string; refresh?: boolean; blockArgs?: Record<string, Record<string, unknown>> }) => {
    const path = `/page/${encodeURIComponent(query)}`;
    // 用户拨过参数就走 POST:参数是结构化的,塞进查询串会变成字符串再靠后端猜类型。
    // ⚠️ 能拨哪些键由后端的垂类白名单说了算,这里传什么后端都只认白名单内的。
    if (opts?.blockArgs && Object.keys(opts.blockArgs).length) {
      return request<PageResult>(path, {
        method: "POST",
        body: JSON.stringify({ symbol: opts.symbol, refresh: opts.refresh === true, blockArgs: opts.blockArgs }),
      });
    }
    const qs = new URLSearchParams({ ...(opts?.symbol ? { symbol: opts.symbol } : {}), ...(opts?.refresh ? { refresh: "1" } : {}) });
    return request<PageResult>(path + (qs.toString() ? `?${qs}` : ""));
  },

  /** 默认读上次的快照(不重新取数);要新数据传 `refresh: true` */
  fetch: (req: { endpoint: string; symbol?: string; args?: Record<string, unknown>; session?: string; refresh?: boolean }) =>
    request<FetchResult>("/fetch", { method: "POST", body: JSON.stringify(req) }),

  startResearch: (req: {
    symbol: string;
    market?: string;
    stages?: string[];
    endpoints?: "full" | "core";
    knowledge?: "on" | "off";
  }) => request<StartResult>("/research", { method: "POST", body: JSON.stringify(req) }),

  runs: (limit = 50) => request<RunListItem[]>(`/runs?limit=${limit}`),

  runStatus: (id: string) => request<RunStatus>(`/runs/${encodeURIComponent(id)}/status`),

  report: (id: string) => request<ReportResult>(`/runs/${encodeURIComponent(id)}/report`),

  evidence: (id: string, f: { field?: string; source?: string; q?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (f.field) p.set("field", f.field);
    if (f.source) p.set("source", f.source);
    if (f.q) p.set("q", f.q);
    if (f.limit) p.set("limit", String(f.limit));
    const qs = p.toString();
    return request<EvidenceResult>(`/runs/${encodeURIComponent(id)}/evidence${qs ? `?${qs}` : ""}`);
  },

  manifest: (id: string) => request<Record<string, unknown>>(`/runs/${encodeURIComponent(id)}/manifest`),

  /** 无归档时后端返回 null(不是 404),调用方要显式处理"这家还没研究过" */
  knowledge: (market: string, symbol: string) =>
    request<KnowledgeRecall | null>(`/knowledge/${encodeURIComponent(market)}/${encodeURIComponent(symbol)}`),

  /**
   * 资料导入:上传截图 / 文本 → agent 转写成台账**草稿**。
   * 🔴 只产草稿,**不落库** —— 落库要用户逐条确认后再走 ledgerSave。
   */
  importFiles: (kind: string, files: { name: string; content_base64: string }[], note?: string) =>
    request<IngestResult>("/import", { method: "POST", body: JSON.stringify({ kind, files, ...(note ? { note } : {}) }) }),

  /** 自由对话:只读沙箱 + 不联网 + 过合规 gate(见 orchestrator/src/chat.ts) */
  chat: (message: string, session = "desktop") =>
    request<ChatTurnResult>("/chat", { method: "POST", body: JSON.stringify({ session, message }) }),

  /** 一次拿齐:种类定义(渲染表单用)+ 全部记录 */
  ledger: () =>
    request<{
      kinds: Record<string, LedgerKindDef>;
      records: Record<string, LedgerRecord[]>;
      /** 磁盘上不符合契约的记录(用户手改过 JSON)。后端不删不改,只报出来 */
      issues?: Record<string, LedgerIssue[]>;
          /** 字段 / 枚举的显示名:**垂类声明的**,Core 一个都不认识。没登记的退回原键名 */
      labels: { fields: Record<string, string>; enums: Record<string, string> };
    }>("/ledger"),

  /** 新增(不带 id)或更新(带 id)。⚠️ 更新是**整条替换** —— 提交时要把所有字段都带上 */
  ledgerSave: (kind: string, record: Record<string, unknown>) =>
    request<LedgerRecord>(`/ledger/${encodeURIComponent(kind)}`, { method: "POST", body: JSON.stringify(record) }),

  /** 删除走 POST 而不是 DELETE:后端的跨站防护("POST 必须是 application/json")只覆盖 POST */
  ledgerDelete: (kind: string, id: string) =>
    request<{ removed: boolean }>(`/ledger/${encodeURIComponent(kind)}/delete`, {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
};
