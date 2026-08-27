import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = path.join(REPO, "desktop", "src", "verticals", "finance", "lib");

/**
 * 「用户在界面上选的模型，到底有没有接到请求上」这一条的棘轮。
 *
 * 🔴 起因是一次实测：`backend.chat` 的 `llm` 参数原本要调用方自己传，
 *    三个入口里有两个（Agent 面板 `FinanceAiDock`、`agents.ts`）忘了传 ——
 *    对话照常成功、照常有答案，只是出自后端默认那家，**界面上一个字都看不出来**。
 *    这类失效没有任何人会报错，所以只能用棘轮钉住。
 */

const read = (f: string): string => fs.readFileSync(path.join(LIB, f), "utf8");

test("🔴 前提：这几个文件确实在 —— 改名 / 搬走时不许静默变成空查", () => {
  for (const f of ["backend.ts", "llm.ts", "llmStore.ts", "ai-models.ts"]) {
    assert.ok(fs.existsSync(path.join(LIB, f)), `${f} 不在了，下面几条就查不到东西`);
  }
});

test("🔴 传输层自己带上用户配置 —— 不靠每个调用方记得传", () => {
  const src = read("backend.ts");
  assert.ok(/import \{[^}]*readUserLlm[^}]*\} from "\.\/llmStore"/.test(src), "backend.ts 必须自己去读用户配置");
  // 取 chat 这一段来看，别拿整份文件做判断（别处出现同名字样会造成假绿）
  const seg = /chat:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n  \},/.exec(src);
  assert.ok(seg, "没解析到 backend.chat 的实现，断言等于没做");
  const body = seg[1]!;
  assert.ok(/readUserLlm\(\)/.test(body), "chat 里必须在调用方没给时去读用户配置");
  // 🔴 坏了 / 读不到时**不许当没配**回落到后端默认 —— 那正是"悄悄换一家去打"的形状
  assert.ok(/"broken"/.test(body) && /"unavailable"/.test(body), "chat 必须把「坏了」「读不到」与「没配」分开处理");
  assert.ok(/throw new ApiError/.test(body), "坏了 / 读不到要报出来，不能静默回落");
  // 🔴 带不带 llm 按 `!== undefined` 判，不按真值判：真值判会把显式的 null / "" 悄悄丢掉，
  //    后端的形状校验就压根不会执行 —— 后端刚堵上的那条后门，在这个兄弟编译点上又开了。
  assert.ok(/use !== undefined \? \{ llm: use \}/.test(body), "带不带 llm 必须按 !== undefined 判");
  assert.ok(!/\.\.\.\(use \? \{ llm/.test(body), "不许用真值判 —— 显式 null 会被静默丢掉");
});

test("🔴 「已实测」不许拿「目录里有这个文件」当判据", () => {
  const s = read("../pages/Settings.tsx");
  // 6 份模板里只有 2 份真跑过（openai=baseline、mimo=partial），其余是 untested。
  // 按文件存在来标，界面上会出现 4 条假的「已实测」。
  // ⚠️ 断言要钉**下拉项那一行本身**：只查"文件里有没有 matrixOf"是假绿 ——
  //    别处留着它、而标签改回按有无模板算，照样全绿（变异测试实测过）。
  const opt = /<option key=\{m\.id\}[\s\S]*?<\/option>/.exec(s);
  assert.ok(opt, "没解析到模型下拉项，断言等于没做");
  assert.ok(/\{tag\(m\.provider\)\}/.test(opt[0]), `下拉项的标签必须来自矩阵状态：${opt[0]}`);
  assert.ok(!/已实测/.test(opt[0]), "标签文案该由 tag() 决定，别在这一行写死");

  // tag() 自己的口径：跑过的三种才叫已实测，其余如实说「未实测」
  const fn = /const tag = [\s\S]*?\n  \};/.exec(s);
  assert.ok(fn, "没解析到 tag()，断言等于没做");
  assert.ok(/未实测/.test(fn[0]), "没跑过矩阵的要如实标出来");
  assert.ok(/RAN\.has\(st\)/.test(fn[0]), "已实测要按矩阵状态白名单判");
  assert.ok(/"baseline"[\s\S]{0,40}"pass"[\s\S]{0,40}"partial"/.test(s), "跑过的状态白名单应为 baseline / pass / partial");
});

test("🔴 存取只有一处实现 —— 抄第二份迟早两边判定不一致", () => {
  assert.ok(/localStorage\.getItem\(LLM_KEY\)/.test(read("llmStore.ts")), "llmStore 才是读的地方");
  for (const f of ["llm.ts", "backend.ts"]) {
    assert.ok(
      !/localStorage\.(getItem|setItem)\(\s*["'`]vr-llm/.test(read(f)),
      `${f} 里不许直接碰 vr-llm，一律走 llmStore`,
    );
  }
});

test("🔴 订阅档不许摆一个假模型名 —— 模型由登录态决定", () => {
  const cli = read("ai-models.ts").split("\n").filter((l) => /provider:\s*"cli-/.test(l));
  assert.ok(cli.length >= 2, `没找到订阅档条目（找到 ${cli.length} 行）`);
  for (const line of cli) {
    const id = /id:\s*"([^"]+)"/.exec(line)?.[1] ?? "";
    // 实测撞过：写 "gpt-5.6-codex" 发出去，收到的是
    // "The 'gpt-5.6-codex' model is not supported when using Codex with a ChatGPT account"
    assert.ok(!/^gpt-|^claude-\d|^o\d/.test(id), `订阅档 id "${id}" 长得像模型名，会让人以为它是真模型`);
  }
});

test("🔴 前端「这份配置能不能用」的口径必须与后端一致 —— 各判一半就会分岔", async () => {
  const { resolveRuntimeProvider } = await import("../src/runtime_provider.ts");
  const REPO_ROOT = path.resolve(LIB, "..", "..", "..", "..", "..");
  const DATA = path.join(REPO_ROOT, ".local");

  // 把 llmStore 的判定抄成一份可执行的镜像 —— 抄错了下面的对照会当场炸
  const src = read("llmStore.ts");
  const fn = /function isUsable\(c: LlmConfig\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, "没解析到 isUsable()，断言等于没做");
  const isUsable = new Function("c", `const isCli=(p)=>p.startsWith("cli-");${fn[1]!.replace(/Boolean\(/g, "Boolean(")}`) as (c: unknown) => boolean;

  const cases = [
    { provider: "cli-codex", baseURL: "", apiKey: "", model: "" },            // 订阅档免 key、模型由登录态定
    { provider: "cli-codex", baseURL: "", apiKey: "", model: "codex" },
    { provider: "deepseek", baseURL: "", apiKey: "k", model: "" },            // 模板给 baseURL 与默认模型
    { provider: "deepseek", baseURL: "", apiKey: "", model: "m" },            // 缺 key
    { provider: "custom", baseURL: "https://g.example.com/v1", apiKey: "k", model: "" },
    { provider: "custom", baseURL: "", apiKey: "k", model: "m" },             // 自填端点缺 baseURL
    { provider: "", baseURL: "https://g.example.com/v1", apiKey: "k", model: "m" },
  ];
  for (const c of cases) {
    const front = isUsable(c);
    let back = true;
    try { resolveRuntimeProvider(REPO_ROOT, DATA, c, {}); } catch { back = false; }
    // 前端严 ⇒ 能用的配置被判「坏了」；前端松 ⇒ 界面说"已配置"、一提问才报错。两种都是分岔。
    assert.equal(front, back, `口径不一致:${JSON.stringify(c)} 前端=${front} 后端=${back}`);
  }
});
