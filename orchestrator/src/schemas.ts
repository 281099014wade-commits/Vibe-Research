/**
 * JSON Schema(契约的机器形态):取数信封 / evidence / calculation / 阶段产物 / manifest。
 * 字段口径以 AGENTS.md §4 为唯一来源;这里只是它的可执行镜像。全部 additionalProperties:false。
 */
import AjvModule, { type ValidateFunction } from "ajv";

import { GAP_REASON_CODES, STAGES, type Stage } from "./config.ts";

// Node ESM 导入 CJS 包:默认导入是 module.exports(ajv 同时挂了 .default = Ajv 类);类型取 ajv 的 default 导出
type AjvCtor = (typeof import("ajv"))["default"];
const Ajv: AjvCtor = (AjvModule as unknown as { default?: AjvCtor }).default ?? (AjvModule as unknown as AjvCtor);
const ajv = new Ajv({ allErrors: true, strict: false });

const ISO_TS = "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2})?([.+\\-Z].*)?$";
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";

export const evidenceItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "symbol", "market", "field", "value", "unit", "currency", "period", "as_of", "source", "endpoint",
    "fetched_at", "adjustment", "raw_ref"],
  properties: {
    id: { type: "string", pattern: "^ev-[0-9a-f]{6,}$" },
    symbol: { type: "string", minLength: 1 },
    market: { type: "string", enum: ["SH", "SZ", "BJ", "CN", "US", "HK"] },
    field: { type: "string", minLength: 1 },
    value: { type: ["number", "string", "boolean", "null"] },
    unit: { type: "string" },
    currency: { type: "string" },
    period: { type: "string", minLength: 1 },
    as_of: { type: "string", pattern: DATE },
    source: { type: "string", minLength: 1 },
    endpoint: { type: "string", minLength: 1 },
    fetched_at: { type: "string", pattern: ISO_TS },
    adjustment: { type: "string", enum: ["none", "qfq", "hfq", "not_applicable"] },
    raw_ref: { type: ["string", "null"] },
    note: { type: "string" },
    record_key: { type: "string" },
  },
} as const;

export const fetchEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["script", "symbol", "market", "status", "fetched_at", "used_sources", "evidence", "extra", "errors"],
  properties: {
    script: { type: "string", minLength: 1 },
    symbol: { type: "string" },
    market: { type: "string", enum: ["SH", "SZ", "BJ", "CN", "US", "HK", ""] },
    status: { type: "string", enum: ["ok", "partial", "failed"] },
    fetched_at: { type: "string", pattern: ISO_TS },
    primary_source: { type: ["string", "null"] },
    used_sources: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: evidenceItemSchema },
    extra: { type: "object" },
    errors: { type: "array" },
    missing: { type: "array" },
  },
} as const;

export const calcRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["calculation_id", "function", "calc_version", "inputs", "inputs_resolved", "inputs_refs", "output"],
  properties: {
    calculation_id: { type: ["string", "null"], pattern: "^calc-[0-9a-f]{16}$" },
    function: { type: "string", minLength: 1 },
    calc_version: { type: "string" },
    inputs: { type: ["object", "null"] },
    inputs_resolved: { type: "object" },
    inputs_refs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref_type", "ref_id"],
        properties: { ref_type: { type: "string", enum: ["evidence", "calculation"] }, ref_id: { type: "string" } },
        oneOf: [
          { properties: { ref_type: { const: "evidence" }, ref_id: { pattern: "^ev-[0-9a-f]{6,}$" } } },
          { properties: { ref_type: { const: "calculation" }, ref_id: { pattern: "^calc-[0-9a-f]{16}$" } } },
        ],
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["status", "value", "unit", "reason", "details"],
      properties: {
        status: { type: "string", enum: ["ok", "not_meaningful", "error"] },
        value: { type: ["number", "null"] },
        unit: { type: "string" },
        reason: { type: "string" },
        details: { type: "object" },
        // calc 0.3.2:展示层字符串(cli 层附加;旧记录可无)
        display: { type: ["string", "null"] },
      },
    },
  },
} as const;

export const gapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "reason_code", "detail"],
  properties: {
    operation: { type: "string", minLength: 1 },
    reason_code: { type: "string", enum: [...GAP_REASON_CODES] },
    detail: { type: "string", minLength: 1 },
    attempted_sources: { type: "array", items: { type: "string" } },
  },
} as const;

export const STANDARD_COLUMNS = ["pe_deducted_x4", "forward_pe", "pe_ttm_percentile", "peg", "forward_cagr", "ttm_yoy", "qoq"];

/** Phase 1 M2:各阶段 extra_findings 允许的 topic(与 stages.ts EXT_GUIDE / SOP §6 一致;schema 与 validator 双重约束) */
export const EXTRA_TOPICS: Record<Stage, string[]> = {
  profile: ["行业归属", "股本与市值", "上市状态", "板块归属", "其他交叉核对"],
  financials: ["三表交叉", "资产负债要点", "现金流要点", "其他交叉核对"],
  estimates: ["逐篇预测", "评级分布", "其他线索"],
  valuation: ["估值历史", "分红", "其他交叉核对"],
  risk: ["资金行为", "解禁", "股东结构", "公告线索", "互动易", "新闻线索", "市场声音", "其他线索"],
  report: ["汇总"],
};

