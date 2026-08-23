<p align="center"><b>简体中文</b> | <a href="README_en.md">English</a></p>
<h1 align="center">vibe-research-agent</h1>
<p align="center"><b>基于 OpenAI Codex 的开源 A 股金融研究 Agent("Codex for Finance")</b><br>零 fork · 三级约束 · 104 端点数据管道 · 确定性计算库 · 合规红线 · 多模型接入</p>
<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-pending-lightgrey">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-orchestrator-3178c6">
  <img alt="Python" src="https://img.shields.io/badge/Python-data%20%2B%20calc-3776ab">
  <img alt="Codex" src="https://img.shields.io/badge/Codex%20CLI-0.149.0-black">
</p>
<p align="center">
  <a href="#这是什么">这是什么</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#用法速查">用法速查</a> ·
  <a href="#模型接入">模型接入</a> ·
  <a href="#配置与环境变量">配置</a> ·
  <a href="#架构">架构</a> ·
  <a href="#数据源">数据源</a> ·
  <a href="#安全与隐私">安全</a> ·
  <a href="#开发与测试">开发</a> ·
  <a href="#状态与路线图">路线图</a> ·
  <a href="CHANGELOG.md">CHANGELOG</a>
</p>

---

## 这是什么

把 OpenAI Codex 当成引擎,外挂一套**金融研究的纪律、数据管道与计算库**,让 agent 对一只 A 股(也支持美股 / 港股数据)跑完"公司画像 → 财务 → 一致预期 → 估值 → 风险 → 报告"六个阶段,产出**可审计、可复算、带证据链**的研究报告。

大模型做金融研究有三个老毛病:**凭记忆编数字、心算公式、顺手给建仓建议**。本项目的解法不是多写几句提示词,而是三级约束:

| 层 | 部件 | 作用 |
|---|---|---|
| 提示层 | `AGENTS.md` 金融研究宪法 + `.agents/skills/` 投研 SOP | 告诉 agent 该怎么做(五问 Gate、取数与解释分阶段、事实与推断分离) |
| 执行层 | Codex 原生 hooks(Stop / PreToolUse)+ 沙箱 | 做不对当场过不去:缺产物不许收工、禁止自跑取数脚本 / 联网 / 改写证据 |
| 编排层 | 薄 orchestrator + validator + 合规 gate | 取数由编排器执行并记内存账本,每个数字必须对得上证据与 calc 的计算 DAG;命中建仓 / 目标价等措辞即要求重写 |

**提示遵循 ≠ 流程保证**——纪律落在执行层和编排层,不靠模型自觉。

Codex 仓库一行不改(零 fork):运行用官方安装的 `codex` CLI 与同版 TypeScript SDK,上游升级只需对照版本锚定文件重新验证。

## 它能做什么

- **一键研究**:`run.ts --symbol 300308` → 六阶段状态机,每阶段取数 → agent 解释 → validator 校验(账本 / schema / 引用 / 复算 / 语义槽位)→ 不过自动补跑 → 合规 gate → 合并产物。产物:`report.md`、`evidence.json`(每条证据带 raw 原文引用)、`calculations.json`(每个数字的计算 DAG)、`conflicts.json`(跨源冲突)、`viewer.html`(自包含证据查看器)、`manifest.json`。
- **数据管道**:`datasources/registry.json` 注册 106 个零鉴权 / 低鉴权端点(24 层,CN / US / HK:行情、财务三表、一致预期、资金流、融资融券、筹码、公告、研报、宏观、交易所、SEC / FINRA / CBOE、RSS 新闻雷达),通用取数器一条命令取任一端点,原始响应全部落盘;**取数层不做任何派生计算**。
- **确定性计算库** `calc/`:估值 / 序列 / 技术指标 / 筹码分布 18 个纯函数,fixture 测试,CLI 输出带确定性 `calculation_id` 与输入 DAG,validator 可复算。
- **知识层**:每次运行自动归档到用户私有区 `.local/knowledge/`,下次运行默认召回(带"不可信数据"边界与新鲜度判定),由 agent 逐条裁决新旧冲突。
- **接口**:MCP server(8 个工具,可接入 Codex CLI / 任何 MCP 客户端)、本机 HTTP API + 薄浏览页、多标的批量、两次运行变化提醒、数据源健康巡检。
- **多模型接入**:provider 模板(OpenAI / DeepSeek / 通义千问 / 智谱 GLM / Kimi)+ 10 项兼容矩阵 harness,密钥只从环境变量读。

