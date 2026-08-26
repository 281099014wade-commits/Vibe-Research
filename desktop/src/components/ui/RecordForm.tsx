import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { ApiError, type LedgerKindDef, type LedgerRecord } from "../../lib/api";
import { DUE_LABEL, dueState, useLedger, useLedgerData, type DueState } from "../../lib/useLedger";
import { Badge, Card, CardHead, cx, type Tone } from "./primitives";

/**
 * **契约驱动的表单**:字段完全按后端给的 JSON Schema 片段渲染。
 * ⇒ 垂类包里加一个字段,这里自动多一个输入框,前端一行都不用改 ——
 *   这正是 Core / 垂类边界要换来的东西。
 *
 * 校验仍以**后端为准**:这里只做能提升手感的最小提示(必填、日期形状),
 * 不在前端复刻一套规则 —— 两套规则迟早不一致,而且不一致时前端那套会先骗到人。
 */

interface FieldSpec {
  type?: string;
  enum?: unknown[];
  maxLength?: number;
  minimum?: number;
  pattern?: string;
}

const DATE_PATTERN = "^([0-9]{4}-[0-9]{2}-[0-9]{2})?$";

/** 中文字段名。**没登记的字段照样渲染**(退回原键名),不能因为没起中文名就整块不显示 */
const FIELD_LABELS: Record<string, string> = {
  symbol: "代码",
  name: "名称",
  account: "账户",
  shares: "数量",
  cost: "成本",
  opened_at: "建立日期",
  note: "备注",
  title: "标题",
  statement: "内容",
  review_by: "复核日期",
  status: "状态",
  type: "类型",
  thesis_id: "关联论点",
  due: "到期日",
  ref: "关联",
};

const ENUM_LABELS: Record<string, string> = {
  active: "进行中",
  paused: "暂停",
  closed: "已结束",
  decision_point: "裁决点",
  falsifier: "证伪条件",
  pending: "待判",
  met: "已达成",
  broken: "已触发",
  dropped: "已放弃",
  open: "待办",
  done: "已完成",
};

export const fieldLabel = (f: string): string => FIELD_LABELS[f] ?? f;
export const enumLabel = (v: string): string => ENUM_LABELS[v] ?? v;

