import assert from "node:assert/strict";
import { test } from "node:test";

import { currentPack, registerDomainPack, resetDomainPack, type DomainPack } from "../src/domain.ts";
import { FINANCE_PACK } from "../src/finance/pack.ts";

/**
 * `DomainPack` 注册期校验的单测。
 *
 * 🔴 这些校验是**编译期穷尽性检查的替代品** —— `Stage` 退化成 `string` 之后,
 * `Record<Stage, …>` 再也保证不了"每个阶段都配齐了",全靠注册时逐项核对。
 * 所以每一条都要有测试:校验本身失效了,是没人会发现的那种失效。
 */

const pack = (over: Partial<DomainPack> = {}): DomainPack => ({ ...FINANCE_PACK, ...over });
const withEvidence = (over: Partial<DomainPack["evidence"]>): DomainPack =>
  pack({ evidence: { ...FINANCE_PACK.evidence, ...over } });

/** 每个用例都从干净状态开始:注册是进程级单例,残留会让后面的用例莫名其妙 */
const fresh = (p: DomainPack) => { resetDomainPack(); registerDomainPack(p); };
const rejects = (p: DomainPack, re: RegExp) => {
  resetDomainPack();
  assert.throws(() => registerDomainPack(p), re);
};

test("四张阶段表的键集必须与 stages 完全一致(这是编译期穷尽性的替代品)", () => {
  const { financials: _drop, ...missing } = FINANCE_PACK.stageCalcs;
  rejects(pack({ stageCalcs: missing }), /stageCalcs 的键必须与 stages 完全一致[\s\S]*缺少 financials/);
  rejects(pack({ extraTopics: { ...FINANCE_PACK.extraTopics, 打错的阶段名: ["x"] } }),
    /extraTopics 的键必须与 stages 完全一致[\s\S]*多出 打错的阶段名/);
  const { profile: _p, ...noLabel } = FINANCE_PACK.stageLabels;
  rejects(pack({ stageLabels: noLabel }), /stageLabels 的键必须与 stages 完全一致/);
});

test("阶段名必须是安全路径段:它会被拼进 stages/<stage>.json", () => {
  // 🔴 包里写个 ../.. 就能穿出运行目录
  for (const bad of ["../../etc", "a/b", "a\\b", ".hidden", "", "x".repeat(65)]) {
    rejects(pack({ stages: [...FINANCE_PACK.stages, bad] }),
      /不是安全的路径段|必须是非空字符串数组|键必须与 stages/);
  }
});

test("extraTopics 的某阶段为空 = 该阶段任何议题都过不了 schema(静默失效)", () => {
  rejects(pack({ extraTopics: { ...FINANCE_PACK.extraTopics, report: [] } }), /extraTopics\.report 必须非空/);
});

test("两套 market code 是不同规则:Only ⊆ Codes ⊆ markets", () => {
  rejects(withEvidence({ marketWideOnlyCodes: ["US"], marketWideCodes: ["CN"] }),
    /marketWideOnlyCodes 里的 US 不在 marketWideCodes 中/);
  rejects(withEvidence({ marketWideCodes: ["XX"], marketWideOnlyCodes: [] }),
    /marketWideCodes 里的 XX 不在 markets 中/);
  // 金融的正确配置:CN 只能是全市场(个股用 SH/SZ/BJ),US / HK 两者都行
  fresh(FINANCE_PACK);
  assert.deepEqual([...currentPack().evidence.marketWideOnlyCodes], ["CN"]);
  assert.ok(currentPack().evidence.marketWideCodes.includes("US"));
});

test("标准列与显示名必须**互相覆盖**:缺一个就会静默少一列表头", () => {
  const { peg: _drop, ...missingLabel } = FINANCE_PACK.standardColumnLabels;
  rejects(pack({ standardColumnLabels: missingLabel }), /缺列 peg 的显示名/);
  rejects(pack({ standardColumnLabels: { ...FINANCE_PACK.standardColumnLabels, 不存在的列: "X" } }),
    /出现了不存在的列 不存在的列/);
});

test("selfTestCalc 的 args 要真的校验(它一度只写在错误文案里)", () => {
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: [] as never, expect: 20 } }), /selfTestCalc 需要/);
  rejects(pack({ selfTestCalc: { fn: "", args: {}, expect: 20 } }), /selfTestCalc 需要/);
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: {}, expect: NaN } }), /selfTestCalc 需要/);
});

