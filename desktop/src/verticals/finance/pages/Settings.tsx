import { KeyRound, ShieldCheck, Check, X, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { backend, type ProductInfo } from "@/lib/backend";

/**
 * 「接入 AI」—— 本版**只读**。
 *
 * 🔴🔴 这里刻意**没有任何输入框**。开源版这一页让用户把 API key 粘进来、存进浏览器
 *    localStorage;我们的密钥**只从环境变量读、不进配置文件、更不进浏览器** ——
 *    后端 `/product` 只回环境变量的**名字**与一个布尔("设没设"),不回值。
 *    ⇒ 换模型的正确做法写在页面上:改配置文件 + export 环境变量 + 重启服务。
 *
 * ⚠️ 这是与上游唯一的功能性差异,不是漏搬。
 */

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-border/40 py-2 text-sm last:border-0">
      <span className="w-24 shrink-0 text-muted-foreground">{k}</span>
      <span className={mono ? "min-w-0 flex-1 break-all font-mono text-xs" : "min-w-0 flex-1 break-all"}>{v}</span>
    </div>
  );
}

export function Settings() {
  const [info, setInfo] = useState<ProductInfo | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    backend.product().then(setInfo).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <PageHeader
        title="接入 AI"
        subtitle="模型配置在后端 —— 这一页只读。密钥不进浏览器,所以这里没有、也不该有粘贴框。"
      />

      {err && (
        <GlassCard className="border-destructive/40">
          <p className="text-sm text-destructive">读不到后端配置:{err}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            先把编排器 API 起起来:<span className="font-mono">node orchestrator/src/api.ts --port 8765</span>
          </p>
        </GlassCard>
      )}

      {info && (
        <div className="space-y-4">
          <GlassCard>
            <div className="mb-3 flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">当前模型</h3>
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