/** 阶段产物 stages/<stage>.json 的通用骨架;各阶段再加专属必填项 */
export function stageOutputSchema(stage: Stage): Record<string, unknown> {
  const props: Record<string, unknown> = {
    stage: { type: "string", enum: [stage] },
    status: { type: "string", enum: ["complete", "incomplete", "skipped", "failed"] },
    summary: { type: "string", minLength: 1 },
    evidence_ids: { type: "array", items: { type: "string", pattern: "^ev-[0-9a-f]{6,}$" } },
    calculation_ids: { type: "array", items: { type: "string", pattern: "^calc-[0-9a-f]{16}$" } },
    gaps: { type: "array", items: gapSchema },
    notes: { type: "string" },
    // 知识层档案裁决(任何阶段都可写;claim 原话 / 反证或"无法裁决:原因" / 对口 ev- 或 calc- id)
    knowledge_conflicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["claim", "refuted_by"], properties: { claim: { type: "string", minLength: 1 }, refuted_by: { type: "string", minLength: 1 }, evidence_ids: { type: "array", items: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" } } } } },
    // Phase 1 M2:扩展数据发现(可选;每条必须引用 evidence / calc id;只报事实与数值,不得含交易信号)
    extra_findings: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["topic", "summary", "evidence_ids"], properties: { topic: { type: "string", enum: EXTRA_TOPICS[stage] }, summary: { type: "string", minLength: 1, maxLength: 600 }, evidence_ids: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" } } } } },
  };
  const required = ["stage", "status", "summary", "evidence_ids", "calculation_ids", "gaps"];
  if (stage === "profile") {
    props.quote_decision = { type: "string", enum: ["normal", "pre_open", "stale", "unknown_unverified"] };
    props.quote_decision_reason = { type: "string", minLength: 1 };
    props.moat_tag = { type: "string", enum: ["tech_moat", "capacity_moat", "both", "待补"] };
    required.push("quote_decision", "quote_decision_reason", "moat_tag");
  }
  if (stage === "valuation") {
    props.standard_columns = {
      type: "object", additionalProperties: false, required: STANDARD_COLUMNS,
      properties: Object.fromEntries(STANDARD_COLUMNS.map((k) => [k, { type: "string", pattern: "^(calc-[0-9a-f]{16}|未获取[::].+)$" }])),
    };
    required.push("standard_columns");
  }
  if (stage === "risk") {
    props.counter_evidence = {
      type: "array", minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["claim", "counter"], properties: { claim: { type: "string", minLength: 1 }, counter: { type: "string", minLength: 1 }, evidence_ids: { type: "array", items: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" } } } },
    };
    props.decision_points = {
      type: "array", minItems: 3,
      items: { type: "object", additionalProperties: false, required: ["what_would_change", "next_data_point"], properties: { what_would_change: { type: "string", minLength: 1 }, next_data_point: { type: "string", minLength: 1 } } },
    };
    props.source_conflicts = { type: "array", items: { type: "object", additionalProperties: false, required: ["field", "kind", "values"],
      properties: { field: { type: "string", minLength: 1 }, period: { type: "string" }, kind: { type: "string", enum: ["source", "cross_check"] }, note: { type: "string" },
        values: { type: "array", minItems: 2, items: { type: "object", additionalProperties: false, required: ["source", "value", "ref_id"],
          properties: { source: { type: "string", minLength: 1 }, value: {}, unit: { type: "string" }, ref_id: { type: "string", pattern: "^(ev-[0-9a-f]{6,}|calc-[0-9a-f]{16})$" }, note: { type: "string" } } } } } } };
    required.push("counter_evidence", "decision_points", "source_conflicts");
  }
  return { type: "object", additionalProperties: false, required, properties: props };
}

/** 阶段最终回复(outputSchema)——极简,只用于机器判读 */
export const turnReplySchema = {
  type: "object",
  properties: {
    stage_file_written: { type: "boolean" },
    status: { type: "string", enum: ["complete", "incomplete", "skipped", "failed"] },
    notes: { type: "string" },
  },
  required: ["stage_file_written", "status", "notes"],
  additionalProperties: false,
} as const;

export const manifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "symbol", "market", "started_at", "finished_at", "status", "stages", "codex_version", "model", "model_note", "calc_version",
    "repo_version", "config_hash", "raw_hashes", "execution_scope", "partial_run", "thread_id", "fetch_ledger", "evidence_count", "calculation_count",
    "evidence_conflicts", "gate", "exit_code", "provider", "engine", "constitution", "hooks"],
  properties: {
    provider: { type: "object", additionalProperties: false, required: ["name", "wire_api", "base_url", "env_key", "auth"],
      properties: { name: { type: "string" }, wire_api: { type: "string", enum: ["responses", "chat"] }, base_url: { type: ["string", "null"] }, env_key: { type: "string" }, auth: { type: "string", enum: ["chatgpt_login", "api_key"] },
        profile: { type: ["string", "null"] }, matrix_status: { type: ["string", "null"] } } },
    constitution: { type: "object", additionalProperties: false, required: ["path", "sha256"], properties: { path: { type: "string" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } },
    hooks: { type: "object", additionalProperties: false, required: ["enabled", "installed", "hooks_json", "invocations", "stop_blocks", "stop_terminations", "pre_tool_use_blocks", "errors", "log_trust"],
      properties: { enabled: { type: "boolean" }, installed: { type: "boolean" }, hooks_json: { type: ["string", "null"] }, invocations: { type: "integer" }, stop_blocks: { type: "integer" }, stop_terminations: { type: "integer" },
        pre_tool_use_blocks: { type: "integer" }, errors: { type: "integer" }, log_trust: { type: "string", enum: ["diagnostic_untrusted"] } } },
    // skills 隔离摘要(可选:noAgent 运行不写;见 skills_isolation.ts)
    skills_isolation: { type: "object", additionalProperties: false, required: ["installed", "config_toml", "disabled_user_skills", "bundled_disabled", "max_context_tokens"],
      properties: { installed: { type: "boolean" }, config_toml: { type: "string" }, disabled_user_skills: { type: "integer", minimum: 0 }, bundled_disabled: { type: "boolean" }, max_context_tokens: { type: "integer", minimum: 1, maximum: 10000 }, truncated: { type: "boolean" } } },
    engine: { type: "object", additionalProperties: false, required: ["codex_path", "codex_home", "binary"],
      properties: { codex_path: { type: ["string", "null"] }, codex_home: { type: "string" }, binary: { type: ["string", "null"] } } },
    run_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }, symbol: { type: "string", minLength: 1 }, market: { type: "string", enum: ["SH", "SZ", "BJ", ""] },
    started_at: { type: "string", pattern: ISO_TS }, finished_at: { type: ["string", "null"], pattern: ISO_TS },
    status: { type: "string", enum: ["complete", "incomplete", "failed", "stale", "running"] },
    stages: { type: "array", items: { type: "object", additionalProperties: false, required: ["stage", "status", "attempts", "errors", "validator_ok"],
      properties: { stage: { type: "string", enum: [...STAGES] }, status: { type: "string", enum: ["complete", "incomplete", "skipped", "failed"] }, attempts: { type: "integer" }, errors: { type: "array", items: { type: "string" } }, validator_ok: { type: "boolean" } } } },
    codex_version: { type: "string" }, model: { type: ["string", "null"] }, model_note: { type: "string" }, calc_version: { type: "string" },
    repo_version: { type: "string" }, config_hash: { type: "string" }, raw_hashes: { type: "object" },
    execution_scope: { type: "array", items: { type: "string" } }, partial_run: { type: "boolean" }, thread_id: { type: ["string", "null"] },
    fetch_ledger: { type: "object" }, evidence_count: { type: "integer" }, calculation_count: { type: "integer" },
    evidence_conflicts: { type: "array" }, gate: { type: "object" }, exit_code: { type: "integer", enum: [0, 2, 3] },
    quote_decision: { type: ["string", "null"] },
    endpoint_scope: { type: "string", enum: ["core", "full"] }, registry_version: { type: ["string", "null"] },
    knowledge_recalled: { type: ["object", "null"], additionalProperties: false, required: ["path", "as_of", "status", "truncated"], properties: { path: { type: "string" }, as_of: { type: "string" }, status: { type: "string" }, truncated: { type: "boolean" } } },
    test_scenario: { type: "boolean" },
    knowledge_archived: { type: ["object", "null"], additionalProperties: false, required: ["latest", "run_file", "gate_removed"], properties: { latest: { type: "string" }, run_file: { type: "string" }, gate_removed: { type: "integer" } } },
    viewer: { type: ["object", "null"], additionalProperties: false, required: ["html", "appendix"], properties: { html: { type: "string" }, appendix: { type: "string" } } },
    final_errors: { type: "array", items: { type: "string" } },
  },
} as const;

const compiled = new Map<string, ValidateFunction>();
function compile(key: string, schema: object): ValidateFunction {
  const cached = compiled.get(key);
  if (cached) return cached;
  const v: ValidateFunction = ajv.compile(schema);
  compiled.set(key, v);
  return v;
}

export function validateWith(key: string, schema: object, data: unknown): string[] {
  const v = compile(key, schema);
  if (v(data)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${e.params ? " " + JSON.stringify(e.params) : ""}`);
}

export const validateFetchEnvelope = (d: unknown) => validateWith("fetch", fetchEnvelopeSchema, d);
export const validateEvidenceItem = (d: unknown) => validateWith("evidence", evidenceItemSchema, d);
export const validateCalcRecord = (d: unknown) => validateWith("calc", calcRecordSchema, d);
export const validateStageOutput = (stage: Stage, d: unknown) => validateWith(`stage:${stage}`, stageOutputSchema(stage), d);
export const validateManifest = (d: unknown) => validateWith("manifest", manifestSchema, d);

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}