function Field({
  name,
  spec,
  required,
  value,
  onChange,
}: {
  name: string;
  spec: FieldSpec;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <label htmlFor={`f-${name}`} className="mb-1 block text-[11.5px] text-muted-foreground">
      {fieldLabel(name)}
      {required ? <span className="ml-1 text-danger">*</span> : null}
    </label>
  );
  const cls =
    "w-full rounded-lg border border-border bg-input/60 px-2.5 py-1.5 text-[12.5px] outline-none transition-colors placeholder:text-muted-foreground focus:border-ring";

  if (Array.isArray(spec.enum)) {
    return (
      <div>
        {label}
        <select
          id={`f-${name}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cx(cls, "cursor-pointer")}
        >
          {/* 非必填才给"不指定":必填项留空选项等于把校验推到后端再弹一次错 */}
          {required ? null : <option value="">(不指定)</option>}
          {spec.enum.map((v) => (
            <option key={String(v)} value={String(v)}>
              {enumLabel(String(v))}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (spec.type === "number") {
    return (
      <div>
        {label}
        <input
          id={`f-${name}`}
          type="number"
          inputMode="decimal"
          value={typeof value === "number" ? String(value) : ""}
          min={spec.minimum}
          onChange={(e) => {
            const t = e.target.value.trim();
            // 空 → undefined(不提交这个字段),而不是 0 —— 0 是真值,会被当成"用户填了 0"
            onChange(t === "" ? undefined : Number(t));
          }}
          className={cx(cls, "tnum")}
        />
      </div>
    );
  }

  if (spec.pattern === DATE_PATTERN) {
    return (
      <div>
        {label}
        <input
          id={`f-${name}`}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cx(cls, "tnum")}
        />
      </div>
    );
  }

  const long = (spec.maxLength ?? 0) > 500;
  return (
    <div className={long ? "sm:col-span-2 lg:col-span-3" : ""}>
      {label}
      {long ? (
        <textarea
          id={`f-${name}`}
          rows={3}
          value={typeof value === "string" ? value : ""}
          maxLength={spec.maxLength}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cx(cls, "resize-y leading-relaxed")}
        />
      ) : (
        <input
          id={`f-${name}`}
          type="text"
          value={typeof value === "string" ? value : ""}
          maxLength={spec.maxLength}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cls}
        />
      )}
    </div>
  );
}

export function RecordForm({
  kind,
  def,
  editing,
  preset,
  onClose,
}: {
  kind: string;
  def: LedgerKindDef;
  /** 传入 = 编辑这条;不传 = 新增 */
  editing?: LedgerRecord | null;
  /** 新增时预填(如从某个主体点进来带上代码) */
  preset?: Record<string, unknown>;
  onClose: () => void;
}) {
  const save = useLedger((s) => s.save);
  const saving = useLedger((s) => s.saving);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    if (editing) {
      // 编辑:只把垂类字段带进表单,信封字段不显示(后端也会剥掉)
      const v: Record<string, unknown> = {};
      for (const f of Object.keys(def.properties)) if (editing[f] !== undefined) v[f] = editing[f];
      setValues(v);
    } else {
      setValues({ ...preset });
    }
    setErr("");
  }, [editing, preset, def]);

  const fields = Object.keys(def.properties);
  const missing = def.required.filter((f) => values[f] === undefined || values[f] === "");

  async function submit() {
    setErr("");
    try {
      // 🔴 更新是**整条替换**,所以要把当前表单的全部字段一起提交;
      //    只发改动过的字段会把没提到的字段悄悄清空。
      const payload: Record<string, unknown> = { ...values };
      if (editing) payload.id = editing.id;
      await save(kind, payload);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code} · ${e.message}` : String(e));
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHead
        title={`${editing ? "编辑" : "新增"}${def.label}`}
        {...(editing ? { note: `更新是整条替换:留空的字段会被清掉 · ${editing.id}` } : {})}
        right={
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭表单"
            className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <Field
            key={f}
            name={f}
            spec={def.properties[f] as FieldSpec}
            required={def.required.includes(f)}
            value={values[f]}
            onChange={(v) => setValues((s) => ({ ...s, [f]: v }))}
          />
        ))}
      </div>
      {err ? <p className="mt-3 text-[12px] text-warning">保存失败:{err}</p> : null}
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={saving || missing.length > 0}
          onClick={() => void submit()}
          className="cursor-pointer rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {missing.length > 0 ? (
          <span className="text-[11.5px] text-muted-foreground">还缺:{missing.map(fieldLabel).join(" / ")}</span>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * 四个经营页共用的加载壳。
 * 🔴 "还没加载" / "加载失败" / "加载了但没有记录" 三种要分开 ——
 *    把失败折成空,用户看到的是"我这里本来就没写过东西",而真相是后端连不上。
 */
export function LedgerShell({ children }: { children: (s: ReturnType<typeof useLedgerData>) => ReactNode }) {
  const s = useLedgerData();
  if (s.phase === "idle" || s.phase === "loading") {
    return <p className="py-6 text-[12.5px] text-muted-foreground">读取台账…</p>;
  }
  if (s.phase === "error") {
    return (
      <Card>
        <CardHead title="台账读不出来" />
        <p className="text-[12.5px] leading-relaxed text-warning">{s.error}</p>
        <button
          type="button"
          onClick={() => void s.load()}
          className="mt-3 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-muted"
        >
          重试
        </button>
      </Card>
    );
  }
  return (
    <>
      <LedgerIssues />
      {children(s)}
    </>
  );
}

/**
 * 磁盘上不合契约的记录。
 * 🔴 台账 JSON 用户能直接改,改坏了后端**照样把它读出来**(不删不改是刻意的 ——
 *    丢掉用户手写的数据比报告问题更糟)。所以要在界面上说清哪几条有问题,
 *    否则它们会安静地混在正常记录里参与展示与到期判断。
 */
function LedgerIssues() {
  const issues = useLedger((x) => x.issues);
  const kinds = useLedger((x) => x.kinds);
  const rows = Object.entries(issues).flatMap(([k, list]) => list.map((i) => ({ kind: k, ...i })));
  if (rows.length === 0) return null;
  return (
    <Card className="mb-4 border-warning/50">
      <CardHead title="有记录不符合字段约定" note="多半是直接改过台账 JSON。这些记录仍会显示,但请尽快在页面上改回来" />
      <ul className="space-y-1 text-[11.5px]">
        {rows.map((r) => (
          <li key={`${r.kind}-${r.id}`} className="text-warning">
            <span className="text-muted-foreground">{kinds[r.kind]?.label ?? r.kind} · </span>
            <span className="font-mono">{r.id}</span>
            <span className="text-muted-foreground"> — </span>
            {r.why}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const DUE_TONE: Record<DueState, Tone> = {
  overdue: "danger",
  today: "warning",
  soon: "warning",
  later: "neutral",
  none: "neutral",
};

/** 到期状态徽标。**没写到期日单独一档**,不混进"未到期" */
export function DueBadge({ due }: { due: string }) {
  const st = dueState(due);
  return (
    <Badge tone={DUE_TONE[st]}>
      {DUE_LABEL[st]}
      {due ? ` · ${due}` : ""}
    </Badge>
  );
}

/** 新增按钮(统一外观) */
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-muted"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}

/** 删除按钮:**必须二次确认** —— 这是用户手写的数据,误删没有撤销 */
export function DeleteButton({ kind, id }: { kind: string; id: string }) {
  const remove = useLedger((s) => s.remove);
  const saving = useLedger((s) => s.saving);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      disabled={saving}
      onClick={() => (armed ? void remove(kind, id) : setArmed(true))}
      aria-label={armed ? "再点一次确认删除" : "删除"}
      className={cx(
        "cursor-pointer rounded-md p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        armed ? "bg-danger/15 text-danger" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {armed ? <span className="px-1 text-[11px]">确认删除</span> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
