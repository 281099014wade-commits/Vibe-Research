<p align="center"><a href="README.md">简体中文</a> | <b>English</b></p>
<h1 align="center">vibe-research-agent</h1>
<p align="center"><b>An open-source A-share equity research agent built on OpenAI Codex ("Codex for Finance")</b><br>zero fork · three-layer constraints · 115-endpoint data pipeline · deterministic calc library · compliance red line · multi-model access</p>
<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-pending-lightgrey">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-orchestrator-3178c6">
  <img alt="Python" src="https://img.shields.io/badge/Python-data%20%2B%20calc-3776ab">
  <img alt="Codex" src="https://img.shields.io/badge/Codex%20CLI-0.149.0-black">
</p>
<p align="center">
  <a href="#what-it-is">What it is</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#usage-cheat-sheet">Usage</a> ·
  <a href="#model-access">Model access</a> ·
  <a href="#configuration-and-environment-variables">Configuration</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#data-sources">Data sources</a> ·
  <a href="#security-and-privacy">Security</a> ·
  <a href="#development-and-tests">Development</a> ·
  <a href="#status-and-roadmap">Roadmap</a> ·
  <a href="CHANGELOG.md">CHANGELOG</a>
</p>

---

## What it is

OpenAI Codex is the engine. It is combined with **the discipline, data pipeline and calculation library of equity research**, so the agent can research a Chinese A-share company (US / HK market data is supported as well) through six stages — company profile → financials → consensus estimates → valuation → risk → report — and produce a research report that is **auditable, recomputable and backed by an evidence chain**.

LLMs doing financial research have three chronic habits: **making numbers up from memory, doing arithmetic in their head, and casually recommending a position**. Our answer is not a longer prompt but three layers of constraints:

| Layer | Components | Role |
|---|---|---|
| Prompt layer | `AGENTS.md` research constitution + `.agents/skills/` research SOPs | Tells the agent how to work (the five-question gate, fetch-then-interpret stage split, facts vs. inference) |
| Execution layer | Codex native hooks (Stop / PreToolUse) + sandbox | Invalid work is blocked immediately: no finishing a stage without its artifacts; no running fetch scripts, no network, no rewriting evidence |
| Orchestration layer | thin orchestrator + validator + compliance gate | Data fetching is executed by the orchestrator with an in-memory ledger; every number must trace back to evidence and a calc DAG; any "buy / target price" wording triggers a rewrite |

**Prompt compliance is not a process guarantee** — discipline lives in the execution and orchestration layers, not in the model's good will.

The Codex repository is not modified at all (zero fork): we run the officially installed `codex` CLI and the matching TypeScript SDK; upstream upgrades only need re-verification against the version anchor file.

## What it can do

- **One-command research**: `run.ts --symbol 300308` → a six-stage state machine; for each stage, the orchestrator fetches data and the agent interprets it → validator checks (ledger / schema / references / recomputation / semantic slots) → automatic retry on failure → compliance gate → merged artifacts. Outputs: `report.md`, `evidence.json` (every item references its raw source file), `calculations.json` (a DAG for every number), `conflicts.json` (cross-source conflicts), `viewer.html` (self-contained evidence viewer), `manifest.json`.
- **Data pipeline**: `datasources/registry.json` registers 115 zero/low-auth endpoints across 29 layers (CN / US / HK: quotes, three statements, consensus, fund flows, margin trading, chip distribution, announcements, broker reports, macro, exchanges, SEC / FINRA / CBOE, RSS news radar). One generic fetcher pulls any endpoint and stores every raw response; **the fetch layer never derives anything**.
- **Intelligence layers (12–17, mounted automatically by industry tag)**: beyond the company's own filings, three kinds of outside readings — **market voice** (public discussion, treated as a lead, never as fact) · **industry thermometers** (upstream/downstream hard data: Taiwan monthly revenue, GPU rental rates, futures, DRAM spot, each with a cross-run delta) · **export controls and market access** (full-text search of the Federal Register 1260H list, BIS, the FCC Covered List) · **data calendar** (the actual date of the next data point) · **overseas headlines** (demand-side leads) · **hiring signals** (open roles at industry anchor companies) · **chokepoint events** (deterministic classification of announcement titles). Each one carries a **reading guard** that must appear in the same paragraph as the number (a job count is hiring intent, not capacity; a thermometer is an industry reading, not this company's results), and each is **gated by the stock's industry tags** — no tag match means the layer is skipped, which is not a data gap.
- **Deterministic calc library** `calc/`: 18 pure functions for valuation / series / technical indicators / chip distribution, fixture-tested, CLI output carries a deterministic `calculation_id` plus input DAG, recomputable by the validator.
- **Knowledge layer**: every run is archived into the user's private `.local/knowledge/`; the next run recalls it by default (wrapped in an "untrusted data" boundary with freshness checks) and the agent adjudicates old-vs-new conflicts item by item.
- **Visible while it runs**: a full six-stage run takes 15-19 minutes, so progress streams to stderr — the first substantive line (which sources this stage pulled, which failed) lands in about 5 seconds, a complete company profile paragraph in about 2 minutes, then one per stage; a failed validation says it is retrying rather than leaving you guessing. Turn it off with `--progress off`. The stdout JSON contract is untouched.
- **Interfaces**: MCP server (8 tools, pluggable into Codex CLI or any MCP client), local HTTP API with a thin browser page, multi-symbol batch, run-to-run change alerts, data-source health check.
- **Multi-model access**: provider profiles (OpenAI / DeepSeek / Qwen / Zhipu GLM / Kimi) plus a 10-item compatibility matrix harness; API keys are read from environment variables only.

