# CHANGELOG

格式遵循 Keep a Changelog;版本号待首次发布时定(当前未发布)。

## Unreleased

### skills 隔离 + 中文路径修复(2026-08-22,接手后首批)
- `orchestrator/src/skills_isolation.ts`:Codex 会从用户主目录 `~/.agents/skills`(按 `$HOME`,与 `CODEX_HOME` 无关)与捆绑系统 skills 发现 skill,用户的个人 skill 会挤爆 skills 目录预算并污染提示层(本机实测 92 个个人 skill,agent 去读了 `~/.agents/skills/<x>/SKILL.md`,靠 PreToolUse 钩子拦下)。现每次运行开始时在产品 `CODEX_HOME/config.toml` 标记块内写入 `[skills] max_context_tokens = 10000` / `[skills.bundled] enabled = false` / 逐条 `[[skills.config]] path … enabled = false`(按 path 不按 name),幂等、不动块外内容、与 hooks 块并存;manifest 新增可选 `skills_isolation`,事件 `skills.isolated`;`doctor` 新增检查项「用户级 / 捆绑 skills 隔离」;CLI `node orchestrator/src/skills_isolation.ts --codex-home <dir>` 可立即写入。
- `hooks.ts mergeBlock` 接受自定义块标记(hooks / skills 两块复用同一机制)。
- Codex 审查 r1(3 P1 / 3 P2 / 1 P3,全部核实成立)→ 修:枚举改为复刻 Codex Recursive 发现(≤ 6 层、跳隐藏祖先、跟随目录符号链接、环路去重;原先只看直接子目录会漏禁嵌套 skill);主目录解析与 `dirs::home_dir()` 同语义(`resolveHomeDir`:相对 HOME 不枚举、空 HOME 回退 passwd);事件 / CLI 只记数量与清单 sha256,不再把用户路径清单写进 events.jsonl(service 层会经 API / MCP 回传);枚举只吞"根不存在",权限 / I/O 错误抛出终止;块外冲突检测覆盖注释、引号表头、点号键、顶层内联表;doctor 结构化核对块(path 必须配 `enabled = false`、bundled、预算合法),无块一律 warn,修复命令改绝对路径 + POSIX 单引号;`scripts/init` 首装即写隔离块。
- 修复:`knowledge_viewer.test.ts` / `validator.test.ts` 用 `new URL(import.meta.url).pathname` 算仓库根,安装路径含非 ASCII(如中文目录)时百分号编码导致 `calc/cli.py` 找不到 → 统一 `fileURLToPath`;`service_api_mcp.test.ts` 去掉写死的开发机 venv 路径,改为 `VRA_PYTHON → 仓库 .venv → 上级 .venv → python3`。
- Codex 审查 r2(3 P1 / 5 P2,核实全部成立)→ 修:① 目录深度边界按 Codex 自测同构(`d0/…/d5/SKILL.md` 可见、第 7 层不可见;原先少扫一层);② **SKILL.md 文件符号链接一律忽略**(Codex `ignores_symlinked_skill_files`;原先跟随,用户目录里一条指向产品 skill 的链接经 Codex canonicalize 会把产品 skill 禁掉),并且 **realpath 落在产品仓库内的路径一律不写入**(编排器 / init / doctor / CLI 都传产品根);③ 多结果函数(`pe_digestion_scenarios`)的四锚年数在 `details.scenarios.<情景>` 里没 display 可抄 → `attach_display` 给 details 里所有结果形子对象附 display,report 提示词指向它;④ 块外冲突检测解码引号 / `\u` 转义键;⑤ doctor 状态解析:同时含 `path` 与 `name` 的条目按 Codex 语义整条忽略(不算禁用)、单引号 path / `10_000` 预算不算有效;⑥ 错误信息里的用户路径改 `~` 相对;⑦ `verifyCalcs` 复算时比较 `display`(被删 / 被改即不一致);⑧ display 缩放后二次校验有限性(`1e308` 不再吐出 `inf%`);⑨ hardtest `claimTokens` 小整数白名单加 `年 / 期`(消化年数与期数不再绕过数字绑定)。**未采纳并说明**:事件 / manifest 里的 `config_toml` 绝对路径保留(产品目录,manifest 本就记 `engine.codex_home`);Codex 的 2,000 目录 / 20,000 条目截断不复刻(Codex 截断只会少看到 skill,我们多禁无害);块外冲突检测仍是行扫描而非 TOML AST(产品 CODEX_HOME/config.toml 只有 init / 编排器 / Codex 自己写,Codex 只写 `[projects]`;多行字符串伪装表头会误拒不会漏判)。
- Codex 审查 r3(2 P1 / 7 P2)→ 采纳并修:① 排除规则改为"产品 skill 集合成员"(按 Codex Repo 规则枚举 `<repo>/.agents/skills` 取 canonical),不再按仓库前缀(仓库内非 skill 目录被用户链接指向时照样禁;产品 skill 链到仓库外也能正确排除);② doctor 严格按生成器格式判块内条目——带 `name` / 额外键 / 后置 `enabled = true` 的条目一律 malformed(Codex 按顺序应用 selector,后置 name 规则会撤销前面的禁用);③ `verifyCalcs` 递归比较 output 的 display 投影(四锚子 display 被删 / 改即不一致;旧记录无 display 不误报);④ `claimTokens` 改为"带小数点的小数字必查、纯整数叙述跳过"(display 写法 `2.00 年` 必绑定,"近 5 年 / 连续 3 期"不误红),撤回 r2 的"年 / 期 进白名单";⑤ 块外冲突检测跳过多行字符串;⑥ 目录上限按唯一 canonical 目录计数。**核实后不采纳并说明**:兄弟符号链接——Codex 整根按 canonical 全局去重只遍历其一(`exec-server/src/local_file_system.rs visited_directories`),我们两条都禁是安全超集(多余 selector 无害),r2 "两条各算一个"的说法有误、r3 对,实现保留、文档改正;TOML AST / 写前整文档解析、复刻 2,000 / 20,000 截断、事件与 CLI 里的 `config_toml` 绝对路径与异常信息里的 `~/.agents/skills/<名>`——维持不采纳(产品 CODEX_HOME/config.toml 只有 init / 编排器 / Codex 写;Codex 截断只会少看到 skill;用户需要知道哪个目录不可读才能修);"报告逐字照抄 display"的验收检查列为后续项(硬测试 harness 扩展,非本批范围)。
- Codex 审查 r4(闭环确认,2 P1 / 若干 P2)→ 采纳并修:① 枚举改为与 Codex 同构的**排序 BFS**,在 2,000 唯一目录 / 20,000 条目处 **截断继续**(`truncated` 写进事件与 manifest,不再抛错——用户 skill 目录里有 `node_modules` 时原先会打断整个运行);② 写入前用 Python `tomllib` 解析合并后的整份 config.toml,不过不写(零新依赖,产品本就带 venv;python 不可用或无 tomllib 时记 `toml_validated: null`);③ 多行字符串判定改为引号感知(`x = 'Use """ here'` 不再被当成多行开头);④ doctor 块解析支持引号 / 转义键(`"name"` / `"na\u006de"` 不再静默跳过 → malformed),非键值行也算偏离;⑤ `verifyCalcs` 改比整份**结果投影**(顶层 + details 子结果的 status / unit / value / display),只在 calc_version 相同时比;⑥ `claimTokens` 把 `期` 加回白名单(quarterize 的 "11 期" 必须绑定);⑦ 硬测试第 5 组新增「报告派生数字逐字照抄 calc display」(`judgeDisplayFidelity`:带小数点或带单位的数字必须逐字等于所引用 calc 的 display / 子 display,或绑定 evidence 原值;叙述整数豁免;年 / 期 的整数必须匹配 display——"消化 30 年"这类把锚点写成年数的错误能抓住;旧运行无 display 自动跳过)。审查员本轮接受 A(兄弟链接超集)与 D(路径保留)两项不采纳。
- calc 0.3.2:`cli.py` 落盘前给 `output` 附确定性 `display` 展示字符串(`calc/display.py`:|x|≥1 留 2 位小数、|x|<1 留 4 位有效数字;`小数`→百分比、金额按量级换算到亿元/万元/元、`期` 取整;status ≠ ok 为 null),report 阶段提示词改为"派生数字照抄 display、不抄原始浮点、不自己换算";schema `output.display` 可选(旧记录兼容);`value` 仍是复算 / 绑定校验真理源,公式层不变。修的是验收报告 §6-8 / §8-7 点名的"报告数字 15 位浮点"。
- risk 阶段提示词:明确 `primary_source` 是 `fetch_kline.json` 顶层信封字段(实测 agent 去 `extra` 里找、找不到就跳过技术指标)。

