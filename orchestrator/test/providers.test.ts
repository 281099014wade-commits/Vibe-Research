import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { codexEnvFor, makeConfig } from "../src/config.ts";
import { loadProductConfig } from "../src/productConfig.ts";
import { assertAuth, codexProviderConfig, listProviderIds, loadProviderProfile, providerEnv, validateProfile } from "../src/providers.ts";
import { codexOptionsFor } from "../src/runner.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:垂类包要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("providers:产品模板全部可加载且通过 schema;openai 为 responses 原生;国产模板 chat + api_key + requires_openai_auth=false;不含密钥", () => {
  const ids = listProviderIds(REPO, path.join(REPO, ".local"));
  assert.ok(ids.includes("openai") && ids.includes("deepseek") && ids.includes("qwen") && ids.includes("glm") && ids.includes("kimi"), ids.join(","));
  for (const id of ids) {
    const { profile } = loadProviderProfile(REPO, path.join(REPO, ".local"), id);
    assert.equal(profile.id, id);
    const raw = fs.readFileSync(path.join(REPO, "providers", `${id}.json`), "utf8");
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw) && !/Bearer\s+\S{8,}/.test(raw), `${id} 模板含密钥样式`);
    if (id === "openai") { assert.equal(profile.wire_api, "responses"); assert.equal(profile.base_url, null); assert.ok(profile.auth_modes.includes("chatgpt_login")); }
    else { assert.equal(profile.wire_api, "chat"); assert.equal(profile.requires_openai_auth, false); assert.deepEqual(profile.auth_modes, ["api_key"]); assert.ok(profile.base_url!.startsWith("https://")); }
  }
  assert.throws(() => loadProviderProfile(REPO, path.join(REPO, ".local"), "nope"), /未知 provider/);
  assert.throws(() => loadProviderProfile(REPO, path.join(REPO, ".local"), "../x"), /非法 provider id/);
});

test("providers:validateProfile 拒绝密钥值 / 非 openai requires_openai_auth / openai 自定义 base_url / 非法 env_key", () => {
  const base = { id: "x", name: "X", wire_api: "chat", base_url: "https://x.example/v1", env_key: "X_API_KEY", auth_modes: ["api_key"], requires_openai_auth: false, default_model: "m", responses_support: "none" };
  assert.equal(validateProfile(base, "t").id, "x");
  assert.throws(() => validateProfile({ ...base, http_headers: { Authorization: "Bearer sk-abcdefghijklmnop" } }, "t"), /密钥/);
  assert.throws(() => validateProfile({ ...base, query_params: { api_key: "0123456789abcdef" } }, "t"), /密钥/);
  assert.throws(() => validateProfile({ ...base, requires_openai_auth: true }, "t"), /requires_openai_auth/);
  assert.throws(() => validateProfile({ ...base, id: "openai", wire_api: "responses" }, "t"), /base_url 必须为 null/);
  assert.throws(() => validateProfile({ ...base, env_key: "PATH" }, "t"), /schema/);
  assert.throws(() => validateProfile({ ...base, base_url: "http://insecure" }, "t"), /schema/);
  assert.throws(() => validateProfile({ ...base, extra: 1 }, "t"), /schema/);
});