## Quick start

### Prerequisites

| Item | Requirement | Notes |
|---|---|---|
| OS | macOS / Linux (tested on macOS, darwin-arm64) | Windows untested (hook command hashing on Windows is deferred) |
| Node.js | ≥ 22.18 (24 LTS recommended) | TypeScript files run directly with `node xxx.ts`; no build step |
| Python | ≥ 3.10 (tested on 3.12) | fetch scripts and calc; a virtualenv is recommended |
| Codex CLI | 0.149.0 (`npm install -g @openai/codex@0.149.0`) | tested version range in `codex-version.json`; run the tests first on any other version |
| Model access | a ChatGPT subscription (Plus / Pro / Team) **or** an OpenAI API key **or** a Chinese-vendor API key | subscription login needs no key at all |

### Install

```bash
git clone <this-repo> vibe-research-agent && cd vibe-research-agent   # placeholder until the public release; replace with the real URL
# 1) orchestrator dependencies (Codex TS SDK / MCP SDK / ajv / zod)
(cd orchestrator && npm install)
# 2) Python virtualenv + fetch dependencies (requests / pandas / lxml / akshare / baostock)
python3 -m venv .venv && .venv/bin/pip install -r .agents/skills/data-access/scripts/requirements.txt
# 3) Codex CLI (global)
npm install -g @openai/codex@0.149.0 && codex --version
# 4) initialise the product's own private layer .local/ (directories + config skeleton; never touches ~/.codex; safe to re-run)
scripts/init --python "$(pwd)/.venv/bin/python"
# 5) log in to the product's own CODEX_HOME (fully isolated from your ~/.codex; subscription login opens the browser)
CODEX_HOME="$(pwd)/.local/codex-home" codex login
# 6) health check: engine / login state / Python deps / calc / registry / secret scan … (--net also probes one quote endpoint)
scripts/doctor --net
```

To use an OpenAI API key instead of a subscription: skip step 5, `export OPENAI_API_KEY=sk-...`, and add `--auth api_key` at run time (or put `{"provider": {"auth": "api_key"}}` in `.local/config.json`).

### First run

```bash
# full six-stage research (about 8–10 minutes; by default uses every applicable registry endpoint and recalls the knowledge archive)
node orchestrator/src/run.ts --symbol 300308 --market SZ --python "$(pwd)/.venv/bin/python" < /dev/null
# artifacts in .local/runs/<run-id>/ : report.md · viewer.html (open in a browser) · report_appendix.md · manifest.json
```

Exit codes: 0 complete / 2 incomplete or stale / 3 failed. Status semantics are documented in `orchestrator/README.md`. For a first smoke test, `--endpoints core` (the 8 core endpoints only) is faster; then run the full set.

## Usage cheat sheet

