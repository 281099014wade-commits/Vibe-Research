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
export interface FetchResult {
  envelope: Envelope;
  exit_code: number | null;
  out_dir: string;
  duration_ms: number;
  stderr_tail: string;
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

/* ---------- 端点 ---------- */

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/health"),

  endpoints: (f: { layer?: string; market?: string; q?: string; enabledOnly?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (f.layer) p.set("layer", f.layer);
    if (f.market) p.set("market", f.market);
    if (f.q) p.set("q", f.q);
    if (f.enabledOnly) p.set("enabled_only", "1");
    const qs = p.toString();
    return request<EndpointSummary[]>(`/endpoints${qs ? `?${qs}` : ""}`);
  },

  fetch: (req: { endpoint: string; symbol?: string; args?: Record<string, unknown>; session?: string }) =>
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
