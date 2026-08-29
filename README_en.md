<p align="center"><a href="README.md">简体中文</a> | <b>English</b></p>

<h1 align="center">Vibe Research</h1>

<p align="center">
  <b>A local financial research workbench built on the Codex Harness</b><br>
  Codex and Claude Code subscriptions connected · live local login detection · most compatible model APIs supported
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-v1.0.0-F35D2B">
  <img alt="UI" src="https://img.shields.io/badge/UI-React%20%2B%20Vite-646cff">
  <img alt="Orchestrator tests" src="https://img.shields.io/badge/orchestrator-538%20checks-passing">
  <img alt="Desktop tests" src="https://img.shields.io/badge/desktop-25%20tests-passing">
  <img alt="Codex Harness" src="https://img.shields.io/badge/runtime-Codex%20Harness-black">
</p>

<p align="center">
  <a href="https://viberesearch.wiki">Website</a> ·
  <a href="#what-it-is">What it is</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#model-access">Models</a> ·
  <a href="#data-and-markets">Data</a> ·
  <a href="#security-and-privacy">Security</a> ·
  <a href="#development-and-tests">Development</a> ·
  <a href="#current-boundaries">Boundaries</a> ·
  <a href="CHANGELOG.md">CHANGELOG</a>
</p>

---

## What it is

