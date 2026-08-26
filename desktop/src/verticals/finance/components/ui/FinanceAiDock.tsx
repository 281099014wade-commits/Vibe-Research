/**
 * 把 Core 的 AI 入口接到这个垂类上 —— **只提供"行业知道、Core 不知道"的那部分**：
 * 怎么连后端、免责声明怎么说、回答下面挂什么按钮、没配模型时往哪儿引导。
 *
 * 🔴 Core 那边一个行业词都不许有（前端边界棘轮会红），所以文案在这儿而不是那儿。
 */
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";

import { AiConsole } from "../../../../core/ai/AiConsole";
import { AiDock } from "../../../../core/ai/AiDock";
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
    <Settings className="h-4 w-4" /> 先接入你的 AI
  </Link>
);

const replyActions = (reply: string, question: string) => (
  <div className="mt-1.5">
    <SaveNoteButton kind="问AI" title={`问 AI · ${question.slice(0, 24) || "对话"}`} content={reply} />
  </div>
);

/** 底部控制台：一条长期对话，跟着你翻页一起走 */
export function FinanceAiConsole({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AiConsole
      open={open}
      onClose={onClose}
      configured={hasLlm()}
      copy={{
        title: "Agent",
        placeholder: "问点什么…（Shift+Enter 换行）",
        notice:
          "这是一条长期对话，翻页也不会断。它读得到本机已经跑出来的研究产物与你自己记的台账，但改不了任何东西。结论由你配置的模型给出——不构成投资建议。",
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
        trigger: "问 AI",
        panel: "问 AI",
        placeholder: "就这一页的内容问点什么…",
        notice:
          "AI 读的是这一页当前显示的数据。结论由你自己配置的模型给出——本产品不校准、不背书、不构成投资建议。",
      }}
      send={sendTurn}
      renderReplyActions={replyActions}
      renderSetup={setupLink}
    />
  );
}