### SOP skills 补齐 + calc 0.3.1(2026-08-22)
- `.agents/skills/` 新增四个口径 skill:`valuation`(三口径 PE / 前瞻 vs TTM 交叉验证 / 一致预期分歧 / 四锚消化年数与 30 倍锚三铁律 / 判读与常见错误)、`earnings-analysis`(累计 → 单季 → TTM 口径地图 / 扣非 vs 归母 / 三表交叉 / 比率经 calc)、`industry-chain`(六步下钻 × 每层四问 / 物理硬筛子 / 不可替代性标签 / 预期差四问校准)、`catalyst-risk`(催化剂四类 / 风险十类与反证 / 裁决点标准写法 / 旧结论处理);company-research SOP 加按阶段加载指引。全部从方法论母本脱敏翻译:不含任何持仓 / 个人结论 / 推荐,不给投资动作建议。
- calc 0.3.1:新增 `ratio(numerator, denominator, label, unit_in)`(同单位两数之比,分母 ≤ 0 → not_meaningful,不做单位换算);19 个函数,128 测试。

### scripts/init · scripts/doctor(2026-08-22)
- `orchestrator/src/init.ts`:幂等初始化产品私有层 `.local/`(目录 / `config.json` 骨架 / `.gitignore`),不碰 `~/.codex`;`--force` 先备份再重写。
- `orchestrator/src/doctor.ts`:15 项体检(引擎二进制与版本锚定 / 登录态或 api_key 环境变量 / 宪法 / skills / Python 依赖 / calc / 注册表 / 写权限 / `.gitignore` / 密钥扫描 / `api.token` 权限 / `--net` 数据源连通),中文修复提示,报告写 `.local/doctor/`,退出码 0 / 2 / 3。
- 正式文档:`README.md`(中文主档)+ `README_en.md` + `CHANGELOG.md` + `docs/model-access.md`。

