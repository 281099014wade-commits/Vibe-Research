import { Check, KeyRound, ShieldCheck, Sparkles, Terminal, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { backend, type ProductInfo } from "@/lib/backend";
import { API_MODELS, PROVIDER_BASE, SUBSCRIPTION_MODELS, isCliProvider, providerOfModel, type ProviderId } from "@/lib/ai-models";
import { clearLlm, loadUserLlm, saveLlm } from "@/lib/llm";

/**
 * 「接入 AI」—— 用户在这里选模型、填自己的 key。
 *
 * 🔴 口径与开源版 Vibe-Research 对齐（那一份经过真实用户验证）：
 *    配置**只存本地 localStorage**，随请求发给**本机**后端，后端拼进临时 env 交给引擎。
 *    **配置文件 / 日志 / 账本一个字节都碰不到。**
 *
 * ⚠️ 上一版这页是**只读**的，理由是"密钥只从环境变量读"。那在终端里启动没问题，
 *    但**装机版（访达双击）根本没有 shell 环境** —— 等于除了在终端里启动的人，
 *    没有人能把产品用起来。现在两条路并存：用户配了走用户的，没配回落到后端默认。
 *
 * 🔴 **订阅档免 key**：用产品自带引擎的登录态，一个字都不用填 —— 装机版的首选。
 */

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-border/40 py-2 text-sm last:border-0">
      <span className="w-24 shrink-0 text-muted-foreground">{k}</span>
      <span className={mono ? "min-w-0 flex-1 break-all font-mono text-xs" : "min-w-0 flex-1 break-all"}>{v}</span>
    </div>
  );
}

const INPUT = "w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm";

/** 保存 / 清除 / 提示 —— 两档共用，分开写迟早只改一边 */
function ActionRow(
  { onSave, configured, onForget, msg, msgErr }:
  { onSave: () => void; configured: boolean; onForget: () => void; msg: string; msgErr: string },
) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button onClick={onSave}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary ring-1 ring-primary/30 hover:bg-primary/25">
        保存（存本机）
      </button>
      {configured && (
        <button onClick={onForget}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-destructive">
          <Trash2 className="h-4 w-4" /> 清除
        </button>
      )}
      {msg && <span className="text-xs text-primary">{msg}</span>}
      {msgErr && <span className="text-xs text-destructive">{msgErr}</span>}
    </div>
  );
}

