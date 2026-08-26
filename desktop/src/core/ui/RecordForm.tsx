import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ApiError, type LedgerKindDef, type LedgerRecord } from "../lib/api";
import { DUE_LABEL, dueState, useLedger, useLedgerData, type DueState } from "../lib/useLedger";
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

/**
 * 字段 / 枚举的显示名。**表在垂类那边**(后端 `Plugin.ledger.fieldLabels` / `enumLabels`),
 * 这里只做查表。
 *
 * 🔴 以前这两张表就写死在本文件里,内容是一个具体行业的词汇 ——
 *    界面看着没毛病,但换个垂类就得改 Core;而前端纯净度棘轮的词表里恰好一个都没收录,
 *    **一路绿灯**。⇒ 别拿"棘轮是绿的"当边界证明。
 * ⚠️ 查不到就退回**原键名**照常渲染 —— 不能因为垂类没给它起名就整个字段不显示。
 */
const labelTable = () => useLedger.getState().labels;
export const fieldLabel = (f: string): string => labelTable().fields[f] ?? f;
export const enumLabel = (v: string): string => labelTable().enums[v] ?? v;

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
  onSaved,
  onClose,
}: {
  kind: string;
  def: LedgerKindDef;
  /** 传入 = 编辑这条;不传 = 新增 */
  editing?: LedgerRecord | null;
  /** 新增时预填(如从某个主体点进来带上代码) */
  preset?: Record<string, unknown>;
  /**
   * **只在保存成功时**触发。
   * 🔴 与 `onClose` 分开是必须的:`onClose` 同时被「保存成功」和「点 X 关掉」调用,
   *    调用方拿它当"存好了"用,就会把**关掉表单**记成**已写入** —— 计数加一、行变灰,
   *    而台账里根本没有这条(Codex 复审 mimo-r6,严重度高)。
   */
  onSaved?: () => void;
  onClose: () => void;
}) {
  const save = useLedger((s) => s.save);
  const saving = useLedger((s) => s.saving);
  // 🔴 **从 store 读当前那条,不要用 `editing` 这个快照**。
  //    `editing` 是父组件在打开表单那一刻存进 state 的对象,台账重载后它不会跟着变 ⇒
  //    表单开着时同一条记录被别处改了(如「行动」页点了「标记完成」),表单看不见,
  //    再保存就用旧内容把刚做的改动**整条盖掉**(更新是整条替换)。
  //    ⚠️ 光在依赖里加 `updated_at` 不够 —— 快照的 `updated_at` 也是旧的,依赖根本不会变
  //    (Codex 复审 mimo-r7 → r8 连着两轮才逼出这个根因)。
  const live = useLedger((s) => (editing ? (s.records[kind]?.find((r) => r.id === editing.id) ?? null) : null));
  const target = live ?? editing ?? null;
  /** 打开表单后这条被别处删了:别装作还在,保存会报 not_found */
  const gone = Boolean(editing && !live);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState("");
  /** 用户动过输入框没有。动过就不许被后台刷新静默重置 —— 那是另一种"悄悄丢用户输入" */
  const [dirty, setDirty] = useState(false);
  /** 表单开着期间,这条被别处改过的那个版本(有值 = 要提示用户,而不是直接盖掉他正在填的) */
  const [staleSince, setStaleSince] = useState<string | null>(null);
  const loadedAt = useRef<string | null>(null);

  useEffect(() => {
    // 🔴 用户已经在填了、而这条又被别处改过 ⇒ **不要静默重置**。
    //    重置能挡住"用旧内容盖掉别人的改动",但它自己会**悄悄丢掉用户正在打的字** ——
    //    两个都是静默数据丢失,不能用一个去换另一个。这里改成:提示 + 让他决定要不要载入最新。
    if (dirty && target && loadedAt.current && target.updated_at !== loadedAt.current) {
      setStaleSince(target.updated_at);
      return;
    }
    if (target) {
      // 编辑:只把垂类字段带进表单,信封字段不显示(后端也会剥掉)
      const v: Record<string, unknown> = {};
      for (const f of Object.keys(def.properties)) if (target[f] !== undefined) v[f] = target[f];
      setValues(v);
      loadedAt.current = target.updated_at;
    } else {
      setValues({ ...preset });
      loadedAt.current = null;
    }
    setDirty(false);
    setStaleSince(null);
    setErr("");
    // 🔴 依赖按**内容**比较,不能用对象身份:同一批里另一条草稿保存成功会触发台账重载,
    //    `kinds` / `def` / `preset` 都换成新引用 ⇒ 这个 effect 重跑,把用户**正在填还没保存**
    //    的内容悄悄覆盖回原始值(Codex 复审 mimo-r6)。
    //    ⚠️ 但**只看 id 也不行**:表单开着时,同一条记录被别处改了(比如在「行动」页点了
    //    「标记完成」),id 没变 ⇒ 表单不刷新 ⇒ 再保存会拿旧内容把刚做的改动整条盖掉
    //    (Codex 复审 mimo-r7)。`updated_at` 正好只在**真的被改过**时变,重载换引用不会动它。
    //    ⇒ 依赖 = id + updated_at + 预填内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, target?.updated_at, JSON.stringify(preset)]);

  const fields = Object.keys(def.properties);
  const missing = def.required.filter((f) => values[f] === undefined || values[f] === "");

  async function submit() {
    setErr("");
    try {
      // 🔴 更新是**整条替换**,所以要把当前表单的全部字段一起提交;
      //    只发改动过的字段会把没提到的字段悄悄清空。
      const payload: Record<string, unknown> = { ...values };
      if (target) payload.id = target.id;
      await save(kind, payload);
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code} · ${e.message}` : String(e));
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHead
        title={`${editing ? "编辑" : "新增"}${def.label}`}
        {...(target ? { note: `更新是整条替换:留空的字段会被清掉 · ${target.id}` } : {})}
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
            onChange={(v) => { setDirty(true); setValues((s) => ({ ...s, [f]: v })); }}
          />
        ))}
      </div>
      {staleSince ? (
        <div className="mt-3 rounded-lg border border-warning/50 px-3 py-2 text-[12px]">
          <p className="text-warning">这条记录在别处被改过了({staleSince})。你正在填的内容没有被覆盖。</p>
          <p className="mt-1 text-muted-foreground">
            现在保存会**整条替换**、把那次改动盖掉;要以最新为准就点下面这个按钮(你当前填的会被丢弃)。
          </p>
          <button
            type="button"
            onClick={() => { setDirty(false); setStaleSince(null); loadedAt.current = null; }}
            className="mt-2 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-muted"
          >
            载入最新
          </button>
        </div>
      ) : null}
      {gone ? (
        <p className="mt-3 text-[12px] text-warning">这条记录已经被删掉了 —— 保存会失败,请关闭本表单。</p>
      ) : null}
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