test("函数插槽必须是函数;standardColumnsStage 必须是已声明的阶段", () => {
  rejects(pack({ quoteDecision: undefined as never }), /quoteDecision 必须是函数/);
  rejects(pack({ baselinePeriod: undefined as never }), /baselinePeriod 必须是函数/);
  rejects(pack({ standardColumnsStage: "不存在" }), /standardColumnsStage[\s\S]*不是已声明的阶段/);
});

test("快照与原包解耦:注册后改原对象改不动已生效的包", () => {
  const mutable: DomainPack = {
    ...FINANCE_PACK,
    stages: [...FINANCE_PACK.stages],
    stageScripts: JSON.parse(JSON.stringify(FINANCE_PACK.stageScripts)) as DomainPack["stageScripts"],
  };
  fresh(mutable);
  (mutable.stageScripts.profile.required as string[]).push("偷偷加的脚本");
  assert.ok(!currentPack().stageScripts.profile.required.includes("偷偷加的脚本"));
  // 快照里的数组也冻了:消费者一句 push 不该改掉已生效的运行计划
  assert.throws(() => (currentPack().stageScripts.profile.required as string[]).push("x"));
});

test("同一份幂等;换一份当场失败;reset 要把词表一起清掉", () => {
  fresh(FINANCE_PACK);
  registerDomainPack(FINANCE_PACK);                       // 同一份:安静返回
  assert.throws(() => registerDomainPack({ ...FINANCE_PACK }), /不支持多垂类并存/);
  // 🔴 只清包不清词表的话,下一个包会在注册词表那步失败
  resetDomainPack();
  registerDomainPack({ ...FINANCE_PACK });
  assert.equal(currentPack().id, "finance");
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);                        // 复原,不影响别的用例
});

test("未注册时读包直接抛错,不给静默默认值", () => {
  resetDomainPack();
  assert.throws(() => currentPack(), /未注入 DomainPack/);
  registerDomainPack(FINANCE_PACK);
});

/* ---------- Codex domainpack-r2 的回归 ---------- */