| Goal | Command |
|---|---|
| Full research run | `node orchestrator/src/run.ts --symbol 300308 --market SZ --python <venv>/bin/python [--run-id X] [--endpoints full\|core] [--knowledge on\|off] [--provider <id>] [--model M] [--reasoning medium]` |
| Fetch a single endpoint | `<venv>/bin/python .agents/skills/data-access/scripts/fetch_endpoint.py --endpoint em_margin_trading --symbol 300308 --out-dir .local/mcp/try` (catalog: `datasources/CATALOG.md`) |
| Compute one number | `<venv>/bin/python calc/cli.py forward_pe --args '{"price": 100, "eps_forecast": 5}'` (function contracts: `calc/SPEC.md`) |
| Plug into Codex CLI (MCP) | `codex mcp add vibe-research -- node "$(pwd)/orchestrator/src/mcp.ts"` → use list_endpoints / fetch_endpoint / start_research / research_status / get_report / get_evidence / list_runs / knowledge_recall inside Codex |
| Local HTTP API + browser page | `node orchestrator/src/api.ts --port 8765` → open `http://127.0.0.1:8765/login?token=<token>` (token in `.local/api.token`) |
| Multi-symbol batch | `node orchestrator/src/batch.ts --symbols 300308,002463 --market SZ --python <venv>/bin/python` → `.local/batches/<id>/summary.md` |
| Run-to-run change alerts | `node orchestrator/src/alerts.ts --symbol 300308 --market SZ [--base run-a --new run-b]` → `.local/alerts/…` |
| Data-source health check | `<venv>/bin/python datasources/health.py` |
| Init / doctor | `scripts/init [--python P] [--provider <id>] [--force]` / `scripts/doctor [--net] [--json]` (exit 0 all ok / 2 warnings only / 3 failures; report in `.local/doctor/`) |
| Provider compatibility matrix | `node orchestrator/src/finance/provider_matrix.ts --provider deepseek --model deepseek-v4-flash` |

Always append `< /dev/null` when running in the background; otherwise Codex waits on stdin.

## Model access

