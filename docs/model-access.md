# 模型接入指南

适用:vibe-research-agent Phase 1 M4。本文讲清三件事:用哪条通道接模型、怎么验证一个 provider 能不能用、怎么加一家新的 provider。密钥永远只放环境变量。

## 1. 两条通道

| 通道 | 适用 | 怎么配 | 说明 |
|---|---|---|---|
| ChatGPT 订阅登录(默认) | OpenAI 模型,Plus / Pro / Team 订阅 | `CODEX_HOME="$(pwd)/.local/codex-home" codex login` | 登录态存在**产品自己的 CODEX_HOME**,与 `~/.codex` 隔离;不需要任何 API key;模型用订阅默认或 `--model` |
| API key | OpenAI 或第三方(DeepSeek / 通义千问 / 智谱 GLM / Kimi …) | `export <ENV_KEY>=...` + `--provider <id>`(OpenAI 另加 `--auth api_key`) | 每个 provider 一份模板 `providers/<id>.json`,模板只声明变量名(`env_key`),值从进程环境读 |

auth 的解析规则:用户没在 `.local/config.json` / `VRA_PROVIDER_AUTH` / `--auth` 显式写过 auth 时,切换到第三方 profile 会自动用模板唯一支持的 `api_key`;显式写过的永不被覆盖(不支持就报错,不静默降级)。产品配置 `vibe-research.config.json` 里的 auth 只是产品默认,不算显式。

## 2. 三步接入第三方模型

```bash
# 1) 密钥只放环境变量(变量名见模板 env_key;此处以 DeepSeek 为例)
export DEEPSEEK_API_KEY=...
# 2) 先跑 10 项兼容矩阵(结果在 .local/provider-matrix/deepseek/<时间>/summary.md,不含密钥)
node orchestrator/src/finance/provider_matrix.ts --provider deepseek --model deepseek-v4-flash
# 3) 矩阵可接受后用于研究(或写进 .local/config.json)
node orchestrator/src/run.ts --symbol 300308 --market SZ --provider deepseek --model deepseek-v4-flash --python "$(pwd)/.venv/bin/python" < /dev/null
```

`.local/config.json` 写法:

```json
{ "provider": { "profile": "deepseek" }, "defaults": { "model": "deepseek-v4-flash" } }
```

优先级:`.local/config.json` ← 环境变量 `VRA_PROVIDER` / `VRA_PROVIDER_AUTH` ← CLI `--provider` / `--auth`。环境变量层整体生效(`VRA_PROVIDER` 与 `VRA_CODEX_HOME` / `VRA_PYTHON` 等可同时用)。

### 🔴 只能是 Responses 协议 —— `wire_api="chat"` 已被引擎彻底移除

引擎(`codex-rs/model-provider-info`)对 `wire_api = "chat"` **直接硬报错**。所以模板里没有、也不可能再有 chat 协议的 provider:
一家厂商要接进来,**必须自己提供 OpenAI 兼容的 `/responses` 端点**,或者你在中间架一个 Responses→Chat Completions 的网关
(那时填 `responses_support: "gateway"`,`base_url` 指向网关)。契约层在选用时就会拒掉 chat 并把这两条出路写在报错里,
不会让你配到跑起来才炸。

内置模板与对应环境变量(**均为 responses 协议**,供应商信息核实于 2026-08-26):

| id | 厂商 / 通道 | env_key | 默认模型 | base_url |
|---|---|---|---|---|
| `openai` | OpenAI 官方(订阅登录或 API key) | `OPENAI_API_KEY` | 引擎默认 | null(官方端点) |
| `deepseek` | DeepSeek 官方 Responses | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` | `https://api.deepseek.com` |
| `qwen` | 通义千问 · 阿里云百炼 | `DASHSCOPE_API_KEY` | `qwen3.8-max` | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| `glm` | 智谱 GLM · 阿里云百炼 | `DASHSCOPE_API_KEY` | `glm-5.2` | 同上 |
| `kimi` | Kimi · 阿里云百炼 | `DASHSCOPE_API_KEY` | `kimi-k2.7-code` | 同上 |
| `mimo` | 小米 MiMo 官方原生 Responses | `MIMO_API_KEY` | `mimo-v2.5` | `https://token-plan-cn.xiaomimimo.com/v1` |

