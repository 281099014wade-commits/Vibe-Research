import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_PRODUCT_CONFIG, PRODUCT_CONFIG_FILE, loadProductConfig } from "../src/productConfig.ts";
import { configFromArgs } from "../src/run.ts";

function tmpRepo(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "vra-pc-")); }

test("产品配置:无文件 → 内置默认;相对路径相对产品根解析", () => {
  const repo = tmpRepo();
  const pc = loadProductConfig(repo, { env: {} });
  assert.deepEqual(pc.sources, ["builtin"]);
  assert.equal(pc.resolved.codexHome, path.join(repo, ".local", "codex-home"));
  assert.equal(pc.resolved.dataRoot, path.join(repo, ".local"));
  assert.equal(pc.resolved.constitution, path.join(repo, "AGENTS.md"));
  assert.equal(pc.resolved.scriptsRel, path.join(".agents", "skills", "data-access", "scripts"));
  assert.equal(pc.resolved.codexPath, null);
  assert.equal(pc.provider.auth, DEFAULT_PRODUCT_CONFIG.provider.auth);
});

test("产品配置:产品文件 ← 用户文件 ← 环境变量 逐层覆盖;schema 校验拒绝未知字段与非法值", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ engine: { codex_home: "home-p" }, defaults: { max_retries: 1 }, paths: { data_root: "data" } }));
  fs.mkdirSync(path.join(repo, "data"), { recursive: true });
  // Phase 0 只接受 OpenAI 原生 provider:国产 provider 显式报错,不静默忽略
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { name: "deepseek", auth: "api_key", env_key: "DEEPSEEK_API_KEY", base_url: "http://127.0.0.1:8787/v1" } }));
  assert.throws(() => loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "x" } }), /provider 必须指定 profile|未知 provider/);  // M4:非 openai 必须经 providers/<id>.json 模板
  // OpenAI 原生 + api_key:env 缺失 → 报错;env 在 → 通过
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { auth: "api_key" }, python: "/v/bin/python" }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /OPENAI_API_KEY 未设置/);
  let pc = loadProductConfig(repo, { env: { OPENAI_API_KEY: "sk-x" } });
  assert.equal(pc.resolved.codexHome, path.join(repo, "home-p"));
  assert.equal(pc.resolved.dataRoot, path.join(repo, "data"));
  assert.equal(pc.defaults.max_retries, 1);
  assert.equal(pc.provider.auth, "api_key");
  assert.equal(pc.provider.wire_api, "responses"); // 未覆盖的字段保留默认
  assert.equal(pc.python, "/v/bin/python");
  // 用户层不得改 data_root
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ paths: { data_root: "elsewhere" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /不得修改 paths.data_root/);
  // env_key 黑名单 / base_url 形态
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { env_key: "PATH" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { base_url: "not a url" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ paths: { constitution: "docs/MY.md" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /必须是 "AGENTS.md"/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), "{}");
  pc = loadProductConfig(repo, { env: { VRA_CODEX_PATH: "bin/codex-engine", VRA_CODEX_HOME: "/abs/home" } });
  assert.equal(pc.resolved.codexPath, path.join(repo, "bin", "codex-engine"));
  assert.equal(pc.resolved.codexHome, "/abs/home");
  assert.ok(pc.sources.includes("env"));
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { api_key: "sk-secret" } })); // 密钥不允许进配置文件(未知字段)
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { auth: "magic" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), "{oops");
  assert.throws(() => loadProductConfig(repo, { env: {} }), /JSON/);
});

test("configFromArgs:产品配置进入 RunConfig;CLI 覆盖配置文件", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ engine: { codex_path: "engine/bin/codex-engine", codex_home: "home" }, defaults: { turn_timeout_min: 7, gate_retries: 1 } }));
  let { cfg, sources } = configFromArgs({ symbol: "300308", "repo-root": repo }, {});
  assert.equal(cfg.codexPath, path.join(repo, "engine", "bin", "codex-engine"));
  assert.equal(cfg.codexHome, path.join(repo, "home"));
  assert.equal(cfg.turnTimeoutMs, 7 * 60_000);
  assert.equal(cfg.gateRetries, 1);
  assert.equal(cfg.runDir, path.join(repo, ".local", "runs", cfg.runId));
  assert.ok(sources.some((s) => s.endsWith(PRODUCT_CONFIG_FILE)));
  ({ cfg } = configFromArgs({ symbol: "300308", "repo-root": repo, "codex-path": "/x/codex", "codex-home": "/x/home", "turn-timeout-min": "3" }, {}));
  assert.equal(cfg.codexPath, "/x/codex");
  assert.equal(cfg.codexHome, "/x/home");
  assert.equal(cfg.turnTimeoutMs, 3 * 60_000);
});