test("providers:Codex 配置映射与环境注入(密钥只按 env_key 名透传;openai 另加 CODEX_API_KEY;chatgpt_login 不注入)", () => {
  const ds = loadProviderProfile(REPO, path.join(REPO, ".local"), "deepseek").profile;
  const cfg = codexProviderConfig(ds) as { model_provider: string; model_providers: Record<string, Record<string, unknown>> };
  assert.equal(cfg.model_provider, "deepseek");
  assert.deepEqual(cfg.model_providers.deepseek, { name: ds.name, base_url: "https://api.deepseek.com/v1", env_key: "DEEPSEEK_API_KEY", wire_api: "chat", requires_openai_auth: false });
  assert.deepEqual(codexProviderConfig(loadProviderProfile(REPO, path.join(REPO, ".local"), "openai").profile), {});
  assert.deepEqual(providerEnv(ds, "api_key", { DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2", OTHER_TOKEN: "x" }), { DEEPSEEK_API_KEY: "k1" });
  assert.throws(() => providerEnv(ds, "api_key", {}), /DEEPSEEK_API_KEY/);
  assert.throws(() => providerEnv(ds, "chatgpt_login", {}), /不支持 chatgpt_login/);
  assert.throws(() => providerEnv(ds, "typo" as never, { DEEPSEEK_API_KEY: "k" }), /只能是 chatgpt_login 或 api_key/, "乱值不得静默落入登录分支");
  assert.equal(assertAuth("api_key", "x"), "api_key"); assert.throws(() => assertAuth("basic", "--auth"), /--auth 只能是/);
  const oa = loadProviderProfile(REPO, path.join(REPO, ".local"), "openai").profile;
  assert.deepEqual(providerEnv(oa, "api_key", { OPENAI_API_KEY: "k" }), { OPENAI_API_KEY: "k", CODEX_API_KEY: "k" });
  assert.deepEqual(providerEnv(oa, "chatgpt_login", { OPENAI_API_KEY: "k" }), {});
});

test("productConfig:profile=deepseek + 环境变量 → provider 字段由模板决定;缺变量 / 未知 profile / 不支持的 auth → 报错;CLI --provider 覆盖;openai 默认不变", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-pc-"));
  fs.mkdirSync(path.join(repo, ".local"), { recursive: true });
  fs.cpSync(path.join(REPO, "providers"), path.join(repo, "providers"), { recursive: true });
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "#\n");
  const a = loadProductConfig(repo, { env: {} });
  assert.equal(a.provider.name, "openai"); assert.equal(a.providerProfile?.id, "openai"); assert.equal(a.provider.auth, "chatgpt_login");
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { profile: "deepseek", auth: "api_key" }, defaults: { model: "deepseek-chat" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /DEEPSEEK_API_KEY/);
  const b = loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "k" } });
  assert.equal(b.provider.name, "deepseek"); assert.equal(b.provider.wire_api, "chat"); assert.equal(b.provider.base_url, "https://api.deepseek.com/v1"); assert.equal(b.provider.env_key, "DEEPSEEK_API_KEY"); assert.equal(b.providerProfile?.id, "deepseek");
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { profile: "deepseek", auth: "chatgpt_login" } }));
  assert.throws(() => loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "k" } }), /不支持 auth=chatgpt_login/);
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { profile: "nope", auth: "api_key" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /未知 provider/);
  fs.rmSync(path.join(repo, ".local", "config.json"));
  // CLI / 环境变量切换 profile 且 auth 未显式写过 → 自动用模板唯一支持的 api_key(缺密钥仍报错);显式写了 chatgpt_login 则明确报错,不覆盖用户设置
  const k1 = loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k" }, providerOverride: "kimi" });
  assert.equal(k1.provider.name, "kimi"); assert.equal(k1.provider.auth, "api_key"); assert.equal(k1.provider.env_key, "MOONSHOT_API_KEY"); assert.ok(k1.sources.includes("cli"));
  assert.equal(loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k", VRA_PROVIDER: "kimi" } }).provider.auth, "api_key");
  assert.throws(() => loadProductConfig(repo, { env: {}, providerOverride: "kimi" }), /MOONSHOT_API_KEY/);
  assert.throws(() => loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k", VRA_PROVIDER: "kimi", VRA_PROVIDER_AUTH: "chatgpt_login" } }), /不支持 auth=chatgpt_login/);
  assert.throws(() => loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k" }, providerOverride: "kimi", authOverride: "chatgpt_login" }), /不支持 auth=chatgpt_login/);
  assert.throws(() => loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k" }, providerOverride: "kimi", authOverride: "basic" }), /--auth 只能是/);
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { auth: "chatgpt_login" } }));
  assert.throws(() => loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k" }, providerOverride: "kimi" }), /不支持 auth=chatgpt_login/, "用户显式写的 auth 不被覆盖");
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({ provider: { auth: "api_key" } }));
  const c = loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k" }, providerOverride: "kimi" });
  assert.equal(c.provider.name, "kimi"); assert.equal(c.provider.env_key, "MOONSHOT_API_KEY"); assert.ok(c.sources.includes("cli"));
  // 产品配置(vibe-research.config.json)写了 auth 只是产品默认,不算用户显式 → 切第三方仍自动选 api_key
  fs.rmSync(path.join(repo, ".local", "config.json"));
  fs.writeFileSync(path.join(repo, "vibe-research.config.json"), JSON.stringify({ provider: { auth: "chatgpt_login" } }));
  assert.equal(loadProductConfig(repo, { env: { MOONSHOT_API_KEY: "k" }, providerOverride: "kimi" }).provider.auth, "api_key");
  fs.rmSync(path.join(repo, "vibe-research.config.json"));
  // 环境变量层整体生效:VRA_PROVIDER 与 VRA_CODEX_HOME / VRA_CODEX_PATH / VRA_PYTHON 同时存在时一个都不丢
  const e = loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "k", VRA_PROVIDER: "deepseek", VRA_CODEX_HOME: "/tmp/ch", VRA_CODEX_PATH: "/tmp/codex-bin", VRA_PYTHON: "/tmp/py" } });
  assert.equal(e.provider.name, "deepseek"); assert.equal(e.engine.codex_home, "/tmp/ch"); assert.equal(e.engine.codex_path, "/tmp/codex-bin"); assert.equal(e.python, "/tmp/py");
  // 无 providers/ 目录的假仓库:openai 走内置模板
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bare-"));
  assert.equal(loadProductConfig(bare, { env: {} }).providerProfile?.id, "openai");
});