⚠️ **三个百炼模板不能直接用**:`base_url` 里的 `{WorkspaceId}` 是留给你填的。把模板复制到 `.local/providers/<id>.json`、
换成自己的工作空间 ID 再选用 —— 没换会在**选用时当场被拒**(而不是把密钥发到一个不存在的主机上)。
走百炼而不是各家官方端点,是因为截至核实日只有 DeepSeek 官方提供原生 `/responses`;智谱官方开放平台没有,
月之暗面官方是否提供未核实 —— 未核实的事不写成事实。

模板里的 `default_model` / `context_limit_tokens` 是易变的供应商信息,`verified_at` 记最近一次人工核实日期(null = 未核实);模型名下线时请显式 `--model`。

### 一个模板可以声明"它不支持服务端 schema"

`structured_output` 字段(缺省 `json_schema`):

- `json_schema` —— 支持 `text.format.type=json_schema`,产品照常硬传(OpenAI / DeepSeek 走这条)。
- `prompt` —— **不支持**。产品会把 schema 写进提示词,不再硬传。
  硬传的后果不是降级而是**整轮被拒**:阶段直接 failed。

🔴 为什么这条降级不算放松要求:**`outputSchema` 从来就不是校验边界**。产物合不合规是产品自己校验的
(阶段过 validator、导入草稿过 `parseOutput`)。降级损失的是**命中率**——模型少了一层硬约束、
可能更容易写歪、重试次数上升;但写歪了照样过不了产品这关。所以这条降级**不能**顺手把校验也一起省掉。

## 3. 兼容矩阵怎么读

`provider_matrix.ts` 用 Codex SDK 对目标 provider 真跑 10 个小回合,机器判定 pass / partial / fail / n/a / error;临时目录 cwd、workspace-write、无网络、不加载产品宪法(只测协议兼容,不测研究纪律)。

| # | 项目 | pass 的判据 | 非 pass 的含义 |
|---|---|---|---|
| ① | 单次文本 | 回复含约定 token | 基本对话不通 |
| ② | 单工具调用 | 至少 1 条命令且输出含约定串 | 不会调用工具 |
| ③ | 连续三轮工具调用 | step-A / B / C 出自不同命令项且按序 | partial = 合并成一条或乱序 |
| ④ | 并行工具调用 | 两条命令都执行且事件流观察到同时在途 | partial = 都执行但串行 |
| ⑤ | 工具失败自修复 | 先失败 → 修复命令 → 最终回复说明 | partial = 修了没说 / 没修 |
| ⑥ | 长流 | 1–200 行编号一个不缺 + turn.completed | partial = 流被截断 |
| ⑦ | reasoning item | 事件里出现 reasoning 项 | partial = 模型不回传推理摘要(不算 fail) |
| ⑧ | schema 严格输出 | outputSchema 下最终回复为合法 JSON 且字段齐 | fail = 不是 JSON |
| ⑨ | 多轮上下文延续 | 第二回合复述第一回合约定词 | 会话不连续 |
| ⑩ | 无 previous_response_id 协议下的延续 | 非 responses 协议时 ⑨ 通过即 pass | responses 协议记 n/a(由 Codex 内部处理)——目前所有模板都是 responses,故此项恒为 n/a |

判定口径(含 ④ 如何用 `item.started/completed` 交错证明并发、⑦ 为什么要 `model_reasoning_summary=detailed`)见 `orchestrator/src/finance/provider_matrix.ts` 头注释;`judge()` 有逐项正反单测。结果文件落盘前做两层脱敏(provider 密钥精确替换 + 通用 token / 签名 URL)。矩阵不全绿的 provider 只应用于试验;编排器会把 provider 与矩阵状态写进运行的 `manifest.json`。

OpenAI 基线(2026-08-22,订阅登录,引擎默认模型):9 pass · 1 n/a。

**小米 MiMo 实测(2026-08-26,`mimo-v2.5`,API key)**:pass 7 · partial 1 · error 1 · n/a 1。