### Phase 1 M4 — 模型接入(2026-08-22)
- `providers/<id>.json` provider 模板:openai / deepseek / qwen / glm / kimi(只引用环境变量名);`validateProfile` 组合约束(第三方必须显式 https base_url、只能 api_key、responses_support 与 wire_api 自洽、`verified_at`)。
- `orchestrator/src/providers.ts`:模板 → Codex `model_provider` / `model_providers.<id>` 映射;密钥只按 `env_key` 名透传;providers 目录符号链接 / 越界拒读。
- 选择方式:`--provider <id>` / `VRA_PROVIDER` / `.local/config.json provider.profile`;`--auth` / `VRA_PROVIDER_AUTH`;用户未显式写 auth 时自动按模板选择。
- `provider_matrix.ts`:10 项兼容矩阵 harness(严判口径、并发观察、落盘前脱敏、`judge()` 单测);openai 基线 9 pass · 1 n/a。
- HTTP API 薄 UI:`/login?token` → cookie(HttpOnly / SameSite=Strict)→ `/ui` 运行列表 / `/ui/runs/:id`;cookie 只对白名单只读 GET 有效;统一安全响应头;非本机绑定关闭 cookie 登录。
- Codex 独立审查四轮闭环(12 → 6 → 1 → 0)。

### Phase 1 M3 — 服务层与接口(2026-08-22)
- `service.ts`(闭合输入校验 / `safePath` / 最小子进程环境 / 相对路径 + 脱敏)→ `mcp.ts`(stdio MCP server,8 工具)、`api.ts`(本机 HTTP,每请求鉴权:Bearer 或本机登录 cookie,+ 反 CSRF)、`batch.ts`(多标的顺序研究 + 只转录汇总)、`alerts.ts`(两次运行证据按事实键含来源对齐,只并列两值)。
- calc 0.3.0:`technical_indicators` / `chip_distribution` + CLI `history_json` 序列输入;取数层计算型端点退出阶段计划。
- Codex 审查三轮闭环(M3)+ 三轮闭环(calc 0.3.0)。

### Phase 1 M2 — 知识层与查看器(2026-08-22)
- `knowledge.ts`:运行自动归档到 `.local/knowledge/`(合规 + 私密两道 gate),下次默认召回(数据边界、新鲜度、按章节截断),各阶段 `knowledge_conflicts` 裁决。
- `viewer.ts`:自包含 `viewer.html` + `report_appendix.md`。
- 各阶段可选 `extra_findings`(按阶段 topic 枚举);SOP §6 扩展数据使用规则。

### Phase 1 M1 — 数据源全量接入(2026-08-22)
- `datasources/registry.json` 104 端点 / 23 层(CN / US / HK)+ `fetch_endpoint.py` 通用取数器 + 20 个源模块 + mapper 约定(单位 / 币种按源原样、record_key 唯一、逐请求绑定 raw、取数层零派生计算)+ `CATALOG.md` 自动生成 + `health.py` 巡检。
- 编排器阶段计划由注册表推导(`--endpoints full|core`);validator 新增 raw_ref / 账本自洽 / 反向文件检查等不变量。
- Codex 审查五轮闭环。

### Phase 0 — 骨架与硬测试(2026-08-21 → 2026-08-22)
- 金融研究宪法 `AGENTS.md`、`data-access` / `company-research` skills、`calc/` 0.2、薄编排器 v0.4(TS SDK 0.149.0,零 fork)+ validator(语义槽位 v2)+ 合规 gate + hooks v0(Stop / PreToolUse)+ 产品配置分层(v2.1 §5)+ 硬测试 harness(六组 + 钩子七项 16/16)。
- 试金石标的:中际旭创 300308。