The default is **ChatGPT subscription login** (the product's own CODEX_HOME; `~/.codex` is never touched). Switching models takes three steps:

```bash
export DEEPSEEK_API_KEY=...                                             # 1) keys live in environment variables only (names in providers/*.json)
node orchestrator/src/finance/provider_matrix.ts --provider deepseek            # 2) run the 10-item compatibility matrix first (results in .local/provider-matrix/)
node orchestrator/src/run.ts --symbol 300308 --provider deepseek --model deepseek-v4-flash --python ...   # 3) use it for research once green
```

Built-in profiles: `openai` / `deepseek` · `mimo` (native Responses API) / `qwen` · `glm` · `kimi` (hosted on Alibaba Cloud Bailian). Or set it in `.local/config.json`: `{"provider": {"profile": "deepseek"}, "defaults": {"model": "deepseek-v4-flash"}}`.

**Responses protocol only.** The engine removed `wire_api="chat"` entirely, so a vendor must expose an OpenAI-compatible `/responses` endpoint — otherwise you need your own Responses→Chat gateway (`responses_support: "gateway"`). The three Bailian templates carry a `{WorkspaceId}` placeholder in `base_url`: copy one to `.local/providers/<id>.json` and fill in your own workspace ID, or selecting it fails immediately. If you do not set `auth`, the template's only supported mode (`api_key`) is chosen automatically; an explicit `--auth` / `VRA_PROVIDER_AUTH` always wins. Third-party templates must declare an explicit https `base_url` (Codex falls back to the official OpenAI endpoint when `base_url` is empty).

OpenAI baseline matrix (subscription login, 2026-08-22): 9 pass · 1 n/a. Matrices for Chinese vendors can only be run with the corresponding API keys; `matrix.status` in each template is filled in from real results. Detailed guide: [docs/model-access.md](docs/model-access.md) (Chinese); template fields and constraints: [providers/README.md](providers/README.md).

## Configuration and environment variables

Precedence (low → high): built-in defaults ← `vibe-research.config.json` (product config, committed, no secrets) ← `.local/config.json` (user-private, gitignored) ← environment variables ← CLI flags.

Example `.local/config.json`:

```json
{ "python": "/abs/path/.venv/bin/python",
  "provider": { "profile": "openai", "auth": "chatgpt_login" },
  "defaults": { "model": null, "reasoning": "medium", "turn_timeout_min": 20 } }
```

| Variable | Purpose |
|---|---|
| `VRA_PYTHON` / `VRA_CODEX_PATH` / `VRA_CODEX_HOME` | Python interpreter / Codex binary (empty = SDK-bundled) / product CODEX_HOME (default `.local/codex-home`) |
| `VRA_PROVIDER` / `VRA_PROVIDER_AUTH` | provider profile id / auth mode (`chatgpt_login` or `api_key`) |
| `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY` (shared by the three Bailian templates) | provider keys (names declared by each template's `env_key`) |
| `VRA_API_TOKEN` | Bearer token for the HTTP API (auto-generated into `.local/api.token` if unset) |
| `VRA_SEC_CONTACT` | contact required by SEC endpoints ("name email", per SEC policy) |
| `IWENCAI_API_KEY` | iwencai (optional) |
| `VRA_ALLOW_INSECURE_TLS=1` | explicit downgrade when the SWS / SZSE certificate chain fails (default: fail, no downgrade) |
| `VRA_REPO_ROOT` | repository root for the MCP server (default: derived from file location) |

**Secrets are read from environment variables only and never written to any config file; the agent's shell commands inherit no secret-like variables.**

## Architecture

```
                 ┌──────────────── prompt layer ───────────────┐
                 │ AGENTS.md constitution + .agents/skills SOPs │
                 └─────────────────────────────────────────────┘
 fetch (orchestrator-executed, in-memory ledger) → agent turn (Codex SDK, sandbox cwd = run dir, no network) → validator → retry → compliance gate → merge
   ▲ fetch_endpoint.py × registry                  ▲ hooks: Stop (no finishing without artifacts) / PreToolUse (no fetch scripts / network / evidence edits)
   │ raw/ stored + sha256                          │ calc/cli.py (deterministic computation, DAG recorded)
 ┌──────────────── execution layer ───────────────┐  ┌─────────── orchestration layer ───────────┐
 │ Codex native hooks + workspace-write sandbox   │  │ orchestrator (TS) + validator + gate       │
 └────────────────────────────────────────────────┘  └────────────────────────────────────────────┘
```

Six stages: `profile → financials → estimates → valuation → risk → report`. At least one Codex turn per stage (if the validator or the Stop hook rejects the result, the stage is retried with the errors attached); the agent reads the orchestrator-fetched `fetch/*.json`, this run's `calcs/` and `conflicts.json`, and the SOP documents in the repository; it can only compute through calc and only writes the current stage's artifacts. The validator does not trust the agent's self-report: every file under `fetch/` and `raw/` must be in the in-memory ledger with a matching sha256, every referenced evidence id must exist, and every required calculation must be present and recomputable.

| Path | Role |
|---|---|
| `AGENTS.md` | research constitution (auto-loaded by Codex) |
| `.agents/skills/` | research SOP skills (`data-access` fetching, `company-research` six-stage SOP, `valuation`, `earnings-analysis`, `industry-chain`, `catalyst-risk`; the real project-level skill discovery path of Codex) |
| `datasources/` | endpoint registry `registry.json` + generated `CATALOG.md` + `health.py` + RSS source table |
| `calc/` | deterministic calc library (pure functions + fixture tests + CLI) |
| `orchestrator/` | thin orchestrator / validator / gate / hooks / knowledge layer / viewer / service / MCP / HTTP API / batch / alerts / providers / matrix (see `orchestrator/README.md`) |
| `providers/` | provider templates (environment-variable names only) |
| `knowledge/` | knowledge-layer **templates** (user archives always live in `.local/knowledge/`) |
| `scripts/` | `init` (idempotent `.local/` setup) / `doctor` (health check) |
| `docs/` | model access guide and other docs |
| `.local/` | user-private layer: config / run artifacts / knowledge archives / login state / tokens (gitignored) |
| `codex-version.json` | tested Codex version anchor |

## Data sources

115 endpoints / 29 layers / CN + US + HK, each tagged with a compliance level (`cn-public` domestic public web APIs · `S` official government data · `B` unofficial / personal research · `C` personal research only · `rss-public` public RSS). Principles: units and currencies are stated by the mapper exactly as the source reports them; every evidence item is bound to its raw response; **the fetch layer never sums, divides or derives** (derived quantities always go through calc with a DAG); cross-source conflicts are reported explicitly, never silently resolved. Catalog: [datasources/CATALOG.md](datasources/CATALOG.md). Adding an endpoint = source function + mapper + registry entry + regenerate the catalog + offline test.

Some sources have local limitations (Eastmoney push2 occasionally resets — multiple hosts are tried; Baidu K-line returns 403 server-side; SWS xls certificate chain; mootdx occasionally unreachable; SEC requires `VRA_SEC_CONTACT`); `health.py` reports them faithfully.

## Security and privacy

- **Product / user data separation**: positions, keys and personal research conclusions never enter the repository; all private data lives in `.local/` (gitignored).
- **Secrets via environment variables only**; provider templates hold variable names; the Codex thread's shell environment policy excludes `*KEY* / *SECRET* / *TOKEN* / *PASSWORD*`; event logs and matrix artifacts are redacted before being written.
- **Isolated CODEX_HOME**: the product never reads or writes the user's `~/.codex`; wiring the MCP server into the user's own CODEX_HOME is the user's decision.
- **Sandbox**: the agent's cwd is locked to the run directory (workspace-write), no network access, approval never; fetching is executed by the orchestrator in a minimal environment.
- **Local API**: binds 127.0.0.1 by default (an explicit non-loopback `--host` requires `VRA_API_TOKEN` and disables cookie login; loopback = 127.0.0.1 / localhost / ::1); every request is authenticated: a Bearer token works on every route, and on loopback binds `/login?token=` exchanges the query-string token for a cookie that can only pass an allow-list of read-only GET routes; rejects cross-site / non-local Origin / non-JSON POST; every path goes through `safePath()` (no symlinks, must stay inside `.local`).
- **Output red line**: data / frameworks / probabilities / decision points only — no opening, adding to or reducing a position, no target prices, no stop losses; enforced by schema isolation plus a compliance gate.

## Development and tests

```bash
.venv/bin/pip install pytest                                               # Python test dependency (the fetch requirements do not include pytest)
(cd orchestrator && npm run typecheck && npm test)                       # TypeScript: 94 node:test cases
.venv/bin/python -m pytest calc/tests -q                                   # calc: 128 tests
.venv/bin/python -m pytest .agents/skills/data-access/scripts/tests -q    # fetch-layer offline tests
.venv/bin/python datasources/gen_catalog.py                                # regenerate CATALOG.md after editing the registry
```

Working convention: after every step → independent Codex review (`codex review` / a `codex exec` review prompt) → verify each finding (they do misreport) → fix → re-review until no substantive issue remains → only then merge; the audit always precedes the push.

## Status and roadmap

**Done (2026-08-22)**: Phase 0, all seven steps (orchestrator v0.4 + validator + gate + hooks v0 + hard-test harness) and Phase 1 M1 (full data-source integration) / M2 (knowledge layer · viewer · extension data in stages · technical indicators and chip distribution moved into calc) / M3 (service · MCP · HTTP API · batch · alerts) / M4 (provider templates · compatibility matrix · thin UI) / `scripts/init` · `scripts/doctor`, each closed through multiple rounds of independent Codex review.

**To do**: real matrix runs for Chinese vendors (needs their API keys) and template back-fill; Windows hook hashing; a self-built Responses↔Chat adapter (separate sub-project); formal release (license decision + tag + Release; maintainer to-dos and release order in [docs/release-checklist.md](docs/release-checklist.md), Chinese).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Disclaimer

This project produces research data, analytical frameworks, scenario probabilities and decision points only. **It does not provide any investment action advice** (opening, adding to or reducing a position, target prices, stop losses). Nothing here constitutes investment advice; data comes from third-party public interfaces and may be delayed or wrong — verify it yourself and take responsibility for your own decisions. Respect the terms of use of each data source (some endpoints are for personal research only).

## Support

<p align="center">
  <a href="https://buymeacoffee.com/simonlin1212"><img src="./assets/bmc-qr.png" width="180" alt="Buy Me a Coffee"></a>
</p>

## License

License to be decided by the maintainer (the openai/codex engine is Apache-2.0; this repository contains no Codex source). A `LICENSE` file and badge will be added before release.

**Author:** Simon Lin · X [@linsizhen](https://x.com/linsizhen) · Email: [simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)