| 项 | 结果 | 说明 |
|---|---|---|
| ①②③④⑤⑥⑨ | pass | 文本 / 单工具 / 三轮工具 / **并行工具(峰值 2)** / 失败自修复 / 200 行长流 / 多轮延续 |
| ⑦ reasoning | partial | `mimo-v2.5` 不回传;⚠️ 换 `mimo-v2.5-pro` 直连实测**有** —— 这项跟**模型**走,不跟 provider 走 |
| ⑧ schema | **error** | `responses_feature_not_supported:text.format type 'json_schema' is not supported, only 'text' and 'json_object' are allowed` |
| ⑩ | n/a | responses 协议不适用 |

⑧ 是**协议层的事实**,矩阵如实记着不粉饰;产品侧用 `structured_output: "prompt"` 绕开了它。
同日用 `mimo-v2.5` 真跑了一个完整研究阶段(profile):**validator 通过、79 条证据**,
agent 那一轮 4.7 分钟 —— ⚠️ 慢,turn 超时压到 5 分钟会连续两次超时,用默认 20 分钟。

## 4. 加一家新的 provider

1. 复制 `providers/deepseek.json` 为 `providers/<id>.json`(或放用户私有覆盖 `.local/providers/<id>.json`,同结构,优先级更高);`id` 小写字母开头,只含 `a-z0-9_-`,且与文件名一致。
2. 填字段:`name`、`wire_api`(**只能 `responses`**;`chat` 会被当场拒绝,见上文)、`base_url`(**第三方必须显式 https**——Codex 对空 base_url 会回退到 `api.openai.com`,密钥会发到错误主机)、`env_key`(大写变量名,不得是 HOME / PATH 等受保护名)、`auth_modes`(第三方只能 `["api_key"]`)、`requires_openai_auth: false`、`default_model`、`responses_support`(厂商自己提供 `/responses` 填 `native`,经自建网关转换填 `gateway`;不能填 `none`)。可选:`query_params` / `http_headers` / `env_http_headers`(值是环境变量名)/ `request_max_retries` / `stream_max_retries` / `stream_idle_timeout_ms` / `context_limit_tokens` / `retryable_errors` / `known_incompatibilities` / `verified_at`。
3. `http_headers` / `query_params` 里写了像密钥的值会被直接拒绝——密钥只能经 `env_key` / `env_http_headers` 引用。
4. 跑矩阵,按结果回填 `matrix.status` / `matrix.results` / `matrix.note`。

模板怎么映射到 Codex:非 openai 的 profile 注入 `model_provider=<id>` + `model_providers.<id>={name, base_url, env_key, wire_api, requires_openai_auth=false, …}`(经 SDK 配置覆盖,不写 `~/.codex`);进程环境只透传 `env_key` 与 `env_http_headers` 引用的变量(openai 的 api_key 模式另设 `CODEX_API_KEY`);agent 的 shell 命令不继承任何密钥类变量。

## 5. 常见问题

- **`--provider deepseek` 报"环境变量 DEEPSEEK_API_KEY 未设置"**:密钥只从环境变量读,先 `export`。
- **报"provider xxx 不支持 auth=chatgpt_login"**:你在 `.local/config.json` / `VRA_PROVIDER_AUTH` / `--auth` 显式写了 chatgpt_login;第三方只能 api_key,改掉或删掉显式设置即可。
- **⑦ partial**:该模型 / 协议不回传推理摘要,不影响研究运行。
- **④ partial**:provider 把同一回合的多条工具调用串行执行,功能可用但慢。
- **⑩ n/a**:responses 协议下 previous_response_id 由 Codex 内部处理,此项不适用(所有模板都是 responses)。
- **报"引擎不再支持 wire_api=\"chat\""**:你在用一份旧模板。改成厂商的 Responses 端点,或架一个 Responses→Chat 网关并填 `responses_support: "gateway"`。
- **报"base_url 里还有没替换的占位符 {WorkspaceId}"**:百炼三件套要填自己的工作空间 ID,把模板复制到 `.local/providers/<id>.json` 改完再用。
- **想用 OpenAI 兼容网关**:新建独立 id 的模板(不要改 `openai.json` 的 base_url,它必须为 null)。
- **Responses↔Chat 自建适配器**:不在本仓库范围(独立子项目);`responses_support=gateway` 留给这类网关。