test("runner/config:非 openai provider 注入 model_provider + model_providers;codexEnvFor 透传 env_key;默认模型来自模板;openai 不注入", () => {
  const ds = loadProviderProfile(REPO, path.join(REPO, ".local"), "deepseek").profile;
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, runId: "t-prov", provider: { name: "deepseek", wire_api: "chat", base_url: ds.base_url, env_key: ds.env_key, auth: "api_key", profile: "deepseek" }, providerProfile: ds });
  const env = { PATH: "/bin", DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2" };
  const opts = codexOptionsFor(cfg, env) as { config: Record<string, unknown>; env: Record<string, string> };
  assert.equal(opts.config.model_provider, "deepseek");
  assert.ok((opts.config.model_providers as Record<string, unknown>).deepseek);
  assert.ok(opts.config.shell_environment_policy, "工具环境策略仍在");
  assert.equal(opts.env.DEEPSEEK_API_KEY, "k1"); assert.equal(opts.env.CODEX_API_KEY, undefined); assert.equal(opts.env.OPENAI_API_KEY, undefined); assert.equal(opts.env.CODEX_HOME, cfg.codexHome);
  const oa = makeConfig({ symbol: "300308", repoRoot: REPO, runId: "t-prov2" });
  const o2 = codexOptionsFor(oa, env) as { config: Record<string, unknown>; env: Record<string, string> };
  assert.equal(o2.config.model_provider, undefined); assert.equal(o2.env.DEEPSEEK_API_KEY, undefined);
  assert.deepEqual(Object.keys(codexEnvFor(cfg, env)).filter((k) => k.includes("KEY")), ["DEEPSEEK_API_KEY"]);
});

test("providers:组合约束——第三方 base_url 不得为空(Codex 会回退到 api.openai.com)/ 第三方不得声明 chatgpt_login / responses_support 与 wire_api 自洽 / auth_modes 去重 / context_limit ≥1", () => {
  const base = loadProviderProfile(REPO, path.join(REPO, ".local"), "deepseek").profile;
  const v = (patch: Record<string, unknown>) => () => validateProfile({ ...base, ...patch }, "t");
  assert.doesNotThrow(v({}));
  assert.throws(v({ base_url: null }), /必须显式给出 https base_url/);
  assert.throws(v({ auth_modes: ["api_key", "chatgpt_login"] }), /只能 auth_modes=\["api_key"\]/);
  assert.throws(v({ auth_modes: ["api_key", "api_key"] }), /schema/);
  assert.throws(v({ responses_support: "native" }), /responses_support=native 要求 wire_api=responses/);
  assert.throws(v({ wire_api: "responses", responses_support: "none" }), /wire_api=responses 要求 responses_support=native\|gateway/);
  assert.throws(v({ context_limit_tokens: 0 }), /schema/);
  assert.doesNotThrow(v({ verified_at: "2026-08-22" }));
  assert.throws(v({ verified_at: "yesterday" }), /schema/);
  assert.throws(v({ env_http_headers: { "X-Home": "HOME" } }), /schema|受保护环境变量/);
  assert.doesNotThrow(v({ wire_api: "responses", responses_support: "gateway" }), "responses 经网关转换是合法组合");
});

test("providers:providers 目录是符号链接 / 解析到根之外 → 拒绝(即使 id 合法)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-plink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-outside-"));
  fs.cpSync(path.join(REPO, "providers"), outside, { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "providers"));
  assert.throws(() => loadProviderProfile(repo, path.join(repo, ".local"), "deepseek"), /符号链接|根目录之外/);
  // 用户目录 .local/providers 同样受限
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "vra-plink2-"));
  fs.mkdirSync(path.join(repo2, ".local"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo2, ".local", "providers"));
  assert.throws(() => loadProviderProfile(repo2, path.join(repo2, ".local"), "deepseek"), /符号链接|根目录之外/);
  // 正常目录照常
  fs.cpSync(path.join(REPO, "providers"), path.join(repo2, "providers"), { recursive: true });
  fs.rmSync(path.join(repo2, ".local", "providers"));
  assert.equal(loadProviderProfile(repo2, path.join(repo2, ".local"), "deepseek").profile.id, "deepseek");
  // 枚举也不穿过符号链接目录:repo 的 providers 是 symlink → 列表为空;未知 id 的报错只列 openai
  assert.deepEqual(listProviderIds(repo, path.join(repo, ".local")), []);
  assert.throws(() => loadProviderProfile(repo, path.join(repo, ".local"), "nope"), /可用:openai$/);
});
