import { Check, FileUp, X } from "lucide-react";
import { useRef, useState } from "react";

import { ApiError, api, type IngestDraft, type IngestResult } from "../lib/api";
import { useLedger, useLedgerData } from "../lib/useLedger";
import { verticalUi } from "../lib/ui";
import { RecordForm, fieldLabel } from "./RecordForm";
import { Badge, Card, CardHead, cx } from "./primitives";

/**
 * 资料导入。
 * 🔴 **转写只产草稿,逐条确认才落库** —— 转写是概率性的,认错一个数字、串一行,
 *    直接写进去之后没人分得清哪条是机器填的。所以这里是个**审核队列**,不是"一键导入"。
 *    落库仍走正常的台账写入,同一套校验、同一套锁。
 *
 * 浏览器拿不到本地文件路径,所以只能把内容读出来上传(base64)。
 */

const ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.tsv,.json";

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    // readAsDataURL 给的是 `data:<mime>;base64,xxx`,要把前缀切掉
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`读不了文件 ${file.name}`));
    r.readAsDataURL(file);
  });
}

function DraftRow({ draft, kind, onSaved }: { draft: IngestDraft; kind: string; onSaved: () => void }) {
  const save = useLedger((s) => s.save);
  const saving = useLedger((s) => s.saving);
  const [state, setState] = useState<"open" | "saved" | "dropped">("open");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const kinds = useLedgerData().kinds;

  if (state === "dropped") return null;

  const entries = Object.entries(draft.fields);
  // 缺必填 = 这条按现状存不进去。**不能让用户点一个注定失败的按钮**:
  // 点了会在落库那关报 bad_record,而错误发生在"确认"之后,看着像产品坏了。
  const missing = draft.missing_required ?? [];
  const blocked = missing.length > 0;
  return (
    <div className={cx("border-b border-border/40 py-2.5", state === "saved" && "opacity-50")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
            {entries.length === 0 ? (
              <span className="text-warning">这条什么都没读出来</span>
            ) : (
              entries.map(([f, v]) => (
                <span key={f}>
                  <span className="text-muted-foreground">{fieldLabel(f)} </span>
                  <span className="tnum">{v === null || v === "" ? "—" : String(v)}</span>
                </span>
              ))
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
            <span className="truncate">来自 {draft.source_file}</span>
            {/* agent 自己说没看清的地方 —— 这几条要重点核,不能一路点确认 */}
            {draft.uncertain.map((u) => (
              <span key={u} className="text-warning">
                ⚠ {u}
              </span>
            ))}
            {blocked ? (
              <span className="text-danger">缺必填:{missing.map(fieldLabel).join(" / ")} —— 点「补填」填上就能写入</span>
            ) : null}
          </div>
          {err ? <p className="mt-1 text-[11px] text-warning">写入失败:{err}</p> : null}
          {/* 🔴 补填入口:光把按钮禁掉是死路 —— 截图糊了一个必填字段,这条草稿就永远存不进去,
              用户只能丢弃重来。表单本来就是契约驱动的,直接复用它、拿草稿预填,人补上就能写入。
              这才是 human-in-the-loop:机器做体力活,人补例外。 */}
          {editing && kinds[kind] ? (
            <div className="mt-2">
              <RecordForm
                kind={kind}
                def={kinds[kind]!}
                preset={draft.fields}
                // 🔴 两件事必须分开:`onSaved` 只在真存进去时触发;`onClose` 关掉表单
                //    (点 X、或保存失败后想收起)不能被当成"已写入"。
                onSaved={() => {
                  setState("saved");
                  onSaved();
                }}
                onClose={() => setEditing(false)}
              />
            </div>
          ) : null}
        </div>
        {state === "saved" ? (
          <Badge tone="success">已写入</Badge>
        ) : (
          <>
            <button
              type="button"
              disabled={saving || entries.length === 0 || blocked}
              title={blocked ? `缺必填字段:${missing.map(fieldLabel).join(" / ")}` : undefined}
              onClick={() => {
                setErr("");
                save(kind, draft.fields)
                  .then(() => {
                    setState("saved");
                    onSaved();
                  })
                  .catch((e: unknown) => setErr(e instanceof ApiError ? `${e.code} · ${e.message}` : String(e)));
              }}
              className="shrink-0 cursor-pointer rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认写入
            </button>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="shrink-0 cursor-pointer rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-muted"
            >
              {editing ? "收起" : blocked ? "补填" : "编辑"}
            </button>
            <button
              type="button"
              onClick={() => setState("dropped")}
              aria-label="丢弃这条"
              className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ImportPanel({ onClose }: { onClose: () => void }) {
  const led = useLedgerData();
  const kinds = Object.keys(led.kinds);
  const [kind, setKind] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<IngestResult | null>(null);
  const [saved, setSaved] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeKind = kind || kinds[0] || "";

  async function run(files: FileList | null) {
    if (!files || files.length === 0 || !activeKind) return;
    setBusy(true);
    setErr("");
    setResult(null);
    setSaved(0);
    try {
      const payload = await Promise.all(
        [...files].map(async (f) => ({ name: f.name, content_base64: await toBase64(f) })),
      );
      const trimmed = note.trim();
      setResult(await api.importFiles(activeKind, payload, trimmed || undefined));
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code} · ${e.message}` : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = ""; // 允许再选同一个文件
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHead
        title="导入资料"
        note="截图 / 文本 → 转写成台账草稿。⚠️ 转写会认错,所以逐条确认才写入,不是一键导入"
        right={
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭导入"
            className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="imp-kind" className="mb-1 block text-[11.5px] text-muted-foreground">
            转写成哪种记录
          </label>
          <select
            id="imp-kind"
            value={activeKind}
            onChange={(e) => setKind(e.target.value)}
            className="cursor-pointer rounded-lg border border-border bg-input/60 px-2.5 py-1.5 text-[12.5px] outline-none"
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {led.kinds[k]!.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="imp-note" className="mb-1 block text-[11.5px] text-muted-foreground">
            补充说明(可选)
          </label>
          <input
            id="imp-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={verticalUi().copy.importNoteExample}
            className="w-full rounded-lg border border-border bg-input/60 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <button
          type="button"
          disabled={busy || !activeKind}
          onClick={() => fileRef.current?.click()}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FileUp className="h-3.5 w-3.5" aria-hidden />
          {busy ? "转写中…" : "选文件"}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(e) => void run(e.target.files)}
          className="hidden"
        />
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        收图片与文本(<span className="font-mono">{ACCEPT.replace(/\./g, "").replace(/,/g, " ")}</span>)。 ⚠️{" "}
        <span className="text-foreground">PDF / Excel 刻意不收</span> —— 转写它们没有可靠工具,
        给出来的会是一份看着像模像样、实则乱猜的草稿,比不支持更糟。
      </p>

      {err ? <p className="mt-3 text-[12px] text-warning">导入失败:{err}</p> : null}

      {result ? (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
            <span>
              转写出 <span className="tnum text-foreground">{result.drafts.length}</span> 条草稿
            </span>
            <span className="text-muted-foreground">
              已写入 <span className="tnum text-foreground">{saved}</span> 条
            </span>
            <span className="tnum text-muted-foreground">{result.duration_ms} ms</span>
          </div>
          {result.warnings.map((w) => (
            <p key={w} className="mb-1 text-[11.5px] text-warning">
              ⚠ {w}
            </p>
          ))}
          {result.drafts.length === 0 ? (
            <p className="py-3 text-[12.5px] text-muted-foreground">
              一条都没读出来。换更清楚的截图,或在补充说明里讲清这份资料是什么。
            </p>
          ) : (
            result.drafts.map((d, i) => (
              <DraftRow
                key={`${d.source_file}-${i}`}
                draft={d}
                kind={result.kind}
                onSaved={() => setSaved((n) => n + 1)}
              />
            ))
          )}
          {saved > 0 ? (
            <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-success">
              <Check className="h-3.5 w-3.5" aria-hidden />
              已写入的记录可以到对应页面查看与编辑
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