test("每张嵌套表都只读一次:带 getter 的包不能「校验时一个值、建快照时另一个值」", () => {
  // 🔴 我一度只对 stageScripts 做了深层单读,其余五张表照旧二次读取 —— 同一个根因漏了五处
  for (const key of ["stageCalcs", "extraTopics", "semanticSlots", "stageLabels", "standardColumnLabels"] as const) {
    let n = 0;
    const evil: Record<string, unknown> = { ...(FINANCE_PACK[key] as Record<string, unknown>) };
    const firstStage = FINANCE_PACK.stages[0];
    const good = (FINANCE_PACK[key] as Record<string, unknown>)[firstStage]
      ?? (FINANCE_PACK[key] as Record<string, unknown>)[Object.keys(FINANCE_PACK[key] as object)[0]];
    Object.defineProperty(evil, Object.keys(FINANCE_PACK[key] as object)[0], {
      enumerable: true, get() { return n++ === 0 ? good : [12345]; },
    });
    resetDomainPack();
    registerDomainPack(pack({ [key]: evil } as Partial<DomainPack>));
    // 只读一次 ⇒ getter 只跑了一次,活动包里是"被校验过的那个值"
    assert.equal(n, 1, `${key} 被读了 ${n} 次`);
  }
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("selfTestCalc.args 必须是**普通对象**:Map / Date 展开后会静默变成 {}", () => {
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: new Map() as never, expect: 20 } }), /selfTestCalc 需要/);
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: new Date() as never, expect: 20 } }), /selfTestCalc 需要/);
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("关键脚本拼错要当场说:否则「关键脚本全失败 → failed」永远匹配不上(静默降级)", () => {
  rejects(pack({ criticalScripts: ["fetch_quote", "fetch_finacials"] }),
    /criticalScripts 里的 fetch_finacials 没出现在任何阶段的取数计划里/);
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("非法表类型必须抛,不能被吞成空表(那等于绕过整个注册期校验)", () => {
  // 🔴 我上一轮的 entriesOnce 对 Map / Date / 字符串一律返回 [] ——
  //    没有阶段穷尽检查的那几张表就"空表通过"了(Codex domainpack-r3)
  for (const key of ["semanticSlots", "topicSections", "standardColumnLabels"] as const) {
    rejects(pack({ [key]: new Map() } as Partial<DomainPack>), new RegExp(`${key} 必须是普通对象`));
    rejects(pack({ [key]: new Date() } as Partial<DomainPack>), new RegExp(`${key} 必须是普通对象`));
  }
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("嵌套数组在**摄入时**就拷贝:带索引 getter 的数组骗不到快照", () => {
  let n = 0;
  const sneaky: unknown[] = [];
  Object.defineProperty(sneaky, "0", { enumerable: true, configurable: true, get: () => (++n < 2 ? "fetch_profile" : { injected: true }) });
  Object.defineProperty(sneaky, "length", { value: 1, writable: true });
  const p = pack({ stageScripts: { ...FINANCE_PACK.stageScripts, report: { required: sneaky as string[], optional: [] } } });
  resetDomainPack();
  registerDomainPack(p);
  assert.deepEqual([...currentPack().stageScripts.report.required], ["fetch_profile"]);   // 是被校验过的那个值
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("槽位与自检入参要**深**冻结:只冻第一层的话内层仍是共享可变引用", () => {
  const slot = { fn: "x", selector: { field: "revenue" } };
  const args = { input: { value: 1 } };
  const p = pack({ semanticSlots: { profile: [slot] }, selfTestCalc: { fn: "forward_pe", args, expect: 20 } });
  resetDomainPack();
  registerDomainPack(p);
  slot.selector.field = "profit";
  args.input.value = 999;
  assert.equal((currentPack().semanticSlots.profile[0] as typeof slot).selector.field, "revenue");
  assert.equal((currentPack().selfTestCalc.args as typeof args).input.value, 1);
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("topicSections 的议题必须是已声明的(值是**扩展章节**,不能拿 reportSections 校验)", () => {
  rejects(pack({ topicSections: { ...FINANCE_PACK.topicSections, 拼错的议题: "资金与市场行为" } }),
    /topicSections 里的议题 拼错的议题 没有出现在任何阶段的 extraTopics 里/);
  // 值是扩展章节名,本来就不在 reportSections 里 —— 照字面查会把正确配置全判错
  fresh(FINANCE_PACK);
  assert.ok(!currentPack().reportSections.includes(currentPack().topicSections["资金行为"]));
});

test("槽位与自检入参只接受 JSON 式的值:Map / Set / Date 会被拒(它们没法真的深冻结)", () => {
  // 🔴 原样返回的话它们是**共享可变引用**,注册后 shared.set(…) 就能改掉已生效的配置
  const shared = new Map([["field", "revenue"]]);
  rejects(pack({ semanticSlots: { profile: [{ selector: shared }] } }), /只能是 JSON 式的值/);
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: { options: new Set() } as never, expect: 20 } }), /只能是 JSON 式的值/);
  rejects(pack({ semanticSlots: { profile: [{ at: new Date() }] } }), /只能是 JSON 式的值/);
  // 正当的纯数据配置照旧通过
  resetDomainPack();
  registerDomainPack(pack({ semanticSlots: { profile: [{ fn: "x", fields: ["a", "b"], n: 1, ok: true, none: null }] } }));
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("undefined / NaN / Infinity 不是 JSON 值:序列化后与快照对不上", () => {
  // 🔴 JSON.stringify({price: NaN, x: undefined}) → {"price":null} —— 快照一个值,CLI 收到另一个
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: { price: NaN }, expect: 20 } }), /不能是 NaN \/ Infinity/);
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: { price: undefined }, expect: 20 } }), /不能是 undefined/);
  rejects(pack({ semanticSlots: { profile: [{ n: Infinity }] } }), /不能是 NaN \/ Infinity/);
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("__proto__ 不会污染快照:深拷贝用 Object.create(null) 建对象", () => {
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  resetDomainPack();
  registerDomainPack(pack({ selfTestCalc: { fn: "forward_pe", args: polluted, expect: 20 } }));
  const args = currentPack().selfTestCalc.args as Record<string, unknown>;
  // `__proto__` 成了普通自有属性,而不是把原型改掉
  assert.ok(Object.prototype.hasOwnProperty.call(args, "__proto__"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});

test("稀疏数组要拒:.map() 跳过空洞,而 JSON.stringify 会把空洞写成 null", () => {
  rejects(pack({ selfTestCalc: { fn: "forward_pe", args: { values: new Array(1) as never }, expect: 20 } }),
    /是数组空洞/);
  const sparse: unknown[] = [1]; sparse[2] = 3;          // [1, <空>, 3]
  rejects(pack({ semanticSlots: { profile: [{ xs: sparse }] } }), /是数组空洞/);
  resetDomainPack();
  registerDomainPack(FINANCE_PACK);
});
