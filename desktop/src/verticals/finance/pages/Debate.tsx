import { Play, Swords } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, api, type DebateState } from "../../../core/lib/api";
import { useLedger } from "../../../core/lib/useLedger";
import { Badge, Card, CardHead, cx } from "../../../core/ui/primitives";

/**
 * 多空辩论:同一份现拉的资料包,多空各打一遍,再由裁判收口成**判据**。
 *
 * 🔴 这个功能唯一的价值是「**双方拿到的是同一份数字,谁也不能靠编数字赢**」。
 *    资料包在开场那一刻现拉(不读快照),之后每个角色看到的完全一样。
 * 🔴 裁判**不判谁赢**,只输出"双方都认的事实 / 争议点 / 每个争议点的可裁决判据" ——
 *    要一个"谁赢"的结论,等于让它替你下判断,那在产出红线的另一边。
 * ⚠️ 逐个阶段跑、跑完一个显示一个 —— 整场一两分钟,干等一个 spinner 很难受。
 */

/** 多方用主色、空方用蓝灰、裁判无色。**刻意不用红绿** —— 免得跟涨跌撞车被读成方向信号。 */
const TONE: Record<string, string> = {
  bull: "border-primary/50 bg-primary/[0.06]",
  bull_rebut: "border-primary/30 bg-primary/[0.03]",
  bear: "border-sky-500/40 bg-sky-500/[0.06]",
  bear_rebut: "border-sky-500/25 bg-sky-500/[0.03]",
  referee: "border-border bg-muted/30",
};

const A_SHARE = /^(6\d{5}|0\d{5}|3\d{5})$/;

export function Debate() {
  const [input, setInput] = useState("300308");
  const [state, setState] = useState<DebateState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // 重开一场时,别让上一场的循环继续往里写(它还在 await 里挂着)
  const runId = useRef(0);
  const save = useLedger((s) => s.save);
  const valid = A_SHARE.test(input.trim());

  const run = useCallback(async () => {
    const mine = ++runId.current;
    setRunning(true);
    setError("");
    setSaved(false);
    setState(null);
    try {
      let st = await api.debateStart(input.trim());
      if (runId.current !== mine) return;
      setState(st);
      // 逐个阶段推进。**每一步都把最新状态画出来**,不要跑完再一次性出现。
      while (!st.done) {
        st = await api.debateAdvance(st.id);
        if (runId.current !== mine) return;
        setState(st);
      }
    } catch (e) {
      if (runId.current !== mine) return;
      setError(e instanceof ApiError ? `${e.code} · ${e.message}` : String(e));
    } finally {
      if (runId.current === mine) setRunning(false);
    }
  }, [input]);

  /** 存进台账 —— 辩论只在内存里,关掉就没了 */
  const saveNote = useCallback(async () => {
    if (!state) return;
    const body = state.stages
      .filter((s) => s.status === "done")
      .map((s) => `## ${s.label}\n\n${s.text}`)
      .join("\n\n");
    await save("note", {
      category: "debate",
      symbol: state.symbol,
      title: `多空辩论 · ${state.symbol}`,
      body: `> 资料包 ${state.evidence_count} 条证据${state.gaps.length ? `;缺口:${state.gaps.join("; ")}` : ""}\n\n${body}`,
    });
    setSaved(true);
  }, [state, save]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHead title="这一页在回答什么" note="同一份现拉的资料,多空各打一遍,裁判收口成判据" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          多空双方拿到的是<span className="text-foreground">同一份接口实时拉来的数据</span>,谁也不能靠编数字赢。
          裁判<span className="text-foreground">不判谁赢</span> —— 它只列出双方都认的事实、争议点,
          以及每个争议点要看到什么数据才能裁决。
        </p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid && !running) void run();
            }}
            aria-label="股票代码"
            placeholder="六位 A 股代码"
            className="tnum w-32 rounded-lg border border-border bg-input/60 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <button
            type="button"
            disabled={!valid || running}
            onClick={() => void run()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? (
              <Swords className="h-3.5 w-3.5 animate-pulse" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            {running ? "辩论中…" : "开一场"}
          </button>
          {input.trim() && !valid ? <span className="text-[11.5px] text-warning">要六位 A 股代码</span> : null}
          {state ? (
            <span className="ml-auto text-[11.5px] text-muted-foreground">
              资料包 <span className="tnum text-foreground">{state.evidence_count}</span> 条证据
            </span>
          ) : null}
        </div>
        {error ? <p className="mt-2 text-[12px] text-warning">{error}</p> : null}
        {state?.gaps.length ? (
          // 缺口必须显示:少一块,辩论的地基就窄一截,而产出照样是一篇像样的文章
          <p className="mt-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
            ⚠️ 资料包有缺口(双方已被告知别当它们不存在):{state.gaps.join(" / ")}
          </p>
        ) : null}
      </Card>

      {state?.stages.map((s) => (
        <div key={s.id} className={cx("rounded-xl border px-4 py-3", TONE[s.id] ?? "border-border")}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12.5px] font-medium">{s.label}</span>
            <Badge tone={s.status === "done" ? "success" : s.status === "failed" ? "danger" : "neutral"}>
              {s.status === "done" ? "已完成" : s.status === "failed" ? "失败" : "等待中"}
            </Badge>
          </div>
          {s.status === "failed" ? (
            // 单个阶段失败不废掉整场,但要说清是哪一环没打上
            <p className="text-[12px] text-warning">这一环没打上:{s.error ?? "未知原因"}</p>
          ) : s.text ? (
            <div className="markdown text-[12.5px] leading-relaxed">
              <Markdown remarkPlugins={[remarkGfm]}>{s.text}</Markdown>
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">{running ? "…" : "还没跑"}</p>
          )}
        </div>
      ))}

      {/* 🔴 全挂了要说全挂了。只看 `done` 的话,"五段全空"会显示成"辩论正常完成"
          —— 用户以为做过一遍功课,其实什么都没打上(审计 pages-r2)。 */}
      {state?.outcome === "failed" ? (
        <Card className="border-warning/50">
          <CardHead title="这一场没打成" note="所有阶段都失败了 —— 不是「没有分歧」,是根本没跑起来" />
          <p className="text-[12.5px] leading-relaxed text-warning">
            逐条原因见上面每一段。常见是模型接入出了问题(去「设置」看凭据是否就绪)。
          </p>
        </Card>
      ) : null}

      {state?.done && state.outcome !== "failed" ? (
        <Card>
          <CardHead
            title="留下来"
            note={
              state.outcome === "completed_with_errors"
                ? "⚠️ 有环节没打上(见上面标红的那几段)—— 存下来的是不完整的一场"
                : "辩论只在内存里,关掉就没了 —— 要留就存进研究记录"
            }
          />
          <button
            type="button"
            disabled={saved}
            onClick={() => void saveNote()}
            className="cursor-pointer rounded-lg border border-primary/45 bg-primary/10 px-3 py-1.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saved ? "已存入研究记录" : "存为研究记录"}
          </button>
        </Card>
      ) : null}
    </div>
  );
}
