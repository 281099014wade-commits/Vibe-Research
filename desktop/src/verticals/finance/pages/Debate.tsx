import { useRef, useState } from "react";
import { Swords, Play, Square, Save, CheckCircle2, Circle, AlertTriangle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { debateStream, type DebateStage } from "@/lib/agents";
import type { DebateNumberAudit } from "@/lib/backend";
import { addNote } from "@/lib/notes";
import { ApiError } from "@/lib/api";

interface StageBox {
  stage: DebateStage;
  label: string;
  content: string;
  done: boolean;
  /** 这一段里数字的着落（后端就地自查的结果） */
  audit?: DebateNumberAudit;
}

// 多方用品牌橙、空方用蓝灰、主持用中性——刻意不用红绿，
// 免得和 A 股「红涨绿跌」撞车被读成涨跌信号。
const STAGE_TONE: Record<DebateStage, string> = {
  bull: "border-primary/50 bg-primary/[0.06]",
  bull_rebut: "border-primary/30 bg-primary/[0.03]",
  bear: "border-sky-500/40 bg-sky-500/[0.06]",
  bear_rebut: "border-sky-500/25 bg-sky-500/[0.03]",
  referee: "border-border bg-background/40",
};

const DOSSIER_HINT = "多空双方拿到的是同一份接口实时拉取的数据，谁也不能靠编数字赢。";


/**
 * 这一段里数字的着落。
 *
 * 🔴 **三档分开显示**：「对得上资料包」「写了算式且重算通过」「两样都不是」
 *    是三种不同的可信度，合成一个「有 N 个数字」等于什么都没说。
 * 🔴 `badMath` 是唯一能断言「这里错了」的一类 —— 算式是它自己写的，结果对不上。
 *    实测抓到过同比算反方向（写 +0.2%，实为 −2.04%）。这一条必须显眼。
 * ⚠️ 「没着落」**不等于错**（可能只是没写算式），所以措辞是「没有交代出处」而不是「错」。
 */
function AuditBar({ a }: { a: DebateNumberAudit }) {
  if (!a.total && !a.badMath.length) return null;
  return (
    <div className="mt-3 border-t border-border/40 pt-2 text-[11px]">
      {a.badMath.length > 0 && (
        <div className="mb-1.5 rounded-lg border border-destructive/40 bg-destructive/[0.07] p-2">
          <p className="font-semibold text-destructive">
            🔴 这一段有 {a.badMath.length} 处算式重算对不上（算式是它自己写的）：
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-muted-foreground">
            {a.badMath.slice(0, 4).map((b, i) => (
              <li key={i}>
                「{b.raw}」→ 重算应为 <b className="text-destructive">
                  {b.recomputed.toFixed(2)}{b.percent ? "%" : ""}
                </b>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-muted-foreground/70">
        数字 {a.total} 个：<b className="text-foreground/70">{a.bound}</b> 个对得上资料包 ·{" "}
        <b className="text-foreground/70">{a.derived}</b> 个写了算式且重算通过 ·{" "}
        <b className={a.loose ? "text-warning" : "text-foreground/70"}>{a.loose}</b> 个没有交代出处
        {a.loose > 0 && <span className="text-muted-foreground/60">（不等于错，但这一档没经过核对）</span>}
      </p>
    </div>
  );
}

export function Debate() {
  const [code, setCode] = useState("");
  const [rounds, setRounds] = useState(1);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<{ title: string; ok: boolean }[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [stages, setStages] = useState<StageBox[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const reset = () => {
    setStatus(""); setProgress([]); setMissing([]); setStages([]); setError(""); setSaved(false);
  };

  async function start() {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) { setError("请输入 6 位 A 股代码"); return; }
    reset();
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await debateStream(c, rounds, {
        onStatus: setStatus,
        onDossierProgress: (title, ok, loaded, total) => {
          setStatus(`正在拉取客观事实底稿… ${loaded}/${total}`);
          setProgress((p) => [...p, { title, ok }]);
        },
        onDossierReady: (_sections, miss) => { setMissing(miss); setStatus("底稿就绪，辩论开始"); },
        onStageStart: (stage, label) =>
          setStages((s) => [...s, { stage, label, content: "", done: false }]),
        onDelta: (stage, text, audit) =>
          setStages((s) => s.map((b) => (b.stage === stage && !b.done ? { ...b, content: b.content + text, ...(audit ? { audit } : {}) } : b))),
        onStageDone: (stage, _label, content) =>
          setStages((s) => s.map((b) => (b.stage === stage && !b.done ? { ...b, content, done: true } : b))),
        onError: (message, stage) => setError(stage ? `${stage}：${message}` : message),
      }, ctrl.signal);
      setStatus("辩论完成");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("已中止");
      else setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setRunning(false);
  }

  function save() {
    const body = stages.map((s) => `## ${s.label}\n\n${s.content}`).join("\n\n---\n\n");
    addNote("多空辩论", `多空辩论 · ${code.trim()}`, body);
    setSaved(true);
  }

  const finished = stages.length > 0 && stages.every((s) => s.done);

  useAiPage({
    key: `debate:${code || "none"}`,
    title: code ? `多空辩论 · ${code}` : "多空辩论",
    context: stages.length
      ? `多空辩论 · 标的 ${code}\n` + stages.map((s) => `【${s.label}】${s.done ? s.content : "（还在跑）"}`).join("\n\n")
      : "多空辩论：还没跑过。这一页会用同一份客观资料让多方与空方各自立论、互相质疑，最后由中立主持归纳分歧点与验证清单。",
    suggestions: ["双方最大的分歧在哪", "哪一方的论据更硬", "验证清单该怎么排优先级"],
  });

  return (
    <div>
      <PageHeader
        title="多空辩论"
        subtitle="同一份客观数据，多方与空方各自立论、互相质疑，最后由中立主持归纳分歧点与验证清单——不给买卖结论，判断留给你自己。"
      />

      <GlassCard>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">股票代码</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter" && !running) start(); }}
              placeholder="6 位代码，如 600519"
              disabled={running}
              className="w-44 rounded-lg border border-border/60 bg-background/60 px-3 py-2 font-mono text-sm outline-none focus:border-primary/60"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">辩论深度</label>
            <select
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              disabled={running}
              className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm outline-none focus:border-primary/60"
            >
              <option value={1}>一轮 · 各自陈述</option>
              <option value={2}>两轮 · 加交叉反驳</option>
            </select>
          </div>
          {running ? (
            <button onClick={stop}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-4 py-2 text-sm hover:text-destructive">
              <Square className="h-4 w-4" /> 中止
            </button>
          ) : (
            <button onClick={start}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary">
              <Play className="h-4 w-4" /> 开始辩论
            </button>
          )}
          {finished && !running && (
            <button onClick={save} disabled={saved}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
              <Save className="h-4 w-4" /> {saved ? "已存入沉淀" : "存入沉淀"}
            </button>
          )}
        </div>

        {/* 开销提示：辩论比问答重得多，让用户在点下去之前就知道要花多久、调几次模型 */}
        {!running && !status && (
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/70">
            ⏱ {rounds === 2
              ? "两轮约 3 分钟 · 5 次模型调用 · 约 6 万字进上下文"
              : "一轮约 100 秒 · 3 次模型调用 · 约 3.5 万字进上下文"}
            （每个角色都会带上完整底稿）。其中拉底稿约 35 秒、走公开数据接口，不消耗 token。
            省额度可用「订阅接入」的本机 CLI，或选中档模型——数据已备齐，模型只做组织和表达。
          </p>
        )}

        {status && <p className="mt-3 text-xs text-muted-foreground">{status}</p>}
        {error && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}

        {progress.length > 0 && (
          <div className="mt-4 border-t border-border/40 pt-3">
            <p className="mb-2 text-[11px] text-muted-foreground">{DOSSIER_HINT}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {progress.map((p) => (
                <span key={p.title} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  {p.ok
                    ? <CheckCircle2 className="h-3 w-3 text-primary/70" />
                    : <Circle className="h-3 w-3 text-muted-foreground/40" />}
                  {p.title}
                </span>
              ))}
            </div>
            {missing.length > 0 && (
              <p className="mt-2 text-[11px] text-warning">
                未取到：{missing.join("、")}（双方立论时不得臆测这部分）
              </p>
            )}
          </div>
        )}
      </GlassCard>

      <div className="mt-4 space-y-4">
        {stages.map((s) => (
          <div key={s.stage} className={`rounded-xl border p-4 ${STAGE_TONE[s.stage]}`}>
            <div className="mb-2 flex items-center gap-2">
              <Swords className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">{s.label}</span>
              {!s.done && <span className="animate-pulse text-[11px] text-muted-foreground">生成中…</span>}
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none text-foreground prose-table:text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.content || "…"}</ReactMarkdown>
            </div>
            {s.audit && <AuditBar a={s.audit} />}
          </div>
        ))}
      </div>

      {stages.length === 0 && !running && (
        <GlassCard className="mt-4">
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Swords className="h-8 w-8 text-muted-foreground/40" />
            输入一个代码开始。后端会先拉一份客观事实底稿，再让多方 / 空方基于同一份数据互相质疑。
            <span className="text-xs">产出的是「分歧点 + 验证清单」，不是买卖建议。<br />
            {/* 🔴 实测挖出来的:引用的数(带 ev-id)与资料包逐个核对过是对的,
                但**算出来的数没有任何校验** —— 见过同比算反方向、拿隔年的数当去年基数,
                而它们就摆在正确引用的数字旁边,看着一样可信。这条必须说在前面。 */}
            <b className="text-warning/80">带 [ev-…] 的数字来自资料包、可溯源；而同比、差额这类
            <u>算出来的数没有经过校验</u>——看到百分比请自己按它给的算式核一遍。</b></span>
          </div>
        </GlassCard>
      )}

      <Disclaimer />
    </div>
  );
}
