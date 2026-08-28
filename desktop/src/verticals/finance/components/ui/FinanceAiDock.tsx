/**
 * 把 Core 的 AI 入口接到这个垂类上 —— **只提供"行业知道、Core 不知道"的那部分**：
 * 怎么连后端、免责声明怎么说、回答下面挂什么按钮、没配模型时往哪儿引导。
 *
 * 🔴 Core 那边一个行业词都不许有（前端边界棘轮会红），所以文案在这儿而不是那儿。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Settings, Sparkles, Trash2 } from "lucide-react";

import { AiConsole } from "../../../../core/ai/AiConsole";
import { AiDock } from "../../../../core/ai/AiDock";
import { AiComposer, AiMessages } from "../../../../core/ai/AiMessages";
import { useAiChat } from "../../../../core/ai/useAiChat";
import { backend } from "@/lib/backend";
import { hasLlm } from "@/lib/llm";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";

/** 发一轮对话 —— 两个入口共用同一条通道 */
async function sendTurn({ message, session, signal }: { message: string; session: string; signal: AbortSignal }) {
  const r = await backend.chat(message, session, signal);
  // 触发产出红线被删掉的行要**说出来**：不说的话，用户看到的是一段被悄悄剪过的回答
  return r.redacted
    ? `${r.reply}\n\n⚠️ 有 ${r.redacted} 行触发产出红线被移除（不给操作建议）。`
    : r.reply;
}

const setupLink = () => (
  <Link
    to="/settings"
    className="flex items-center justify-center gap-2 rounded-lg bg-primary/15 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/25"
  >
    <Settings className="h-4 w-4" /> 为 Agent 选择模型
  </Link>
);

const replyActions = (reply: string, question: string) => (
  <div className="mt-1.5">
    <SaveNoteButton kind="问 Agent" title={`问 Agent · ${question.slice(0, 24) || "对话"}`} content={reply} />
  </div>
);

const HOME_AGENT_SUGGESTIONS = [
  "今日复盘",
  "今日的连板股是什么？分析涨停的原因",
  "调取这家公司今年的所有研报，并进行深度分析",
  "先收集这个行业最近3个月的200份研报，然后分析这个行业",
  "帮我开始一份公司研究",
  "解释一下这套 Agent",
];

/** 首页里的主对话区：打开产品就能聊，不需要先找侧栏或浮动按钮。 */
export function FinanceHomeAgent({ configured }: { configured: boolean }) {
  const chat = useAiChat("home-agent", sendTurn);
  const [draft, setDraft] = useState("");

  return (
    <section
      id="home-agent"
      data-home-agent
      className="glass flex h-[370px] flex-col overflow-hidden rounded-2xl border border-primary/25 shadow-[0_22px_70px_-54px_hsl(var(--primary)/0.85)] sm:h-[410px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="font-bold">Agent</h2>
            <p className="truncate text-[11px] text-muted-foreground">Codex Harness · 本地运行</p>
          </div>
        </div>
        {chat.msgs.length > 0 && (
          <button
            onClick={chat.clear}
            title="新对话"
            aria-label="新对话"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" /> 清空
          </button>
        )}
      </div>

      {!configured ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div>
            <p className="font-semibold">先接入一个 AI 模型</p>
            <p className="mt-1 text-xs text-muted-foreground">配置一次，以后打开首页就能直接交流。</p>
          </div>
          {setupLink()}
        </div>
      ) : (
        <>
          <AiMessages
            msgs={chat.msgs}
            loading={chat.loading}
            err={chat.err}
            suggestions={HOME_AGENT_SUGGESTIONS}
            suggestionStyle="tasks"
            onPick={setDraft}
            renderReplyActions={replyActions}
            className="px-5 py-4"
          />
          <AiComposer
            placeholder="输入市场、公司、行业或研究方法…（Shift+Enter 换行）"
            disabled={chat.loading}
            onSend={(text) => void chat.submit(text)}
            value={draft}
            onValueChange={setDraft}
            highlighted
          />
        </>
      )}
    </section>
  );
}

/** 底部控制台：一条长期对话，跟着你翻页一起走 */
export function FinanceAiConsole({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AiConsole
      open={open}
      onClose={onClose}
      configured={hasLlm()}
      copy={{
        title: "Vibe Research Agent",
        runtime: "Codex Harness · 本地运行",
        placeholder: "问点什么…（Shift+Enter 换行）",
        notice:
          "这是一条由 Codex Harness 管理的长期对话，翻页也不会断。Agent 读得到本机已经跑出来的研究产物与你自己记的台账，但改不了任何东西。推理由你选择的模型完成——不构成投资建议。",
        suggestions: ["帮我理一下最近在关注什么", "我该补哪些功课", "解释一下这个产品能干什么"],
      }}
      send={sendTurn}
      renderReplyActions={replyActions}
      renderSetup={setupLink}
    />
  );
}

export function FinanceAiDock() {
  return (
    <AiDock
      configured={hasLlm()}
      copy={{
        trigger: "问 Agent",
        panel: "Vibe Research Agent",
        runtime: "Codex Harness · 本地运行",
        placeholder: "就这一页的内容问点什么…",
        notice:
          "本地 Agent 读的是这一页当前显示的数据；Codex Harness 负责上下文与工具流程，推理由你选择的模型完成——本产品不背书、不构成投资建议。",
      }}
      send={sendTurn}
      renderReplyActions={replyActions}
      renderSetup={setupLink}
    />
  );
}
