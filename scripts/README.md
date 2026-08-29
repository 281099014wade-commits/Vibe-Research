# scripts

- `scripts/init`(→ `orchestrator/src/init.ts`):幂等初始化,只生成产品自己的 `.local/` 私有层(目录 / `config.json` 骨架 / `.gitignore` 含 `.local/`),**不读写用户全局 `~/.codex`**;已有配置不改,`--force` 才改(先备份)。选项:`--python P` `--provider <id>` `--force` `--json`。
- `scripts/doctor`(→ `orchestrator/src/doctor.ts`):体检——Node 版本 / 产品配置链 / Codex 引擎二进制(SDK 捆绑或 `engine.codex_path`,对照 `codex-version.json`)/ 全局 codex CLI / 产品 CODEX_HOME 登录态或 api_key 环境变量 / 宪法 / skills 可发现性 / Python 与取数依赖 / calc 自检 / 注册表 / 数据根写权限 / `.gitignore` / 密钥扫描 / `api.token` 权限 / `--net` 数据源连通;每项 ok · warn · fail · skip + 中文修复提示;报告写 `.local/doctor/<时间>.json`(路径相对化、脱敏);`--net` 会把那次取数写到 `.local/mcp/doctor/`;退出码 0 全 ok / 2 只有 warn / 3 有 fail。选项:`--net` `--json` `--python P`。

两者都是非验收型辅助工具,不改变研究运行的状态机。

## Windows

- `scripts\\setup-windows.cmd`:创建 `.venv`、安装 Python/Node 依赖、初始化并运行体检。
- `scripts\\start.cmd`:同时启动本机 API 与浏览器 UI；任一进程异常退出会立即报错，按 Ctrl+C 或 UI 进程退出时会用 `taskkill /T` 收掉两棵子进程树。
- `scripts\\init.ps1` / `scripts\\doctor.ps1`:PowerShell 版的同名入口，不依赖 WSL、Git Bash 或 `/bin/sh`。
- `api.token` 会断开 NTFS ACL 继承，只授权当前 Windows 用户 SID；doctor 会读取真实 ACL，不用 Unix mode 假判。
