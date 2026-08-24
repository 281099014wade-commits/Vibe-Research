import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * **Core 词汇纯净度棘轮**(架构审计 2026-08-24 的第一件事)。
 *
 * 战略:做垂类行业 AgentOS(Core + DomainPack),第一个是金融,后面按行业铺开。
 * 审计结论:当前是「金融产品内部包含一批可抽取的通用机制」,**不是**可挂载 FinancePack / RestaurantPack 的 Core;
 * 验收标准是「**Core 中不再出现 A股 / EPS / PE / TTM / 申万行业等词汇**」。
 *
 * 🔴 这不是"代码整洁度"检查,而是**垂类系列能否成立的度量**:
 * Core 里每一处金融词汇,都是明天做餐饮 AgentOS 时要重写或绕开的地方。
 *
 * 做成**棘轮**而不是一次性红灯:87 处不可能一次清完,但**只许变好不许变坏** ——
 * 每搬走一块就把基线调低,新写的 Core 代码不许再引入行业词。
 * ⚠️ 基线只能下调。要上调必须在这里写明理由 —— 那等于承认边界又退了一步。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

/**
 * ASCII 词必须走词边界 —— 否则 `PE` 会命中 TYPE / OPEN / PERMISSION(初版就这么误报了 25 处)。
 * ⚠️ **大小写不敏感**:`pe` / `ttm` / `QFQ` 同样是行业词,区分大小写等于留了一条绕过路径
 * (Codex lexicon-r1 P2)。
 */
const ASCII_TERMS = ["EPS", "PE", "PEG", "TTM", "qfq", "hfq"];
const CJK_TERMS = [ "申万", "扣非", "归母", "估值", "财报", "股价", "涨跌", "市值", "证券",
  "交易日", "停牌", "盘前", "复权", "研报", "一致预期", "净利", "营收", "季报", "年报", "个股", "标的",
  "产业链", "上市", "股东", "龙虎榜", "融资融券", "筹码", "行业", "板块"];

/** 明确属于 finance-pack、不参与本检查的文件(它们本来就该是行业实现) */
export const FINANCE_FILES = ["stages.ts", "industry.ts", "chokepoint.ts", "thermo_history.ts",
  "hardtest.ts", "provider_matrix.ts"];

/**
 * 全局上限:所有 Core 文件的行业词**总数**。**只能下调。**
 *
 * 🔴 为什么在逐文件基线之外还要一个总数:逐文件基线可以"加耦合的同时把该文件基线一起调高",
 * 两条断言都还是绿的(Codex lexicon-r1 P1)。总数是**一个**数字,调高它在 review 里藏不住。
 * ⚠️ 诚实说明:这仍是**约定 + 可见性**,不是机器证明"相对历史只降不升" ——
 * 真要机器保证得跟 git 历史比。它的定位是回归提示器,不是安全边界。
 */
const CEILING = 149;

/**
 * 基线:当前每个 Core 候选文件里的行业词数量。**只能下调。**
 * 空缺 = 该文件必须保持 0(新增 Core 文件默认进这一档)。
 */
const BASELINE: Record<string, number> = {
  // ⚠️ **2026-08-24 重新标定:67 → 146。这不是新增耦合,是原来看不见的耦合暴露了。**
  //    ASCII 词表原本区分大小写,于是 `pe_ttm` / `eps_consensus` 这类**小写字段名**
  //    一直是盲区(Codex lexicon-r1 P2 指出)。改成大小写不敏感后,validator 从 13 跳到 58 ——
  //    它本来就是最重的那个,只是之前没数全。
  //    随后修好 `A股` 的正则(它一度被整体转义成字面量)又露出 3 处 ⇒ 146 → 149。
  //    ⇒ 教训:**棘轮的数字只在词表本身可信时才有意义**;每次修词表都要预期基线上跳,
  //      并把上跳的原因写下来,否则下次没人分得清"暴露的旧耦合"和"新加的耦合"。
  "validator.ts": 59,        // 审计点名:validator 本身就是金融实现(交易日 / 盘前 / 停牌 + 估值字段绑定)
  "batch.ts": 15,            // 批量摘要的标准列
  "alerts.ts": 14,
  "schemas.ts": 14,          // market 固定为证券市场、adjustment 固定 qfq/hfq
  "config.ts": 12,           // 阶段名是编译期常量,且注释里带估值语义
  "fixture.ts": 6,
  "orchestrate.ts": 5,
  "registry.ts": 4,
  "doctor.ts": 3,
  "knowledge.ts": 3,
  "number_fidelity.ts": 3,   // ✅ 已完成第一次搬迁(23 → 3):词表移入 `finance/lexicon.ts`,Core 侧改为注入
  "progress.ts": 3,
  "mcp.ts": 2,
  "runner.ts": 2,
  "api.ts": 1,
  "report_sections.ts": 1,
  "run.ts": 1,
  "service.ts": 1,
};

/**
 * 需要用正则表达的词条(**不走下面的整体转义**)。
 * 🔴 我一度把 `A\s*股` 塞进 `CJK_TERMS`,而那张表在构造正则前会整体转义 —— 于是它变成了
 * 匹配字面文本 `A\s*股` 的模式,`A股` / `A 股` 一个都命中不了,棘轮假绿(Codex lexicon-r2 P1)。
 */