## 快速开始

### 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | macOS / Linux(实测 macOS,darwin-arm64) | Windows 未测(hooks 的 Windows 命令哈希留后) |
| Node.js | ≥ 22.18(推荐 24 LTS) | 仓库直接 `node xxx.ts` 运行 TypeScript,不需要构建 |
| Python | ≥ 3.10(实测 3.12) | 取数脚本与 calc;建议虚拟环境 |
| Codex CLI | 0.149.0(`npm install -g @openai/codex@0.149.0`) | 已测版本区间见 `codex-version.json`;其它版本请先跑测试 |
| 模型访问 | ChatGPT 订阅(Plus / Pro / Team)**或** OpenAI API key **或** 国产模型 API key | 订阅登录不需要任何 key |

### 安装

```bash
git clone <本仓库地址> vibe-research-agent && cd vibe-research-agent   # 地址为发布前占位,正式发布时替换
# 1) 编排器依赖(Codex TS SDK / MCP SDK / ajv / zod)
(cd orchestrator && npm install)
# 2) Python 虚拟环境 + 取数依赖(requests / pandas / lxml / akshare / baostock)
python3 -m venv .venv && .venv/bin/pip install -r .agents/skills/data-access/scripts/requirements.txt
# 3) Codex CLI(全局)
npm install -g @openai/codex@0.149.0 && codex --version
# 4) 初始化产品自己的私有层 .local/(目录 + 配置骨架;不碰 ~/.codex;可重复执行)
scripts/init --python "$(pwd)/.venv/bin/python"
# 5) 登录到产品自己的 CODEX_HOME(与你的 ~/.codex 完全隔离;ChatGPT 订阅走浏览器授权)
CODEX_HOME="$(pwd)/.local/codex-home" codex login
# 6) 体检:引擎 / 登录态 / Python 依赖 / calc / 注册表 / 密钥扫描……(--net 顺带探测一个行情端点)
scripts/doctor --net
```

用 OpenAI API key 而不是订阅:跳过第 5 步,改为 `export OPENAI_API_KEY=sk-...`,运行时加 `--auth api_key`(或在 `.local/config.json` 写 `{"provider": {"auth": "api_key"}}`)。

### 第一次运行

```bash
# 六阶段完整研究(约 8–10 分钟;默认接入注册表全部适用端点 + 召回知识档案)
node orchestrator/src/run.ts --symbol 300308 --market SZ --python "$(pwd)/.venv/bin/python" < /dev/null
# 产物在 .local/runs/<run-id>/ :report.md · viewer.html(双击用浏览器打开)· report_appendix.md · manifest.json
```

退出码:0 complete / 2 incomplete 或 stale / 3 failed。状态含义见 `orchestrator/README.md`。第一次建议先跑 `--endpoints core`(只用 8 个核心端点,更快)确认链路通,再跑全量。

## 用法速查

