import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyIndustryGate, detectIndustryTags, industryPromptBlock, keywordHit, loadIndustryTags, writeIndustryFile } from "../src/industry.ts";
import { judgeIndustryThermometer } from "../src/hardtest.ts";
import { loadRegistry } from "../src/registry.ts";
import { EXTRA_TOPICS } from "../src/schemas.ts";
import { writeJson } from "../src/fsutil.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeRun(profileTexts: string[], swCodes: string[], boards: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-"));
  fs.mkdirSync(path.join(d, "fetch"));
  writeJson(path.join(d, "fetch", "fetch_profile.json"), { evidence: profileTexts.map((v, i) => ({ id: `ev-p${i}`, field: i === 0 ? "industry_em" : "industry_csrc", value: v })) });
  writeJson(path.join(d, "fetch", "sw_industry.json"), { evidence: swCodes.map((v, i) => ({ id: `ev-s${i}`, field: i === 0 ? "sw_industry_code" : "sw_l2_code", value: v })) });
  writeJson(path.join(d, "fetch", "em_concept_blocks.json"), { evidence: boards.map((v, i) => ({ id: `ev-b${i}`, field: "board_membership", value: v })) });
  return d;
}

test("产业标签表可加载,ai_compute 的温度计端点在注册表里且带 industry_tags", () => {
  const table = loadIndustryTags(repoRoot)!;
  assert.ok(table && table.tags.ai_compute);
  const reg = loadRegistry(repoRoot)!;
  const byId = new Map(reg.endpoints.map((e) => [e.id, e]));
  for (const id of table.tags.ai_compute.thermometers) {
    const e = byId.get(id)!;
    assert.ok(e, id); assert.deepEqual(e.industry_tags, ["ai_compute"]); assert.equal(e.layer, "13 产业温度计");
  }
  assert.ok(EXTRA_TOPICS.risk.includes("产业温度计"));
});

test("产业判定:中际旭创式(通信设备 + 申万 7302 + 光模块概念)命中 ai_compute;银行命中 0 标签;门控只跳过带标签的端点", () => {
  const table = loadIndustryTags(repoRoot)!;
  const hit = fakeRun(["通信设备", "C39计算机、通信和其他电子设备制造业"], ["730204", "730200"], ["通信设备", "光模块", "山东板块", "HS300_"]);
  const det = detectIndustryTags(hit, table);
  assert.deepEqual(det.tags, ["ai_compute"]);
  assert.ok(det.matched.ai_compute.some((x) => x.startsWith("sw:7302")) && det.matched.ai_compute.some((x) => x.startsWith("光模块←")));
  const miss = fakeRun(["银行", "J66货币金融服务"], ["480000", "480100"], ["银行", "HS300_", "融资融券"]);
  const det2 = detectIndustryTags(miss, table);
  assert.deepEqual(det2.tags, []);
  const endpoints = { tw_monthly_revenue: { industry_tags: ["ai_compute"] }, gpu_rent_thermometer: { industry_tags: ["ai_compute"] }, exa_market_voice: {} , em_margin_trading: {} };
  const g1 = applyIndustryGate(["exa_market_voice", "tw_monthly_revenue", "gpu_rent_thermometer", "em_margin_trading"], endpoints, det.tags);
  assert.deepEqual(g1.included, ["exa_market_voice", "tw_monthly_revenue", "gpu_rent_thermometer", "em_margin_trading"]);
  const g2 = applyIndustryGate(["exa_market_voice", "tw_monthly_revenue", "gpu_rent_thermometer", "em_margin_trading"], endpoints, det2.tags);
  assert.deepEqual(g2.included, ["exa_market_voice", "em_margin_trading"]);
  assert.deepEqual(g2.skipped.map((s) => s.id), ["tw_monthly_revenue", "gpu_rent_thermometer"]);
  // 落盘 + 提示词块
  const f = writeIndustryFile(hit, table, det, g1);
  assert.ok(fs.existsSync(path.join(hit, "fetch", "_industry.json")) && f.guards.ai_compute.includes("折旧参考线"));
  const block = industryPromptBlock(hit);
  assert.ok(block.includes("ai_compute") && block.includes("tw_monthly_revenue / gpu_rent_thermometer") && block.includes("护栏句必须与数字同段出现"));
  writeIndustryFile(miss, table, det2, g2);
  assert.equal(industryPromptBlock(miss), "", "无标签 → 提示词不注入温度计块");
});

test("空运行目录(profile 还没拉)→ 0 信号 0 标签,不抛", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-empty-"));
  const det = detectIndustryTags(d, loadIndustryTags(repoRoot)!);
  assert.deepEqual(det, { tags: [], matched: {}, signals: 0 });
});

