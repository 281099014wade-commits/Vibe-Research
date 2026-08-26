import { CheckCircle2, XCircle } from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { api } from "../../../core/lib/api";
import { useAsync } from "../../../core/lib/useAsync";
import { Async, Badge, Card, CardHead } from "../../../core/ui/primitives";

/**
 * 设置:**只读**。
 *
 * 🔴🔴 这里**刻意没有"把 API key 粘进来"的输入框**。密钥只从环境变量读、
 *    不进配置文件、更不进浏览器 —— 后端的 `/product` 只回 `env_key`(变量名)
 *    与 `key_present`(布尔)。开源版那一页有输入框,**我们不搬那个**。
 * ⇒ 换 provider 的正确做法写在页面上:改配置文件 + export 环境变量 + 重启服务。
 *
 * ⚠️ 路径原样显示 —— 这一页只在本机回环地址上开着,不外发。
 */

function Row({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-border/40 py-1.5 text-[11.5px]">
      <span className="w-28 shrink-0 text-muted-foreground">{k}</span>
      <span className={mono ? "min-w-0 flex-1 break-all font-mono text-[11px]" : "min-w-0 flex-1 break-all"}>{v}</span>
    </div>
  );
}

export function Settings() {
  const fn = useCallback(() => Promise.all([api.product(), api.endpoints()]), []);
  const { state, reload } = useAsync(fn, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHead title="这一页在回答什么" note="产品现在按什么配置在跑;要改配置去哪儿改" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          这一页<span className="text-foreground">只读</span>。密钥只从环境变量读、不进配置文件、
          也不会送到浏览器 —— 所以这里没有、也不该有把密钥粘进来的地方。
        </p>
      </Card>

      <Async state={state} onRetry={() => reload()}>
        {([p, eps]) => (
          <>
            {p.auth_error ? (
              <Card className="border-warning/50">
                <CardHead title="配置有问题" note="配置仍能显示,但研究运行会失败" />
                <p className="text-[12.5px] text-warning">{p.auth_error}</p>
              </Card>
            ) : null}

            <Card>
              <CardHead
                title="模型接入"
                note="换 provider 要动配置文件与环境变量,不在这一页操作"
                right={
                  <Badge tone={p.provider.key_present ? "success" : "danger"}>
                    {p.provider.key_present ? "凭据就绪" : "缺凭据"}
                  </Badge>
                }
              />
              <Row k="provider" v={p.provider.name} />
              <Row k="模板" v={p.provider.profile ?? "(未用模板)"} />
              <Row k="协议" v={p.provider.wire_api} />
              <Row k="端点" v={p.provider.base_url ?? "(官方默认)"} mono />
              <Row k="鉴权方式" v={p.provider.auth === "api_key" ? "API key(从环境变量读)" : "订阅登录态"} />
              <Row
                k="密钥来自"
                v={
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono text-[11px]">${p.provider.env_key}</span>
                    {/* 🔴 只说"设没设",不说"是什么" */}
                    {p.provider.key_present ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-danger" aria-hidden />
                    )}
                    <span className="text-muted-foreground">{p.provider.key_present ? "已设置" : "未设置"}</span>
                  </span>
                }
              />
              <Row k="默认模型" v={String(p.defaults.model ?? "(未指定)")} />

              <div className="mt-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5">
                <p className="mb-1.5 text-[11.5px] font-medium">要换成别的模型?</p>
                <ol className="list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-muted-foreground">
                  <li>
                    改 <span className="font-mono text-[11px]">.local/config.json</span> 里的{" "}
                    <span className="font-mono text-[11px]">provider.profile</span>(可选模板在{" "}
                    <span className="font-mono text-[11px]">providers/</span> 目录)
                  </li>
                  <li>
                    在启动服务的那个 shell 里 <span className="font-mono text-[11px]">export</span> 该模板要求的环境变量
                  </li>
                  <li>重启服务;回到这一页看「凭据就绪」</li>
                </ol>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  ⚠️ 密钥不要写进配置文件 —— 配置文件会被读进产品,也可能被一起拷走。
                </p>
              </div>
            </Card>

            <Card>
              <CardHead title="数据与路径" note="你写的东西都在数据根里;删掉产品目录不会带走它" />
              <Row k="产品版本" v={p.version} />
              <Row k="数据根" v={p.paths.data_root} mono />
              <Row k="引擎 home" v={p.paths.codex_home} mono />
              <Row k="Python" v={p.paths.python} mono />
              <Row k="配置来源" v={p.sources.join("  ←  ")} mono />
            </Card>

            <Card>
              <CardHead title="数据源" note="注册表里现在有多少端点、启用了多少" />
              <Row k="端点总数" v={String(eps.length)} />
              <Row k="启用" v={`${eps.filter((e) => e.enabled).length} / ${eps.length}`} />
              <Row k="层数" v={String(new Set(eps.map((e) => e.layer ?? "未分层")).size)} />
              <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
                ⚠️ 这里只统计<span className="text-foreground">界面可见</span>的端点。另有一些只给 Agent 用、
                不在界面上露出 —— 它们不进这个计数。逐层明细见「研究归档」页的数据源健康。
              </p>
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