Vibe Research is a **local financial research workbench built on the
[OpenAI Codex Harness](https://developers.openai.com/blog/codex-as-a-platform)**. The Harness maintains context,
selects tools, advances tasks, handles failures, and preserves execution state on the local machine. Vibe Research
adds financial data, research procedures, deterministic calculations, evidence checks, and compliance boundaries.

The previous version called model APIs directly to produce individual analyses. The current version is a local
financial agent built on Codex: it can understand a task, call tools over multiple steps, request missing
information, run the research workflow, and preserve the full process. Compared with a single API request, this
substantially improves long-task execution, tool use, context retention, and reasoning quality.

| Previous version: direct model API | Current version: local Codex financial agent |
|---|---|
| One request produces one analysis | Advances a complete research task over multiple steps |
| The app decides the calls in advance | The agent reads the live tool catalog and chooses the appropriate tool |
| The page temporarily holds context and state | The Harness maintains local context, progress, and failure recovery |
| Usually returns a block of prose | Preserves reports, evidence, calculations, gaps, and run status |
| Model output is displayed directly | Validators, sandboxing, hooks, and a compliance gate review the result |

The architecture supports both subscription runtimes and model APIs. Codex and Claude Code are connected end to
end. The settings page detects each local CLI, version, and login state. If Codex is not authenticated, the user
can open the official authorization page with **Log in to Codex** and the page detects completion automatically. Qwen Code and the
DeepSeek CLI currently require their own API key, so they remain API paths rather than pretending to be keyless
subscriptions. The API side supports most providers that expose the Responses API.

## Features

| Module | Current capability |
|---|---|
| Home agent | Start a conversation immediately and ask about a company, industry, market review, or research task |
| Daily review | Summarises market activity, themes, limit-up drivers, and daily signals |
| Intelligence radar | Translated Investment News headlines, public news, A-share filings, and event probabilities |
| Industry signals | GPU rental rates, monthly industry data, commodities, hiring, and data calendars |
| Sector centre | Reviews sector performance and drills into specific industry themes |
| Company research | Six-stage A-share workflow: profile, financials, consensus, valuation, risk, and report |
| My reports | Stores PDF, DOCX, TXT, MD, and CSV locally, with extraction, search, citations, download, and deletion |
| Backtesting | Uses an agent conversation as the only input; asks for missing details, then calls the real backtest tool |
| Bull/bear review | Bull, bear, rebuttal, and neutral-referee stages share the same factual dossier |
| Watchlist and portfolio | Recognises A-share, US, and Hong Kong symbols; stores records locally and refreshes quotes |
| Research records | Stores research, backtest, and debate reports with search, timestamps, expansion, and deletion |
| Connect AI | Uses a subscription login or a user-supplied model API configuration across the entire agent UI |

### Research output is inspectable

A six-stage research run produces:

- `report.md`: the final research report.
- `evidence.json`: evidence used in the run, including source, date, and raw reference.
- `calculations.json`: deterministic inputs, functions, and calculation DAGs.
- `conflicts.json`: disagreements between sources, without silent resolution.
- `manifest.json`: model, version, stages, status, recalled documents, and run metadata.
- `viewer.html`: a browser-readable evidence and report viewer.

If required data is missing, the run becomes `incomplete` or `failed`. It does not fill gaps with stale values or
model guesses.

## Quick start

### Requirements

| Item | Requirement |
|---|---|
| Operating system | Windows 11, macOS, or Linux; Windows runs natively and does not require WSL |
| Node.js | ≥ 22.18; Node 24 LTS recommended |
| Python | ≥ 3.11; Python 3.12 recommended and currently verified |
| Codex CLI | Version 0.149.0 verified; see `codex-version.json` |
| Model access | ChatGPT or Claude.ai subscription login, or a provider that supports the Responses API |

### Install dependencies

Windows (PowerShell or Command Prompt):

```bat
git clone https://github.com/simonlin1212/Vibe-Research.git vibe-research-agent
cd vibe-research-agent
scripts\setup-windows.cmd
scripts\start.cmd
```

`setup-windows.cmd` creates `.venv`, installs Node/Python dependencies, initializes the private product data
directory, and runs diagnostics. `start.cmd` starts the local API and browser UI and opens
`http://127.0.0.1:5930`.

macOS / Linux:

```bash
git clone https://github.com/simonlin1212/Vibe-Research.git vibe-research-agent
cd vibe-research-agent

npm install --prefix orchestrator
npm install --prefix desktop

python3 -m venv .venv
.venv/bin/pip install -r .agents/skills/data-access/scripts/requirements.txt

npm install -g @openai/codex@0.149.0
scripts/init --python "$(pwd)/.venv/bin/python"
```

### Connect a model

For ChatGPT subscription access, start the UI, open **Connect AI → Subscription**, and click **Log in to Codex**.
Complete authorization on the official OpenAI page that opens, return to Settings, and click **Test and save**
after the login status turns ready. The product uses its own `.local/codex-home` and never reads or overwrites
`~/.codex`. If the browser does not open automatically, use
`CODEX_HOME="$(pwd)/.local/codex-home" codex login` as a fallback.
On Windows, the fallback is
`$env:CODEX_HOME="$PWD\.local\codex-home"; codex login`.

For Claude.ai subscription access, install and log in to Claude Code. The settings page detects it automatically;
no Claude API key needs to be entered into Vibe Research.

For API access, open **Connect AI → API access**, choose a provider, enter the API base URL, model name, and key,
then click **Test and save**. A real model request must succeed before the new configuration is saved and shared
by the agent pages.
If the agent asks you to reconnect there, the local login session has expired; the research or backtest workflow
itself has not failed.

### Start the browser UI

On Windows, `scripts\start.cmd` handles both processes. On macOS / Linux, open two terminals:

```bash
# Terminal 1: local API
node orchestrator/src/api.ts --port 8765
```

```bash
# Terminal 2: React UI
npm run dev --prefix desktop
```

Open [http://127.0.0.1:5930](http://127.0.0.1:5930).

Vite proxies `/api/*` locally and adds authentication on the server side. If `VRA_DATA_ROOT` is set, both
processes must use the same value.

### Run one research job from the command line

Windows PowerShell:

```powershell
node orchestrator/src/run.ts `
  --symbol 300308 `
  --market SZ `
  --python "$PWD\.venv\Scripts\python.exe"
```

Windows automatically uses the `controlled_mcp` execution layer. The research thread has no shell access and no
workspace write permission; it can only read sanitized run files, call deterministic calculations, and write the
current stage through controlled tools. macOS and Linux keep the existing hook-based execution layer.

macOS / Linux:

```bash
node orchestrator/src/run.ts \
  --symbol 300308 \
  --market SZ \
  --python "$(pwd)/.venv/bin/python" < /dev/null
```

A full run usually takes 15–19 minutes. Progress remains visible, and results are written to
`.local/runs/<run-id>/`. Exit codes: `0` complete, `2` incomplete/stale, and `3` failed.

## How it works

```text
Browser workbench
Home agent · review · intelligence · company research · backtesting · document library
        │
        ▼
Finance agent layer
117 data endpoints · six-stage SOP · calc · validator · report archive
        │
        ▼
OpenAI Codex Harness
agent loop · context · tools · progress · sandbox
        │
        ▼
Local Agent Runtime
Codex SDK · Claude Code CLI (local detection / login probe / restricted execution)
        │
        ▼
Model Provider
ChatGPT / Claude.ai subscriptions · OpenAI · DeepSeek · Qwen · GLM · Kimi · MiMo · compatible APIs
```

The project enforces its rules at three levels:

| Layer | Components | Purpose |
|---|---|---|
| Instruction | `AGENTS.md` + `.agents/skills/` | Defines financial research discipline and procedures |
| Execution | Codex hooks + workspace sandbox | Restricts network, file access, data fetching, and output locations |
| Orchestration | orchestrator + validator + calc + gate | Enforces stages, citations, deterministic calculations, and compliance |

The project does not modify Codex source code. The Codex checkout is an upstream reference only; the product uses
the official CLI and SDK.

## Model access

The **Connect AI** page separates the agent runtime from the model provider:

- The Codex Harness manages local context, tool calls, task state, progress, and failure handling.
- The Local Agent Runtime connects subscription logins to the workbench. It currently supports the product Codex runtime and the locally installed Claude Code CLI, with live version and login detection. Codex login can be launched from Settings and is detected automatically after authorization.
- The model provider supplies reasoning only. Changing models does not replace tools, memory, evidence, or research rules.
- Codex subscription mode uses the product's own `CODEX_HOME` and never reads or writes the user's `~/.codex`. Claude subscription mode reuses the local Claude Code login while forcing local tools, MCP, web-search tools, and CLI session persistence off.
- Both subscription and API configurations must pass a real conversation probe before **Test and save** updates the active configuration.
- In API mode, the key remains in the current browser's `localStorage`. It is sent to the local backend per request
  and is not written to the repository, configuration files, run ledger, or logs.

Built-in provider templates: OpenAI, DeepSeek, Qwen, GLM, Kimi, and MiMo. The engine supports the Responses API
only. A template's presence does not mean it passed the compatibility matrix; the UI distinguishes verified
providers from unverified templates.

See [docs/model-access.md](docs/model-access.md) and [providers/README.md](providers/README.md).

## Data and markets

- Current registry: **117 endpoints across 30 layers**, covering CN, US, and HK.
- Data includes quotes, candles, financial statements, consensus, filings, reports, fund flows, positioning,
  options, SEC/FINRA/CBOE, news, macro data, industry thermometers, hiring, restrictions, and data calendars.
- A-share, US, and Hong Kong symbols work in the watchlist, portfolio, document library, and agent conversations.
- **The six-stage company research workflow currently supports A-shares only.** It will not launch an empty
  US or Hong Kong research run without the required data chain.
- Scanned PDFs require OCR. Text PDFs preserve page-level citations.

See [datasources/CATALOG.md](datasources/CATALOG.md) for the endpoint catalog.

## Project structure

| Path | Purpose |
|---|---|
| `desktop/` | React + Vite local browser UI |
| `orchestrator/` | Agent orchestration, validators, API, MCP, chat, document library, and report archive |
| `backtest/` | Deterministic backtest engine and tool entry point |
| `calc/` | Deterministic calculation library |
| `datasources/` | Endpoint registry, catalog, and health checks |
| `.agents/skills/` | Financial research procedures and data tools |
| `providers/` | Provider templates with no secrets |
| `scripts/` | Initialisation and diagnostics |
| `.local/` | Private user data, reports, sessions, and run artifacts; gitignored |

## Security and privacy

- Original research documents stay on the local machine. The model receives only passages selected by server-side search.
- Keys for the backend's default provider come only from environment variables and are not written to product configuration or the repository.
- An API key entered in the browser stays in that browser's `localStorage` and is sent through the local backend to the selected model provider only when used.
- Document chat disables shell access, image reading, subagents, plugins, apps, and network access.
- Document citations use `[资料:<id> p.<page>]`. Missing, incorrect, or unknown citations are rejected by code.
- Research-stage agents have no network access. The orchestrator fetches data through controlled scripts and stores
  raw responses with hashes.
- The local API binds to `127.0.0.1` by default. Write requests require authentication and JSON.
- Output is limited to data, analytical frameworks, scenario probabilities, and decision checkpoints. It does not
  provide position, sizing, target-price, or stop-loss instructions.

## Development and tests

```bash
npm run typecheck --prefix orchestrator
npm test --prefix orchestrator

npm run typecheck --prefix desktop
npm test --prefix desktop
npm run build --prefix desktop

.venv/bin/python -m pytest calc/tests -q
.venv/bin/python -m pytest backtest/tests -q
.venv/bin/python -m pytest .agents/skills/data-access/scripts/tests -q
```

Current verified baseline:

- orchestrator: **538 checks** (537 passed locally plus one Windows-only ACL check skipped off Windows), Core industry-term count **0**, TypeScript typecheck passed.
- desktop: **25/25**, TypeScript typecheck and Vite production build passed.
- Python (calculation library, backtest, and data scripts): **572/572**.
- The V1.0.0 release changes passed an independent Codex re-review with no actionable P1/P2 findings.

Project rule: test each completed component, run an independent Codex review, verify every finding, fix valid issues,
and re-review. A component is not described as complete and is not committed or pushed before that loop closes.

## Current boundaries

- V1.0.0 is distributed as open-source code plus a local browser UI. The local API and browser UI are started separately.
- MiMo API has passed an end-to-end run from an empty configuration to a real business report. Other third-party
  providers still require the user's own keys and are not marked verified without real compatibility-matrix runs.
- Native Windows 11 support includes PowerShell setup/start scripts, Windows path and process handling, and the
  controlled research toolchain. The CI matrix covers `windows-latest`, `macos-latest`, and `ubuntu-latest`.
  Windows 10 is best-effort, following upstream Codex support.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Disclaimer

This project produces research data, analytical frameworks, scenario probabilities, and decision checkpoints only.
It does not provide investment-action instructions. Nothing produced by this project is investment advice.
Third-party public data may be delayed, incomplete, or wrong. Users are responsible for verification, decisions,
and compliance with each data source's terms.

## Support

<p align="center">
  <a href="https://buymeacoffee.com/simonlin1212"><img src="./assets/bmc-qr.png" width="180" alt="Buy Me a Coffee"></a>
</p>

## License

This repository is licensed under the [MIT License](LICENSE). OpenAI Codex is licensed under Apache-2.0; this
repository does not contain Codex source code.

**Author:** Simon Lin · X [@linsizhen](https://x.com/linsizhen) · Email: [simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)