const CJK_PATTERNS: [string, RegExp][] = [["A股", /A\s*股/gi]];

export function countDomainTerms(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ASCII_TERMS) {
    const n = (text.match(new RegExp(`(?<![A-Za-z])${t}(?![A-Za-z])`, "gi")) ?? []).length;
    if (n) out[t] = n;
  }
  for (const [label, re] of CJK_PATTERNS) {
    const n = (text.match(re) ?? []).length;
    if (n) out[label] = n;
  }
  for (const t of CJK_TERMS) {
    const n = (text.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    if (n) out[t] = n;
  }
  return out;
}

/** 已声明的 DomainPack 目录:整目录属于垂类实现,不参与 Core 纯净度检查 */
export const PACK_DIRS = ["finance"];

/**
 * 待检查的 Core 文件(**递归**,相对 `src/` 的路径)。
 *
 * 🔴 初版只扫 `src/` 顶层,于是"把带 PE / 申万 的实现搬进 `src/core/valuation.ts`"
 * 就能整片免检 —— 棘轮看不见的地方才是耦合最容易长回来的地方(Codex lexicon-r1 P1)。
 */
function coreFiles(dir = SRC, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // 🔴 按**相对路径**精确排除,不是按目录名:`PACK_DIRS.includes(e.name)` 会让任意层级的
      //    `src/core/finance/` 也白白拿到豁免,而它根本不是已声明的 DomainPack(Codex lexicon-r2 P1)
      if (!PACK_DIRS.includes(rel)) out.push(...coreFiles(path.join(dir, e.name), rel));
    } else if (e.name.endsWith(".ts") && !FINANCE_FILES.includes(rel)) {
      out.push(rel);
    }
  }
  return out;
}

const termsIn = (f: string) => Object.values(countDomainTerms(fs.readFileSync(path.join(SRC, f), "utf8"))).reduce((a, b) => a + b, 0);

test("Core 纯净度棘轮:任何 Core 文件的行业词数量都不许高于基线", () => {
  const worse: string[] = [];
  for (const f of coreFiles()) {
    const hits = countDomainTerms(fs.readFileSync(path.join(SRC, f), "utf8"));
    const n = Object.values(hits).reduce((a, b) => a + b, 0);
    const cap = BASELINE[f] ?? 0;
    if (n > cap) {
      worse.push(`${f}: ${n} > 基线 ${cap}(${Object.entries(hits).map(([k, v]) => `${k}×${v}`).join(", ")})`);
    }
  }
  assert.deepEqual(worse, [], `以下 Core 文件的行业耦合变严重了 —— 新代码不许把行业词写进 Core:\n${worse.join("\n")}`);
});

test("基线不许虚高:已经比基线干净的文件要把基线调下来(否则棘轮会松掉)", () => {
  const stale: string[] = [];
  for (const [f, cap] of Object.entries(BASELINE)) {
    if (!fs.existsSync(path.join(SRC, f))) { stale.push(`${f}: 文件已不存在,基线该删`); continue; }
    const n = termsIn(f);
    if (n < cap) stale.push(`${f}: 实际 ${n} < 基线 ${cap},把基线改成 ${n}`);
  }
  assert.deepEqual(stale, [], `棘轮松了 —— 搬走行业代码后要同步下调基线:\n${stale.join("\n")}`);
});

test("全局上限:行业词总数只许降不许升(逐文件基线可以被一起调高,总数藏不住)", () => {
  const total = coreFiles().reduce((a, f) => a + termsIn(f), 0);
  assert.ok(total <= CEILING, `行业词总数 ${total} 超过上限 ${CEILING} —— 新代码不许把行业词写进 Core`);
});

test("进度可见:报出当前总量与干净文件数(不断言,只为让每次跑测试都看得到还差多少)", () => {
  const files = coreFiles();
  let total = 0, clean = 0;
  for (const f of files) { const n = termsIn(f); total += n; if (n === 0) clean += 1; }
  console.error(`[core-purity] 行业词 ${total} 处 · 干净 ${clean}/${files.length} 个文件 · 目标 0`);
  assert.ok(total >= 0);
});

test("A 股要真的能命中(它一度被整体转义成字面量,棘轮因此假绿)", () => {
  assert.deepEqual(countDomainTerms("A股"), { A股: 1 });
  assert.deepEqual(countDomainTerms("A 股"), { A股: 1 });
  assert.deepEqual(countDomainTerms("A   股"), { A股: 1 });
  assert.deepEqual(countDomainTerms("a股"), { A股: 1 });          // 与 ASCII 词表同口径:大小写不敏感
  assert.deepEqual(countDomainTerms("AB股份"), {});
});

test("词表本身要可信:ASCII 词走词边界,不能命中 TYPE / OPEN 里的 PE", () => {
  assert.deepEqual(countDomainTerms("const TYPE = OPEN_PERMISSION;"), {});
  assert.deepEqual(countDomainTerms("PE 为 30 倍"), { PE: 1 });
  assert.deepEqual(countDomainTerms("扣非归母净利"), { 扣非: 1, 归母: 1, 净利: 1 });
});