export function Settings() {
  const [info, setInfo] = useState<ProductInfo | null>(null);
  const [err, setErr] = useState("");
  const existing = loadUserLlm();
  const existingIsCli = existing ? isCliProvider(existing.provider) : false;

  const [mode, setMode] = useState<"subscription" | "api">(existing && !existingIsCli ? "api" : "subscription");
  const [cliId, setCliId] = useState(existing && existingIsCli ? existing.model : (SUBSCRIPTION_MODELS[0]?.id ?? ""));
  const first = API_MODELS[0]!;   // 清单是编译期常量,非空
  const [apiId, setApiId] = useState(existing && !existingIsCli ? existing.model : first.id);
  const [baseURL, setBaseURL] = useState(existing && !existingIsCli ? existing.baseURL : (PROVIDER_BASE[first.provider] ?? ""));
  const [modelName, setModelName] = useState(existing && !existingIsCli ? existing.model : first.id);
  const [apiKey, setApiKey] = useState(existing && !existingIsCli ? existing.apiKey : "");
  const [configured, setConfigured] = useState(Boolean(existing));
  const [msg, setMsg] = useState("");
  const [msgErr, setMsgErr] = useState("");

  useEffect(() => {
    backend.product().then(setInfo).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  /**
   * 这一家的**兼容矩阵状态**（由后端下发，前端不写死一份）。
   * 🔴 "目录里有这份模板" ≠ "跑过矩阵"：6 份模板里只有 2 份真跑过，
   *    按文件存在来标会在界面上造出 4 条**假的「已实测」**。
   */
  const RAN = new Set(["baseline", "pass", "partial"]);
  const matrixOf = (pv: ProviderId): string => info?.provider_templates?.[pv] ?? "";
  const tag = (pv: ProviderId): string => {
    const st = matrixOf(pv);
    if (!st) return "";
    if (st === "partial") return "（已实测·部分项不支持）";
    return RAN.has(st) ? "（已实测）" : "（有模板·未实测）";
  };
  const pickApi = (id: string) => {
    const m = API_MODELS.find((x) => x.id === id);
    if (!m) return;
    setApiId(id); setModelName(id); setBaseURL(PROVIDER_BASE[m.provider] ?? "");
    setMsg(""); setMsgErr("");
  };

  const say = (ok: string) => { setMsg(ok); setMsgErr(""); };
  const oops = (bad: string) => { setMsg(""); setMsgErr(bad); };

  const saveApi = () => {
    if (!modelName.trim()) return oops("Model 不能空");
    if (!apiKey.trim()) return oops("API Key 不能空");
    const pv = providerOfModel(apiId);
    if (!baseURL.trim() && pv === "openai-compatible") return oops("自填端点必须给出 Base URL");
    if (/[{<][A-Za-z_]/.test(baseURL)) return oops("Base URL 里还有占位符没替换（把 {…} 换成你自己的值）");
    try {
      saveLlm({ provider: pv, baseURL: baseURL.trim(), apiKey: apiKey.trim(), model: modelName.trim() });
      setConfigured(true); say("已保存到本机浏览器 —— 全站的 Agent 对话现在用这一份");
    } catch (e) {
      // 🔴 存不下要说出来:静默失败会让用户以为配好了,下次打开又是空的
      oops(e instanceof Error ? e.message : String(e));
    }
  };

  const saveCli = () => {
    const m = SUBSCRIPTION_MODELS.find((x) => x.id === cliId);
    if (!m || m.comingSoon) return oops("请选一个可用的订阅（标「开发中」的还接不上）");
    try {
      saveLlm({ provider: m.provider, baseURL: "", apiKey: "", model: m.id });
      setConfigured(true); say(`已选「${m.name}」—— 免 key，用本机登录态`);
    } catch (e) { oops(e instanceof Error ? e.message : String(e)); }
  };

  const forget = () => {
    // 🔴 清不掉要说出来：吞掉异常的话界面写"已清除"、旧 key 还在，下一次提问照样发出去
    try {
      clearLlm();
      setApiKey(""); setConfigured(false); say("已清除 —— 回落到下面那份后端默认配置");
    } catch (e) { oops(e instanceof Error ? e.message : String(e)); }
  };

  useAiPage({
    key: "settings",
    title: "接入 AI",
    // 🔴 **只放模型的名字，绝不放 key**。这段 context 会随提问发出去 ——
    //    把密钥拼进来等于用户在这一页填的东西被原样送进对话历史。
    context:
      (configured
        ? `用户自己配的模型：${mode === "subscription" ? cliId : modelName}（provider ${mode === "subscription" ? providerOfModel(cliId) : providerOfModel(apiId)}）。`
        : "用户还没配自己的模型，走后端默认配置。") +
      (info
        ? `后端默认：provider ${info.provider.name}｜模板 ${info.provider.profile ?? "—"}｜` +
          `协议 ${info.provider.wire_api}｜鉴权 ${info.provider.auth}｜密钥变量 ${info.provider.env_key} ` +
          `${info.provider.key_present ? "已设置" : "未设置"}｜默认模型 ${String(info.defaults.model ?? "—")}｜产品版本 ${info.version}`
        : "还没读到后端配置。"),
    suggestions: ["我现在用的是哪个模型", "订阅档和 API 档有什么区别", "我的 key 会被存到哪里"],
  });

  return (
    <div>
      <PageHeader
        title="接入 AI"
        subtitle="选一个模型，填上你自己的 key —— 只存在这台机器的浏览器里，不上传、不进仓库、不写进任何配置文件。"
      />

      {err && (
        <GlassCard className="border-destructive/40">
          <p className="text-sm text-destructive">读不到后端配置:{err}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            先把编排器 API 起起来:<span className="font-mono">node orchestrator/src/api.ts --port 8765</span>
          </p>
        </GlassCard>
      )}

      {/* ── 两种接入方式 ── */}
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span>
          API key <b className="text-foreground">只存在这台机器的浏览器里</b>，提问时随请求发给<b className="text-foreground">本机</b>后端去调模型，
          用完即弃 —— 不写进配置文件、不进日志、不入台账，也不会离开这台机器。
        </span>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <GlassCard onClick={() => setMode("subscription")}
          className={`cursor-pointer ${mode === "subscription" ? "ring-1 ring-primary/40" : "opacity-80"}`}>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">订阅接入</h3>
            {mode === "subscription" && <Check className="ml-auto h-4 w-4 text-primary" />}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            用产品自带引擎的登录态，走你的订阅额度，<b className="text-foreground">免 API key</b>。装机版首选。
          </p>
        </GlassCard>

        <GlassCard onClick={() => setMode("api")}
          className={`cursor-pointer ${mode === "api" ? "ring-1 ring-primary/40" : "opacity-80"}`}>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">API 接入</h3>
            {mode === "api" && <Check className="ml-auto h-4 w-4 text-primary" />}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            填自己的 key：DeepSeek / MiMo / 智谱 / Kimi / 通义 / OpenAI / 任意兼容端点。
          </p>
        </GlassCard>
      </div>

      <GlassCard className="mb-4">
        {mode === "subscription" ? (
          <div className="space-y-3 text-sm">
            <p className="text-xs leading-relaxed text-muted-foreground">
              用产品自带的那台引擎（已在本机登录）作答，<b className="text-foreground">不用填 key</b>。
              标「开发中」的还接不上，选了会明确报错，<b className="text-foreground">不会悄悄换成别家</b>去答。
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {SUBSCRIPTION_MODELS.map((m) => {
                const on = cliId === m.id;
                return (
                  <button key={m.id} disabled={m.comingSoon} onClick={() => { setCliId(m.id); setMsg(""); setMsgErr(""); }}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      m.comingSoon ? "cursor-not-allowed border-border/50 opacity-40"
                        : on ? "border-primary/50 bg-primary/10" : "border-border hover:bg-muted/40"}`}>
                    <Terminal className={`h-4 w-4 shrink-0 ${on ? "text-primary" : "text-muted-foreground"}`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium">
                        {m.name}
                        {m.comingSoon && <span className="rounded bg-muted/60 px-1 py-0.5 text-[9px] text-muted-foreground">开发中</span>}
                        {on && <Check className="h-3.5 w-3.5 text-primary" />}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{m.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <ActionRow onSave={saveCli} configured={configured} onForget={forget} msg={msg} msgErr={msgErr} />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">选择模型</label>
              <select value={apiId} onChange={(e) => pickApi(e.target.value)} className={INPUT}>
                {API_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{tag(m.provider)} —— {m.description}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {(() => {
                  const st = matrixOf(providerOfModel(apiId));
                  if (RAN.has(st)) return "产品跑过这一家的兼容矩阵：协议 / 结构化产出 / 已知不兼容项都记在 providers/ 模板里。";
                  if (st) return "⚠️ 产品写好了这一家的模板，但**没有真跑过**兼容矩阵 —— 能不能用得你自己试。";
                  return "⚠️ 产品没有这一家的模板，按通用 OpenAI 兼容端点走 —— 端点必须支持 Responses API（引擎已不再支持 Chat Completions）。";
                })()}
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Base URL</label>
              <input value={baseURL} onChange={(e) => { setBaseURL(e.target.value); setMsg(""); setMsgErr(""); }}
                placeholder="https://api.deepseek.com" className={`${INPUT} font-mono text-xs`} />
              {/* 百炼系模板留了占位让用户替换 —— 没替换后端会拒，这里先说清楚 */}
              {/[{<][A-Za-z_]/.test(baseURL) && (
                <p className="mt-1 text-[11px] text-destructive">把 {"{…}"} 换成你自己的值（百炼控制台里的 WorkspaceId）</p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Model</label>
              <input value={modelName} onChange={(e) => { setModelName(e.target.value); setMsg(""); setMsgErr(""); }}
                placeholder="模型名称" className={`${INPUT} font-mono text-xs`} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">API Key</label>
              <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setMsg(""); setMsgErr(""); }}
                placeholder="sk-…" className={`${INPUT} font-mono text-xs`} />
            </div>
            <ActionRow onSave={saveApi} configured={configured} onForget={forget} msg={msg} msgErr={msgErr} />
          </div>
        )}
      </GlassCard>

      {info && (
        <div className="space-y-4">
          <GlassCard>
            <div className="mb-3 flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">后端默认配置</h3>
              <span
                className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                  info.provider.key_present ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                }`}
              >
                {info.provider.key_present ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                {info.provider.key_present ? "凭据就绪" : "缺凭据"}
              </span>
            </div>
            <Row k="provider" v={info.provider.name} />
            <Row k="模板" v={info.provider.profile ?? "(未用模板)"} />
            <Row k="协议" v={info.provider.wire_api} />
            <Row k="端点" v={info.provider.base_url ?? "(官方默认)"} mono />
            <Row k="鉴权" v={info.provider.auth === "api_key" ? "API key(从环境变量读)" : "订阅登录态"} />
            <Row
              k="密钥来自"
              v={
                <span className="inline-flex items-center gap-1.5">
                  {/* 🔴 只说"设没设",不说"是什么" */}
                  <span className="font-mono text-xs">${info.provider.env_key}</span>
                  <span className="text-muted-foreground">{info.provider.key_present ? "· 已设置" : "· 未设置"}</span>
                </span>
              }
            />
            <Row k="默认模型" v={String(info.defaults.model ?? "(未指定)")} />
            {info.auth_error && <p className="mt-2 text-xs text-destructive">{info.auth_error}</p>}
          </GlassCard>

          <GlassCard>
            <div className="mb-2 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">要换成别的模型?</h3>
            </div>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              <li>
                改 <span className="font-mono text-xs">.local/config.json</span> 里的{" "}
                <span className="font-mono text-xs">provider.profile</span>(可选模板在{" "}
                <span className="font-mono text-xs">providers/</span> 目录)
              </li>
              <li>在启动服务的那个 shell 里 <span className="font-mono text-xs">export</span> 该模板要求的环境变量</li>
              <li>重启服务;回到这一页看「凭据就绪」</li>
            </ol>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground/80">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              密钥不要写进配置文件 —— 配置文件会被读进产品,也可能被一起拷走。
            </p>
          </GlassCard>

          <GlassCard>
            <h3 className="mb-2 font-semibold">数据与路径</h3>
            <Row k="产品版本" v={info.version} />
            <Row k="数据根" v={info.paths.data_root} mono />
            <Row k="引擎 home" v={info.paths.codex_home} mono />
            <Row k="Python" v={info.paths.python} mono />
            <Row k="配置来源" v={info.sources.join("  ←  ")} mono />
          </GlassCard>
        </div>
      )}

      <Disclaimer />
    </div>
  );
}