| 目的 | 命令 |
|---|---|
| 完整研究 | `node orchestrator/src/run.ts --symbol 300308 --market SZ --python <venv>/bin/python [--run-id X] [--endpoints full\|core] [--knowledge on\|off] [--provider <id>] [--model M] [--reasoning medium]` |
| 只取一个端点 | `<venv>/bin/python .agents/skills/data-access/scripts/fetch_endpoint.py --endpoint em_margin_trading --symbol 300308 --out-dir .local/mcp/try`(端点目录:`datasources/CATALOG.md`) |
| 算一个数 | `<venv>/bin/python calc/cli.py forward_pe --args '{"price": 100, "eps_forecast": 5}'`(函数契约:`calc/SPEC.md`) |
| 接入 Codex CLI(MCP) | `codex mcp add vibe-research -- node "$(pwd)/orchestrator/src/mcp.ts"` → 在 Codex 里直接用 list_endpoints / fetch_endpoint / start_research / research_status / get_report / get_evidence / list_runs / knowledge_recall |
| 本机 HTTP API + 浏览页 | `node orchestrator/src/api.ts --port 8765` → 浏览器打开 `http://127.0.0.1:8765/login?token=<token>`(token 在 `.local/api.token`)|
| 多标的批量 | `node orchestrator/src/batch.ts --symbols 300308,002463 --market SZ --python <venv>/bin/python` → `.local/batches/<id>/summary.md` |
| 两次运行变化提醒 | `node orchestrator/src/alerts.ts --symbol 300308 --market SZ [--base run-a --new run-b]` → `.local/alerts/…` |
| 数据源健康巡检 | `<venv>/bin/python datasources/health.py` |
| 初始化 / 体检 | `scripts/init [--python P] [--provider <id>] [--force]` / `scripts/doctor [--net] [--json]`(退出码 0 全 ok / 2 只有 warn / 3 有 fail;报告在 `.local/doctor/`) |
| provider 兼容矩阵 | `node orchestrator/src/provider_matrix.ts --provider deepseek --model deepseek-chat` |

后台运行一律加 `< /dev/null`,否则 Codex 会停在等待标准输入。

## 模型接入

默认走 **ChatGPT 订阅登录**(产品自己的 CODEX_HOME,不碰 `~/.codex`)。换模型三步:

```bash
export DEEPSEEK_API_KEY=...                                             # 1) 密钥只放环境变量(各家变量名见 providers/*.json)
node orchestrator/src/provider_matrix.ts --provider deepseek            # 2) 先跑 10 项兼容矩阵(结果在 .local/provider-matrix/)
node orchestrator/src/run.ts --symbol 300308 --provider deepseek --model deepseek-chat --python ...   # 3) 全绿再用于研究
```

内置模板:`openai` / `deepseek` / `qwen`(DashScope 兼容模式)/ `glm` / `kimi`。也可写进 `.local/config.json`:`{"provider": {"profile": "deepseek"}, "defaults": {"model": "deepseek-chat"}}`;auth 不写时自动按模板选 `api_key`,显式 `--auth` / `VRA_PROVIDER_AUTH` 优先。第三方模板必须显式 https `base_url`(Codex 对空 base_url 会回退到 OpenAI 官方端点)。

OpenAI 基线矩阵(订阅登录,2026-08-22):9 pass · 1 n/a。国产模型矩阵需要对应 API key 才能真跑,模板的 `matrix.status` 以实际结果回填。详细指南:[docs/model-access.md](docs/model-access.md);模板字段与约束:[providers/README.md](providers/README.md)。

## 配置与环境变量

优先级(低 → 高):内置默认 ← `vibe-research.config.json`(产品配置,入库,无密钥)← `.local/config.json`(用户私有,gitignore)← 环境变量 ← CLI 参数。

`.local/config.json` 示例:

```json
{ "python": "/abs/path/.venv/bin/python",
  "provider": { "profile": "openai", "auth": "chatgpt_login" },
  "defaults": { "model": null, "reasoning": "medium", "turn_timeout_min": 20 } }
```

| 环境变量 | 作用 |
|---|---|
| `VRA_PYTHON` / `VRA_CODEX_PATH` / `VRA_CODEX_HOME` | Python 解释器 / Codex 二进制(空 = SDK 内置)/ 产品 CODEX_HOME(默认 `.local/codex-home`) |
| `VRA_PROVIDER` / `VRA_PROVIDER_AUTH` | provider 模板 id / 认证方式(`chatgpt_login` 或 `api_key`) |
| `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`、`ZHIPU_API_KEY`、`MOONSHOT_API_KEY` | 各 provider 的密钥(名字由模板 `env_key` 声明) |
| `VRA_API_TOKEN` | HTTP API 的 Bearer token(不设则自动生成到 `.local/api.token`) |
| `VRA_SEC_CONTACT` | SEC 端点必需的联系方式("姓名 邮箱",SEC 要求) |
| `IWENCAI_API_KEY` | 同花顺问财(可选) |
| `VRA_ALLOW_INSECURE_TLS=1` | 申万 / 深交所证书链失败时的显式降级(默认失败不降级) |
| `VRA_REPO_ROOT` | MCP server 的仓库根(默认按文件位置推导) |