test("industry-r1:弱关键词单独不挂载(通信设备 / IDC 无申万前缀 → 0 标签),弱词 + 申万前缀 → 挂载,ASCII 缩写按词边界", () => {
  const table = loadIndustryTags(repoRoot)!;
  const weakOnly = fakeRun(["通信设备", "C39计算机、通信和其他电子设备制造业"], ["270500", "270000"], ["通信设备", "IDC概念", "HS300_"]);
  assert.deepEqual(detectIndustryTags(weakOnly, table).tags, [], "宽泛行业词单独不挂整套算力温度计");
  const weakPlusSw = fakeRun(["通信设备"], ["730202", "730200"], ["通信设备"]);
  assert.deepEqual(detectIndustryTags(weakPlusSw, table).tags, ["ai_compute"]);
  const strongOnly = fakeRun(["电子", "C39"], ["270400"], ["CPO概念", "HS300_"]);
  assert.deepEqual(detectIndustryTags(strongOnly, table).tags, ["ai_compute"]);
  assert.ok(keywordHit("CPO概念", "CPO") && keywordHit("gpu 算力租赁", "GPU") && !keywordHit("GPUS Inc", "GPU") && !keywordHit("XGPU", "GPU") && keywordHit("光模块龙头", "光模块"));
});

test("industry-r1:带 industry_tags 的端点必须 optional(注册表校验)", () => {
  const reg = loadRegistry(repoRoot)!;
  for (const e of reg.endpoints) if (e.industry_tags?.length) assert.ok(!Object.values(e.stages ?? {}).includes("required"), e.id);
});

test("industry-r1:判定函数——数字行不引温度计 id 即未绑定(不回退全池);引台系 id 的行缺差分护栏 / 引 GPU id 的行缺折旧线护栏都判失败", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-judge-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const ev = [
    { id: "ev-a1a1a1a1a1a1", field: "tw_monthly_revenue", value: 192.07, unit: "亿新台币", currency: "TWD", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-a2a2a2a2a2a2", field: "tw_monthly_revenue_mom_pct", value: 8.3, unit: "%", currency: "n/a", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-b1b1b1b1b1b1", field: "gpu_spot_median_usd_per_gpu_hr", value: 6.88, unit: "美元/卡时", currency: "USD", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
    { id: "ev-b2b2b2b2b2b2", field: "gpu_spot_offer_count", value: 23, unit: "档", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
  ];
  writeJson(path.join(d, "evidence.json"), ev);
  writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5, titles: {}, guards: {}, thermometers: {} });
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: ["ev-a1a1a1a1a1a1", "ev-b1b1b1b1b1b1"] }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const good = `# 报告\n\n## 事实\n\n- 营收 x [ev-zz]\n\n## 产业温度计\n\n- 2026-07 · FinMind · 台光月营收 192.07 亿新台币、环比 8.3%;护栏:台光须与金像电差分后归因,不能单独归因。[ev-a1a1a1a1a1a1] [ev-a2a2a2a2a2a2]\n- 2026-08-23 · Vast · B200 现货中位 6.88 美元/卡时、在租 23 档;护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线。[ev-b1b1b1b1b1b1] [ev-b2b2b2b2b2b2]\n\n## 裁决点\n\n- x\n`;
  fs.writeFileSync(path.join(d, "report.md"), good);
  const r1 = judgeIndustryThermometer(d);
  assert.ok(r1.checks.filter((c) => /绑到|护栏/.test(c.name)).every((c) => c.pass), JSON.stringify(r1.checks.filter((c) => !c.pass)));
  // 假绿形态 ①:数字行不带 id,id 集中在另一行 → 数字未绑定
  fs.writeFileSync(path.join(d, "report.md"), good.replace("6.88 美元/卡时、在租 23 档;护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线。[ev-b1b1b1b1b1b1] [ev-b2b2b2b2b2b2]", "6.88 美元/卡时、在租 23 档。\n- 折旧参考线、差分、不能单独归因 [ev-b1b1b1b1b1b1] [ev-b2b2b2b2b2b2]"));
  const r2 = judgeIndustryThermometer(d);
  assert.ok(!r2.checks.find((c) => /绑到/.test(c.name))!.pass, "数字行无 id 不得回退全池");
  // 假绿形态 ②:护栏只在章末出现一次,引 GPU id 的数字行没有折旧线护栏
  fs.writeFileSync(path.join(d, "report.md"), good.replace(";护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线", ""));
  const r3 = judgeIndustryThermometer(d);
  assert.ok(!r3.checks.find((c) => /护栏/.test(c.name))!.pass, "护栏须与数字同行");
});

