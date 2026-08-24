# 发布前清单(维护者待办)

仓库代码与文档已就绪;下面是**只能由维护者拍板 / 提供**的事项,以及发布时序。全部完成前不要 push 公开仓库。

## 1. 待拍板 / 待填

| 项 | 现状 | 动作 |
|---|---|---|
| License | README / README_en 的 License 段与徽章写"pending" | 选定许可证(引擎 openai/codex 为 Apache-2.0,本仓库不含其源码),加 `LICENSE` 文件,替换两份 README 的徽章与 License 段 |
| 仓库地址 | README 安装段 `git clone <本仓库地址>` 为占位 | 建公开仓库后替换两份 README 的 clone 地址;可加 Stars 徽章 |
| 国产模型矩阵 | `providers/{deepseek,qwen,glm,kimi}.json` 的 `matrix.status` 未真测 | 设对应环境变量(`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`)后 `node orchestrator/src/provider_matrix.ts --provider <id> --model <m>`,按结果回填 `matrix.status / results / note / last_run` 与 `verified_at` |
| 模板易变字段 | 四个第三方模板 `default_model` / `context_limit_tokens` 未核实(`verified_at: null`) | 对照各厂商当前文档核实后填 `verified_at` |
| 联系方式与赞赏 | 已按发布规范:X @linsizhen、邮箱、BMC 二维码 `assets/bmc-qr.png` | 核对无误即可 |

## 2. 发布时序(审计必须在 push 之前)

1. `scripts/doctor --net` 全绿(含密钥扫描 ok);
2. `(cd orchestrator && npm run typecheck && npm test)`、`python -m pytest calc/tests -q`、`python -m pytest .agents/skills/data-access/scripts/tests -q` 全过;
3. 一次真实研究运行 complete(🔴 **必须是完整六阶段、不带 `--seed-from` 的运行** —— 硬测试夹具
   (`--fixture`)会跳过前四阶段、产物按测试运行隔离,**不能替代这一步**;夹具运行的 manifest 带
   `seeded_from` 且 `test_scenario: true`,一眼可辨)(`node orchestrator/src/run.ts --symbol 300308 --market SZ --python <venv>/bin/python < /dev/null`);
4. `codex review`(或 `codex exec` 审查提示)→ 逐条核实(会误报)→ 修 → 复审至 "No actionable regressions";
5. 确认 `.gitignore` 含 `.local/`、仓库内无 `.local/` 内容、无密钥(doctor 密钥扫描 + 人工过一遍 `git status`);
6. 英文 README 两遍翻译审查(diff 对照 + 纯英文只读);
7. 填 License / clone 地址 / 徽章 → `CHANGELOG.md` 定版本号 → push + tag + Release。

## 3. 发布后

- 国产模型矩阵结果回填后再发一次小版本;
- `codex-version.json` 的 `verified_on` 随每次版本验证追加;
- 用户反馈的源侧限制(东财 push2 / 百度 403 / 申万证书链 / mootdx)记入 `datasources/` 说明,不在代码里静默降级。