**密钥只从环境变量读,不进任何配置文件;agent 的 shell 命令不继承任何密钥类变量。**

## 架构

```
                 ┌──────────────── 提示层 ────────────────┐
                 │ AGENTS.md 宪法 + .agents/skills SOP     │
                 └────────────────────────────────────────┘
 取数(编排器执行,内存账本)→ agent turn(Codex SDK,沙箱 cwd=运行目录,无网络)→ validator → 补跑 → 合规 gate → 合并
   ▲ fetch_endpoint.py × 注册表            ▲ hooks: Stop(缺产物不许收工)/ PreToolUse(禁自跑取数 / 联网 / 改证据)
   │ raw/ 原文落盘 + sha256                 │ calc/cli.py(确定性计算,记 DAG)
 ┌──────────────── 执行层 ────────────────┐  ┌──────────── 编排层 ────────────┐
 │ Codex 原生 hooks + workspace-write 沙箱 │  │ orchestrator(TS)+ validator + gate │
 └────────────────────────────────────────┘  └────────────────────────────────────┘
```

六阶段:`profile → financials → estimates → valuation → risk → report`。每阶段至少一个 Codex turn(validator / Stop 钩子不通过就带着错误补跑);agent 读编排器取好的 `fetch/*.json`、本次 `calcs/` 与 `conflicts.json` 以及仓库里的 SOP 文档,只能经 calc 计算,只能写本阶段产物;validator 不信任 agent 自报——`fetch/` `raw/` 下每个文件必须在内存账本里且 sha256 一致,引用的证据 id 必须真实存在,必需计算必须出现并可复算。

| 路径 | 作用 |
|---|---|
| `AGENTS.md` | 金融研究宪法(Codex 自动加载) |
| `.agents/skills/` | 投研 SOP skills(`data-access` 取数、`company-research` 六阶段 SOP、`valuation` 估值口径、`earnings-analysis` 财报拆解、`industry-chain` 产业链与不可替代性、`catalyst-risk` 催化剂与风险;Codex 项目级 skill 的真实发现路径) |
| `datasources/` | 端点注册表 `registry.json` + 自动生成的 `CATALOG.md` + `health.py` 巡检 + RSS 源表 |
| `calc/` | 确定性计算库(纯函数 + fixture 测试 + CLI) |
| `orchestrator/` | 薄编排器 / validator / gate / hooks / 知识层 / 查看器 / service / MCP / HTTP API / 批量 / 提醒 / provider / 矩阵(详见 `orchestrator/README.md`) |
| `providers/` | provider 模板(只引用环境变量名) |
| `knowledge/` | 知识层**模板**(用户档案一律在 `.local/knowledge/`) |
| `scripts/` | `init`(幂等初始化 `.local/`)/ `doctor`(体检) |
| `docs/` | 模型接入指南等文档 |
| `.local/` | 用户私有层:配置 / 运行产物 / 知识档案 / 登录态 / token(已 gitignore) |
| `codex-version.json` | 已测 Codex 版本锚定 |

## 数据源

106 个端点 / 24 层 / CN + US + HK,按合规级标注(`cn-public` 国内公开网页接口 · `S` 官方政府数据 · `B` 非官方 / 个人研究 · `C` 仅个人研究 · `rss-public` 公开 RSS)。原则:证据单位 / 币种按源原样由 mapper 明示、每条证据绑定 raw 原文、**取数层不做任何求和 / 比率 / 派生**(派生量一律经 calc 记 DAG)、跨源冲突显式报告不静默取舍。目录见 [datasources/CATALOG.md](datasources/CATALOG.md);新增端点 = 源函数 + mapper + 注册表条目 + 重生成目录 + 离线测试。