test("industry-r2:护栏反向表述判缺;温度计 id 出现在结论摘要且未写明「不是本公司数据」判泄漏;标签表缺失直接抛", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-r2-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const ev = [
    { id: "ev-a1a1a1a1a1a1", field: "tw_monthly_revenue", value: 192.07, unit: "亿新台币", currency: "TWD", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-b1b1b1b1b1b1", field: "gpu_spot_median_usd_per_gpu_hr", value: 6.88, unit: "美元/卡时", currency: "USD", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
  ];
  writeJson(path.join(d, "evidence.json"), ev);
  writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5, titles: {}, guards: {}, thermometers: {} });
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: ["ev-a1a1a1a1a1a1", "ev-b1b1b1b1b1b1"] }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const base = (tw: string, gpu: string, summary = "- 公司基本面 x") => `# 报告\n\n## 结论摘要\n\n${summary}\n\n## 产业温度计\n\n- 2026-07 · FinMind · 台光月营收 192.07 亿新台币;${tw} [ev-a1a1a1a1a1a1]\n- 2026-08-23 · Vast · B200 现货中位 6.88 美元/卡时;${gpu} [ev-b1b1b1b1b1b1]\n\n## 裁决点\n\n- x\n`;
  const okTw = "护栏:台光须与金像电差分后归因,不能单独归因", okGpu = "护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线";
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, okGpu));
  assert.ok(judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass);
  fs.writeFileSync(path.join(d, "report.md"), base("无需与金像电差分,可以单独归因英伟达链", okGpu));
  assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, "台系反向表述");
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, "3 美元不是折旧参考线,而是完整保本线"));
  assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, "GPU 反向表述");
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, okGpu, "- 中际旭创月营收 192.07 亿新台币 [ev-a1a1a1a1a1a1]"));
  assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /只出现在/.test(c.name))!.pass, "结论摘要里把温度计写成本公司");
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, okGpu, "- 上游产业链上下游数据显示台光月营收 192.07 亿新台币,不是本公司数据 [ev-a1a1a1a1a1a1]"));
  assert.ok(judgeIndustryThermometer(d).checks.find((c) => /只出现在/.test(c.name))!.pass, "写明不是本公司数据的交叉引用放行");
  assert.throws(() => loadIndustryTags(fs.mkdtempSync(path.join(os.tmpdir(), "vra-no-table-"))), /缺失/);
});

test("industry-r3:标签表为数组 / 空对象 / 字段为空都抛;合规的自然写法不被护栏正则误杀", () => {
  const mk = (body: unknown) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), "vra-tags-")); fs.mkdirSync(path.join(r, "datasources")); fs.writeFileSync(path.join(r, "datasources", "industry_tags.json"), JSON.stringify(body)); return r; };
  assert.throws(() => loadIndustryTags(mk({ tags: [] })), /非法/);
  assert.throws(() => loadIndustryTags(mk({ tags: {} })), /非法/);
  assert.throws(() => loadIndustryTags(mk({ tags: { x: { strong_keywords: [], thermometers: ["a"], guard: "g" } } })), /非法/);
  assert.throws(() => loadIndustryTags(mk({ tags: { x: { strong_keywords: ["a"], thermometers: ["a"], guard: "" } } })), /非法/);
  assert.ok(loadIndustryTags(mk({ tags: { x: { strong_keywords: ["a"], thermometers: ["a"], guard: "g" } } })).tags.x);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-r3-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  writeJson(path.join(d, "evidence.json"), [
    { id: "ev-a1a1a1a1a1a1", field: "tw_monthly_revenue", value: 192.07, unit: "亿新台币", currency: "TWD", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-b1b1b1b1b1b1", field: "gpu_spot_median_usd_per_gpu_hr", value: 6.88, unit: "美元/卡时", currency: "USD", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
  ]);
  writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5, titles: {}, guards: {}, thermometers: {} });
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: ["ev-a1a1a1a1a1a1", "ev-b1b1b1b1b1b1"] }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const rep = (tw: string, gpu: string) => `# 报告\n\n## 产业温度计\n\n- 台光月营收 192.07 亿新台币;${tw} [ev-a1a1a1a1a1a1]\n- B200 租金 6.88 美元/卡时;${gpu} [ev-b1b1b1b1b1b1]\n\n## 裁决点\n\n- x\n`;
  const naturalTw = ["该读数不可单独归因,需与金像电差分后再判断", "应先与金像电差分,差分后方可归因", "必须与金像电差分后归因,不能单独归因", "台光单月营收未能单独归因,需与金像电差分后再判断"];
  const naturalGpu = ["3 美元/卡时仅为设备折旧参考线,不能视作完整经济保本线", "3 美元是折旧参考线,并非完整经济保本线", "折旧参考线 3 美元不代表保本线", "3 美元/卡时属于 B200 设备折旧参考线,不能视为完整经济保本线"];
  for (const tw of naturalTw) for (const gpu of naturalGpu) { fs.writeFileSync(path.join(d, "report.md"), rep(tw, gpu)); assert.ok(judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, `${tw} / ${gpu}`); }
  for (const [tw, gpu] of [["无需与金像电差分,可以单独归因", naturalGpu[0]], [naturalTw[0], "3 美元不是折旧参考线,而是完整保本线"], [naturalTw[0], "折旧参考线 3 美元即完整保本线"], [naturalTw[0], "3 美元/卡时仅为设备折旧参考线,但在当前电价下相当于完整经济保本线"]] as const) { fs.writeFileSync(path.join(d, "report.md"), rep(tw, gpu)); assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, `反向:${tw} / ${gpu}`); }
});