部分源有本地限制(东财 push2 偶发断连有多主机备源;百度 K 线源侧 403;申万 xls 证书链;mootdx 偶发不可达;SEC 需 `VRA_SEC_CONTACT`),`health.py` 巡检会如实列出。

## 安全与隐私

- **产品 / 用户数据分离**:持仓、密钥、个人研究结论永不进仓库;一切私有数据在 `.local/`(gitignore)。
- **密钥只走环境变量**;provider 模板只记变量名;Codex 线程的 shell 环境策略排除 `*KEY* / *SECRET* / *TOKEN* / *PASSWORD*`;事件日志与矩阵产物落盘前脱敏。
- **隔离的 CODEX_HOME**:产品从不读写用户的 `~/.codex`;MCP 接入用户 CODEX_HOME 由用户自己决定。
- **沙箱**:agent 的 cwd 锁定在运行目录(workspace-write),无网络访问,approval never;取数由编排器在最小环境里执行。
- **本机 API**:默认只绑 127.0.0.1(显式 `--host` 非回环地址必须设置 `VRA_API_TOKEN`,且自动关闭 cookie 登录;回环 = 127.0.0.1 / localhost / ::1);每个请求都要鉴权:Bearer token 对所有路由有效,回环绑定下 `/login?token=` 用查询参数换 cookie,该 cookie 只能放行白名单里的只读 GET;拒绝跨站 / 非本机 Origin / 非 JSON POST;所有路径经 `safePath()`(禁符号链接、必须在 `.local` 内)。
- **产出红线**:只报数据 / 框架 / 概率 / 裁决点,不给建仓 / 加减仓 / 目标价 / 止损位;schema 层隔离 + 合规 gate 后处理。

## 开发与测试

```bash
.venv/bin/pip install pytest                                               # Python 测试依赖(取数 requirements 不含 pytest)
(cd orchestrator && npm run typecheck && npm test)                       # TypeScript:94 个 node:test
.venv/bin/python -m pytest calc/tests -q                                   # calc:128 个
.venv/bin/python -m pytest .agents/skills/data-access/scripts/tests -q    # 取数层离线测试
.venv/bin/python datasources/gen_catalog.py                                # 改注册表后重生成 CATALOG.md
```

工作约定:每完成一步 → Codex 独立审查(`codex review` / `codex exec` 审查提示)→ 逐条核实(会误报)→ 修 → 复审至无实质问题 → 才合并;审计必须在 push 之前。

## 状态与路线图

**已完成(2026-08-22)**:Phase 0 七步(编排器 v0.4 + validator + gate + hooks v0 + 硬测试 harness)+ Phase 1 M1(数据源全量接入)/ M2(知识层 · 查看器 · 扩展数据进阶段 · 技术指标与筹码进 calc)/ M3(service · MCP · HTTP API · 批量 · 提醒)/ M4(provider 模板 · 兼容矩阵 · 薄 UI)/ `scripts/init` · `scripts/doctor`,各经 Codex 多轮独立审查闭环。

**待做**:国产模型矩阵真测(需各家 API key)→ 按结果回填模板;Windows hooks 哈希;Responses↔Chat 自建适配器(独立子项目);正式发布(License 拍板 + tag + Release;维护者待办与发布时序见 [docs/release-checklist.md](docs/release-checklist.md))。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 免责声明

本项目只产出研究数据、分析框架、情景概率与裁决点,**不提供任何投资动作建议**(建仓 / 加减仓 / 目标价 / 止损位)。所有输出不构成投资建议,数据来自第三方公开接口、可能延迟或有误,使用者自行核实并承担决策责任。请遵守各数据源的使用条款(部分端点仅限个人研究用途)。

## 赞赏

<p align="center">
  <a href="https://buymeacoffee.com/simonlin1212"><img src="./assets/bmc-qr.png" width="180" alt="Buy Me a Coffee"></a>
</p>

## License

License 待维护者拍板(引擎 openai/codex 为 Apache-2.0;本仓库不含 Codex 源码)。发布前补 `LICENSE` 文件与徽章。

**作者：** Simon 林 · X [@linsizhen](https://x.com/linsizhen) · 邮箱：[simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)
