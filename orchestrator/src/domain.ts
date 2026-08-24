/**
 * **DomainPack 契约** —— Core 与垂类之间的那条缝。
 *
 * 战略:同一个 Core,按垂类挂不同的包(第一个是金融,后面还有别的)。
 * 判断一样东西该放哪边,只问一句:**换个垂类它要不要重写?**
 * - 要重写 → 进包(阶段名、每阶段的取数脚本 / 计算函数 / 议题、报告章节、证据枚举、标准列、词表)
 * - 不用重写 → 留 Core(状态机、校验骨架、证据契约、数字忠实度判定、编排)
 *
 * 🔴 **为什么用注册期校验替代编译期穷尽性检查**:
 * 原来 `Record<Stage, …>` 靠 `Stage` 这个字面量联合类型保证"每个阶段都配齐了"。
 * 一旦阶段名要随垂类变,这个类型就得变成 `string`,穷尽性检查也就没了。
 * ⇒ 改为**注册时逐项核对**:阶段计划 / 计算函数 / 议题的键必须与 `stages` **完全一致**
 * (不许缺、不许多)。对可插拔设计来说这比编译期更管用 —— 它同样拦得住第三方包写漏,
 * 而编译期检查只保护得了我们自己的代码。
 * ⚠️ **别把它说成"完整替代"**:它补回的是"阶段键穷尽性"这一项,
 * 值的类型、跨表引用完整性(如 criticalScripts 是否出现在某阶段、semanticSlots 是否漏配)
 * 要靠下面各自的校验,漏了就是漏了(Codex domainpack-r1 P2)。
 *
 * ⚠️ 与 `number_fidelity.ts` 的词表注册是**同一套纪律**:进程级单例、同一份幂等、
 * 换一份当场失败、先建快照最后原子提交。词表是本契约的一个字段,注册包时一并注册,
 * **只有一个注册点**(避免"注册了包却忘了注册词表"这种半初始化)。
 */
import { currentLexicon, resetDomainLexicon, setDomainLexicon, type DomainLexicon } from "./number_fidelity.ts";

/** 每阶段的取数脚本:required 全失败 → 阶段不完整;optional 缺失只记 gap */
//: 数组是 `readonly` 的:快照冻结了对象却没冻数组时,消费者一句 `.required.push(…)` 就能改掉
//: 已生效的运行计划(Codex domainpack-r1 P2)。
export interface StageScripts { readonly required: readonly string[]; readonly optional: readonly string[] }

export interface DomainPack {
  /** 包标识,用于报错与诊断("finance" / "restaurant") */
  readonly id: string;
  /** 阶段顺序。Core 只知道"有一串阶段、按序执行",不知道它们叫什么 */
  readonly stages: readonly string[];
  /** 每阶段的取数脚本(注册表缺失时的回退计划) */
  readonly stageScripts: Readonly<Record<string, StageScripts>>;
  /** 关键脚本:全部失败 → 整个运行 failed(拿不到可用研究) */
  readonly criticalScripts: readonly string[];
  /** 每阶段必须出现的计算函数 */
  readonly stageCalcs: Readonly<Record<string, readonly string[]>>;
  /** 每阶段 extra_findings 允许的议题 */
  readonly extraTopics: Readonly<Record<string, readonly string[]>>;
  /** 报告必须出现的章节标题 */
  readonly reportSections: readonly string[];
  /** 证据枚举:市场代码与数据口径 —— 换个垂类这两样都不存在或完全不同 */
  readonly evidence: {
    readonly markets: readonly string[];
    readonly adjustments: readonly string[];
    /** 哪些 market **可以**带全市场读数(symbol=MARKET) */
    readonly marketWideCodes: readonly string[];
    /**
     * 哪些 market **只**用于全市场读数 —— 该市场的个体主体用别的代码。
     * ⚠️ 与上一条是**两回事**:一个市场可以既允许 MARKET、也允许具体主体(如美股);
     * 合并成一条会把"某市场的个体证据"全判成错(实测被既有测试抓到)。
     */
    readonly marketWideOnlyCodes: readonly string[];
  };
  /** 批量摘要的标准列 */
  readonly standardColumns: readonly string[];
  /** 口径角色(语义槽位按角色解析上游计算) */
  readonly roles: readonly string[];
  /**
   * 语义槽位表:每阶段每个计算函数"输入该怎么选"。
   * Core 只保留**走表的机制**(`validator.ts`),表本身随垂类换。
   */
  readonly semanticSlots: Readonly<Record<string, readonly unknown[]>>;
  /**
   * "数据是否陈旧"的判定 —— **这是包提供的行为,不只是数据**。
   * 什么叫陈旧完全随垂类变,Core 只在该判的时候来问。
   */
  //! 参数用 `unknown`:`RunView` 定义在 `validator.ts`,而 domain 不能 import validator
  //! (会成 domain → validator → domain 的环)。调用处再收窄类型。
  readonly quoteDecision: (run: unknown) => { decision: string; reason: string };
  /** 阶段的显示名(进度条 / 日志)。同时是**白名单** —— 只有这些阶段允许被拼进文件路径 */
  readonly stageLabels: Readonly<Record<string, string>>;
  /** 议题 → 报告章节的归并映射(没列的议题不进专属章节,只作全文要求) */
  readonly topicSections: Readonly<Record<string, string>>;
  /** 变化提醒默认盯的证据字段 */
  readonly alertFields: readonly string[];
  /** 标准列的显示名(批量汇总表头);键必须**恰好**覆盖 standardColumns */
  readonly standardColumnLabels: Readonly<Record<string, string>>;
  /** 标准列住在哪个阶段的产物里(批量汇总从该阶段的 stages/<stage>.json 读) */
  readonly standardColumnsStage: string;
  /** doctor 的 calc 自检:跑哪个函数、什么入参、期望什么值 */
  readonly selfTestCalc: { readonly fn: string; readonly args: Readonly<Record<string, unknown>>; readonly expect: number };
  /** 基准期(语义槽位里 `fy: "T"` 的那个 T)怎么定 —— 金融看当前财年,别的垂类可能完全不同 */
  readonly baselinePeriod: (run: unknown) => number | null;
  /** 数字判定用的词表(见 `number_fidelity.ts` 的 `DomainLexicon`) */
  readonly lexicon: DomainLexicon;
}

let activePack: DomainPack | null = null;
/** 注册时传进来的原始对象 —— 只用于"是不是同一份"的身份判断(活动包本身是冻结快照) */
let registeredSource: DomainPack | null = null;
let registering = false;

const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "");
const uniq = (xs: readonly string[]) => new Set(xs).size === xs.length;

/** 键集必须与阶段集**完全一致**:缺一个 = 该阶段没人管;多一个 = 名字写错了却没人告诉你 */
function assertKeysMatchStages(what: string, rawKeys: readonly string[], stages: readonly string[]): void {
  const keys = [...rawKeys].sort();
  const want = [...stages].sort();
  const missing = want.filter((s) => !keys.includes(s));
  const extra = keys.filter((k) => !want.includes(k));
  if (missing.length || extra.length) {
    throw new Error(`DomainPack.${what} 的键必须与 stages 完全一致`
      + (missing.length ? `;缺少 ${missing.join(" / ")}` : "")
      + (extra.length ? `;多出 ${extra.join(" / ")}` : ""));
  }
}

/**
 * 注册垂类包。**同一进程只允许一份**;同一份幂等,换一份当场抛错。
 * 校验全部通过、快照建好之后才提交 —— 中途失败不会留下半注册状态。
 */
export function registerDomainPack(pack: DomainPack): void {
  if (registering) throw new Error("registerDomainPack 不支持重入(注册过程中不许再次注册)");
  registering = true;
  try {
    register(pack);
  } finally {
    registering = false;
  }
}

/** 普通记录:`new Map()` / `new Date()` 展开后会静默变成 `{}`,与"通过校验的那个参数"不是一回事 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 把一张表的键值**各读一次**,之后只用这份拷贝。
 *
 * 🔴 `Object.entries(obj)` 每调一次就会把所有 getter 再跑一遍 —— 校验时给合法值、
 * 建快照时换一个,未经校验的内容就进了活动包(Codex domainpack-r2 P1)。
 */
function entriesOnce<T>(what: string, obj: unknown): [string, T][] {
  // 🔴 **非法类型要抛,不能吞成空表**:`new Map()` / `new Date()` / 字符串一律返回 [] 的话,
  //    没有阶段穷尽检查的那几张表(semanticSlots / topicSections / standardColumnLabels)
  //    会"空表通过",等于绕过了整个注册期校验(Codex domainpack-r3)。
  if (!isPlainObject(obj)) throw new Error(`DomainPack.${what} 必须是普通对象`);
  return Object.entries(obj as Record<string, T>);
}

/**
 * 深拷贝 + 深冻结。**只接受 JSON 式的值**:原始值 / 普通对象 / 数组;
 * 碰到 `Map` / `Set` / `Date` / 类实例 / 函数一律抛错。
 *
 * 🔴 为什么要拒而不是"原样返回":原样返回的那个对象是**共享可变引用**,
 * 注册后 `shared.set(…)` 就能改掉已生效的配置,"深冻结"这句声称就是假的(Codex domainpack-r4)。
 * ⚠️ 这会不会误拒正当配置?不会 —— 用到它的两个字段本来就必须是 JSON 式:
 * 槽位是纯配置数据,而 `selfTestCalc.args` 要 `JSON.stringify` 后传给 calc CLI
 * (往里放 `Map` 本来就会被序列化成 `{}`,是个坏配置)。
 */
function deepFrozen<T>(what: string, v: T): T {
  if (v === null) return v;
  const t = typeof v;
  // 🔴 `undefined` / `NaN` / `Infinity` **不是 JSON 值**:`JSON.stringify` 会把它们
  //    悄悄变成消失 / `null` —— 快照里是一个值,calc CLI 收到的是另一个(Codex domainpack-r5)。
  if (v === undefined) throw new Error(`DomainPack.${what} 不能是 undefined(JSON 序列化时会消失)`);
  if (t === "number" && !Number.isFinite(v as number)) throw new Error(`DomainPack.${what} 不能是 NaN / Infinity(JSON 序列化时会变成 null)`);
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) {
    // 🔴 `.map()` **跳过数组空洞**,稀疏数组因此绕过上面的 undefined 检查,
    //    而 `JSON.stringify([ , ])` 会把空洞写成 `null`(Codex domainpack-r6)。逐索引查。
    // ⚠️ 检查**不能写在 `.map()` 回调里** —— 回调对空洞压根不执行,等于检查没跑(我就这么错了一次)
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) throw new Error(`DomainPack.${what}[${i}] 是数组空洞(稀疏数组,JSON 序列化时会变成 null)`);
      out.push(deepFrozen(`${what}[${i}]`, v[i]));
    }
    return Object.freeze(out) as unknown as T;
  }
  if (isPlainObject(v)) {
    // 🔴 用 `Object.create(null)`:往普通 `{}` 上写 `out["__proto__"] = …` 会触发原型 setter,
    //    不会建立同名自有属性 —— 一个 `JSON.parse('{"__proto__":{…}}')` 就能让快照内容被改掉。
    // ⚠️ 代价:这些对象**没有原型成员**。`JSON.stringify` / 展开 / `Object.keys` / `in` /
    //    `Object.hasOwn` 都正常,但 `obj.hasOwnProperty(…)` / `obj.toString()` 会炸。
    //    消费者请用 `Object.hasOwn(obj, k)`,别用 `obj.hasOwnProperty(k)`。
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, x] of Object.entries(v)) out[k] = deepFrozen(`${what}.${k}`, x);
    return Object.freeze(out) as unknown as T;
  }
  throw new Error(`DomainPack.${what} 只能是 JSON 式的值(原始值 / 普通对象 / 数组),收到 ${Object.prototype.toString.call(v)}`);
}

function register(pack: DomainPack): void {
  if (registeredSource === pack) return;               // 真幂等:身份判断在所有校验之前
  if (registeredSource) {
    throw new Error(`已注册过垂类包 ${activePack?.id ?? "?"}:进程级单例不支持多垂类并存,请在各自进程 / composition root 里注入`);
  }
  // 🔴 **一次性把整棵配置读进 draft,之后校验与冻结只用 draft。**
  //    包若是带 getter 的对象 / Proxy,任何"读第二次"都可能拿到另一个值。
  //    我一度只对 stageScripts 做了深层单读,其余表照旧二次读取 —— 同一个根因漏了五处。
  const cp = (v: unknown) => (Array.isArray(v) ? [...v] : v);
  const st0 = pack.selfTestCalc as { fn?: unknown; args?: unknown; expect?: unknown } | undefined;
  const ev0 = pack.evidence as Partial<DomainPack["evidence"]> | undefined;
  const d = {
    id: pack.id,
    stages: Array.isArray(pack.stages) ? [...pack.stages] : pack.stages,
    // ⚠️ 数组也要在**摄入时拷一份**:带索引 getter 的数组能让校验读到 "safe"、冻结读到别的
    stageScripts: entriesOnce<{ required?: unknown; optional?: unknown }>("stageScripts", pack.stageScripts)
      .map(([k, v]) => [k, { required: cp(v?.required), optional: cp(v?.optional) }] as const),
    criticalScripts: Array.isArray(pack.criticalScripts) ? [...pack.criticalScripts] : pack.criticalScripts,
    stageCalcs: entriesOnce<unknown>("stageCalcs", pack.stageCalcs).map(([k, v]) => [k, cp(v)] as [string, unknown]),
    extraTopics: entriesOnce<unknown>("extraTopics", pack.extraTopics).map(([k, v]) => [k, cp(v)] as [string, unknown]),
    reportSections: Array.isArray(pack.reportSections) ? [...pack.reportSections] : pack.reportSections,
    markets: Array.isArray(ev0?.markets) ? [...ev0!.markets] : ev0?.markets,
    adjustments: Array.isArray(ev0?.adjustments) ? [...ev0!.adjustments] : ev0?.adjustments,
    marketWideCodes: Array.isArray(ev0?.marketWideCodes) ? [...ev0!.marketWideCodes] : ev0?.marketWideCodes,
    marketWideOnlyCodes: Array.isArray(ev0?.marketWideOnlyCodes) ? [...ev0!.marketWideOnlyCodes] : ev0?.marketWideOnlyCodes,
    standardColumns: Array.isArray(pack.standardColumns) ? [...pack.standardColumns] : pack.standardColumns,
    standardColumnsStage: pack.standardColumnsStage,
    roles: Array.isArray(pack.roles) ? [...pack.roles] : pack.roles,
    semanticSlots: entriesOnce<unknown>("semanticSlots", pack.semanticSlots).map(([k, v]) => [k, cp(v)] as [string, unknown]),
    quoteDecision: pack.quoteDecision,
    baselinePeriod: pack.baselinePeriod,
    stageLabels: entriesOnce<unknown>("stageLabels", pack.stageLabels).map(([k, v]) => [k, cp(v)] as [string, unknown]),
    topicSections: entriesOnce<unknown>("topicSections", pack.topicSections).map(([k, v]) => [k, cp(v)] as [string, unknown]),
    alertFields: Array.isArray(pack.alertFields) ? [...pack.alertFields] : pack.alertFields,
    standardColumnLabels: entriesOnce<unknown>("standardColumnLabels", pack.standardColumnLabels).map(([k, v]) => [k, cp(v)] as [string, unknown]),
    selfTestCalc: { fn: st0?.fn, args: st0?.args, expect: st0?.expect },
    lexicon: pack.lexicon,
  };

  const keysOf = (rows: readonly (readonly [string, unknown])[]) => rows.map(([k]) => k);
  if (typeof d.id !== "string" || !d.id.trim()) throw new Error("DomainPack.id 必须是非空字符串");
  if (!isStrList(d.stages) || !d.stages.length) throw new Error("DomainPack.stages 必须是非空字符串数组");
  if (!uniq(d.stages)) throw new Error("DomainPack.stages 有重名阶段");
  // 🔴 阶段名会被 `path.join(runDir, "stages", `${s}.json`)` 拼进文件路径 ——
  //    包里写个 `../../etc` 就能穿出运行目录。必须是安全路径段(Codex domainpack-r1 P1)。
  for (const s0 of d.stages) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s0)) throw new Error(`DomainPack.stages 里的 ${JSON.stringify(s0)} 不是安全的路径段(只许字母数字与 _ -,首字符为字母数字,≤64)`);
  }

  assertKeysMatchStages("stageScripts", keysOf(d.stageScripts), d.stages);
  for (const [k, v] of d.stageScripts) {
    for (const key of ["required", "optional"] as const) {
      const arr = v[key];
      if (!Array.isArray(arr) || (!isStrList(arr) && arr.length)) throw new Error(`DomainPack.stageScripts.${k}.${key} 必须是字符串数组`);
    }
  }
  assertKeysMatchStages("stageCalcs", keysOf(d.stageCalcs), d.stages);
  for (const [k, v] of d.stageCalcs) {
    if (!Array.isArray(v) || (!isStrList(v) && v.length)) throw new Error(`DomainPack.stageCalcs.${k} 必须是字符串数组`);
  }
  assertKeysMatchStages("extraTopics", keysOf(d.extraTopics), d.stages);
  for (const [k, v] of d.extraTopics) {
    // 空数组会让该阶段的 extra_findings schema 变成"枚举为空",任何议题都过不了 —— 那是静默失效
    if (!isStrList(v) || !v.length) throw new Error(`DomainPack.extraTopics.${k} 必须非空(该阶段没有议题就写一个"其他线索")`);
  }
  if (!isStrList(d.reportSections) || !d.reportSections.length) throw new Error("DomainPack.reportSections 必须是非空字符串数组");
  if (!uniq(d.reportSections)) throw new Error("DomainPack.reportSections 有重复章节");
  if (!isStrList(d.markets) || !d.markets.length) throw new Error("DomainPack.evidence.markets 必须是非空字符串数组");
  if (!isStrList(d.adjustments) || !d.adjustments.length) throw new Error("DomainPack.evidence.adjustments 必须是非空字符串数组");
  for (const [key, list] of [["marketWideCodes", d.marketWideCodes], ["marketWideOnlyCodes", d.marketWideOnlyCodes]] as const) {
    if (!isStrList(list)) throw new Error(`DomainPack.evidence.${key} 必须是字符串数组`);
    for (const c of list) if (!d.markets.includes(c)) throw new Error(`DomainPack.evidence.${key} 里的 ${c} 不在 markets 中`);
  }
  // "只能是全市场"必然也"可以是全市场";反过来不成立
  for (const c of d.marketWideOnlyCodes as string[]) {
    if (!(d.marketWideCodes as string[]).includes(c)) throw new Error(`DomainPack.evidence.marketWideOnlyCodes 里的 ${c} 不在 marketWideCodes 中`);
  }
  if (!isStrList(d.standardColumns) && (d.standardColumns as unknown[]).length !== 0) throw new Error("DomainPack.standardColumns 必须是字符串数组");
  if (!isStrList(d.criticalScripts) && (d.criticalScripts as unknown[]).length !== 0) throw new Error("DomainPack.criticalScripts 必须是字符串数组");
  // 🔴 跨表引用完整性:关键脚本拼错时,"关键脚本全失败 → 运行 failed" 这条永远匹配不上,
  //    表现为**静默降级**而不是报错(Codex domainpack-r2)。回退计划是这份 pack 自己给的,
  //    所以关键脚本必须至少出现在某个阶段的 required / optional 里。
  const planned = new Set(d.stageScripts.flatMap(([, v]) => [...(v.required as string[]), ...(v.optional as string[])]));
  for (const c of d.criticalScripts as string[]) {
    if (!planned.has(c)) throw new Error(`DomainPack.criticalScripts 里的 ${c} 没出现在任何阶段的取数计划里(拼错了?)`);
  }
  if (!isStrList(d.roles) || !d.roles.length) throw new Error("DomainPack.roles 必须是非空字符串数组");
  if (!uniq(d.roles)) throw new Error("DomainPack.roles 有重复角色");
  // ⚠️ 只查键在不在 stages 里,不要求每个阶段都有槽位 —— 很多阶段本来就没有计算
  for (const [k, v] of d.semanticSlots) {
    if (!d.stages.includes(k)) throw new Error(`DomainPack.semanticSlots 出现了不存在的阶段 ${k}`);
    if (!Array.isArray(v)) throw new Error(`DomainPack.semanticSlots.${k} 必须是数组`);
  }
  if (typeof d.quoteDecision !== "function") throw new Error("DomainPack.quoteDecision 必须是函数");
  if (typeof d.baselinePeriod !== "function") throw new Error("DomainPack.baselinePeriod 必须是函数");
  if (typeof d.selfTestCalc.fn !== "string" || !d.selfTestCalc.fn.trim()
      || !isPlainObject(d.selfTestCalc.args)
      || typeof d.selfTestCalc.expect !== "number" || !Number.isFinite(d.selfTestCalc.expect)) {
    throw new Error("DomainPack.selfTestCalc 需要 { fn: 非空字符串, args: 普通对象, expect: 有限数 }");
  }
  if (!d.stages.includes(d.standardColumnsStage)) throw new Error(`DomainPack.standardColumnsStage ${JSON.stringify(d.standardColumnsStage)} 不是已声明的阶段`);
  assertKeysMatchStages("stageLabels", keysOf(d.stageLabels), d.stages);
  for (const [k, v] of d.stageLabels) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`DomainPack.stageLabels.${k} 必须是非空字符串`);
  }
  // 键必须是**已声明的议题**:拼错的话该议题永远进不了专属章节,而且不会报错(静默失效)。
  // ⚠️ 值**不能**拿 reportSections 去校验 —— 那是必需骨架章节(报告的固定小标题),
  //    而这里的值是**扩展章节**名("资金与市场行为"),两个命名空间(照 Codex 的建议直接查会全判错)。
  const declaredTopics = new Set(d.extraTopics.flatMap(([, v]) => v as string[]));
  for (const [k, v] of d.topicSections) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`DomainPack.topicSections.${k} 必须是非空字符串`);
    if (!declaredTopics.has(k)) throw new Error(`DomainPack.topicSections 里的议题 ${k} 没有出现在任何阶段的 extraTopics 里(拼错了?)`);
  }
  if (!isStrList(d.alertFields) || !d.alertFields.length) throw new Error("DomainPack.alertFields 必须是非空字符串数组");
  const labelKeys = keysOf(d.standardColumnLabels);
  for (const [k, v] of d.standardColumnLabels) {
    if (!(d.standardColumns as string[]).includes(k)) throw new Error(`DomainPack.standardColumnLabels 出现了不存在的列 ${k}`);
    if (typeof v !== "string" || !v.trim()) throw new Error(`DomainPack.standardColumnLabels.${k} 必须是非空字符串`);
  }
  // 缺列标签会让表头静默少一列 —— 补不齐就当场说
  for (const c of d.standardColumns as string[]) {
    if (!labelKeys.includes(c)) throw new Error(`DomainPack.standardColumnLabels 缺列 ${c} 的显示名`);
  }

  const froze = <T>(rows: readonly (readonly [string, T])[], f: (v: T) => unknown) =>
    Object.freeze(Object.fromEntries(rows.map(([k, v]) => [k, f(v)])));
  const draft = {
    id: d.id,
    stages: Object.freeze([...(d.stages as string[])]),
    stageScripts: froze(d.stageScripts, (v) => Object.freeze({
      required: Object.freeze([...(v.required as string[])]), optional: Object.freeze([...(v.optional as string[])]),
    })) as Record<string, StageScripts>,
    criticalScripts: Object.freeze([...(d.criticalScripts as string[])]),
    stageCalcs: froze(d.stageCalcs, (v) => Object.freeze([...(v as string[])])) as Record<string, readonly string[]>,
    extraTopics: froze(d.extraTopics, (v) => Object.freeze([...(v as string[])])) as Record<string, readonly string[]>,
    reportSections: Object.freeze([...(d.reportSections as string[])]),
    evidence: Object.freeze({
      markets: Object.freeze([...(d.markets as string[])]),
      adjustments: Object.freeze([...(d.adjustments as string[])]),
      marketWideCodes: Object.freeze([...(d.marketWideCodes as string[])]),
      marketWideOnlyCodes: Object.freeze([...(d.marketWideOnlyCodes as string[])]),
    }),
    standardColumns: Object.freeze([...(d.standardColumns as string[])]),
    standardColumnsStage: d.standardColumnsStage,
    roles: Object.freeze([...(d.roles as string[])]),
    // 元素也冻一层:只冻数组的话,注册后改 `FINANCE_SLOTS[stage][0]` 仍能改掉 validator 的行为
    // 深冻结:只冻第一层的话,`slot.selector.field = "…"` 仍能改掉 validator 的行为
    semanticSlots: froze(d.semanticSlots, (v) => deepFrozen("semanticSlots", v as unknown[])) as Record<string, readonly unknown[]>,
    quoteDecision: d.quoteDecision,
    baselinePeriod: d.baselinePeriod,
    stageLabels: froze(d.stageLabels, (v) => v) as Record<string, string>,
    topicSections: froze(d.topicSections, (v) => v) as Record<string, string>,
    alertFields: Object.freeze([...(d.alertFields as string[])]),
    standardColumnLabels: froze(d.standardColumnLabels, (v) => v) as Record<string, string>,
    selfTestCalc: Object.freeze({ fn: d.selfTestCalc.fn, args: deepFrozen("selfTestCalc.args", d.selfTestCalc.args as Record<string, unknown>), expect: d.selfTestCalc.expect }),
  };

  // 词表有自己的一套校验(标志、形状、克隆快照)。放在提交之前:它抛错时这里也还没提交,不会半注册。
  // ⚠️ 包里存**词表自己的那份冻结快照**(`currentLexicon()`)而不是原引用 ——
  //    否则 `pack.lexicon` 与 `number_fidelity` 实际在用的会是两个版本。
  setDomainLexicon(d.lexicon);
  const snapshot: DomainPack = Object.freeze({ ...draft, lexicon: currentLexicon() });
  activePack = snapshot;
  registeredSource = pack;
}

/** 当前垂类包;未注册直接抛错(不给静默默认值 —— 那等于让 Core 偷偷藏一份某垂类的配置)。 */
export function currentPack(): DomainPack {
  if (!activePack) throw new Error("未注入 DomainPack:入口处应先调用 registerDomainPack(见 finance/register.ts)");
  return activePack;
}

/** 已注册与否(诊断用;**不要**拿它做"没注册就用默认值"的分支) */
export function hasDomainPack(): boolean { return activePack !== null; }

/** 仅供测试:清掉已注册的包(生产路径不该用) */
export function resetDomainPack(): void {
  // 🔴 词表也要一起清:只清包会留下"包没了、词表还在"的状态,
  //    下一个包注册到词表那步就会失败(Codex domainpack-r1 P2)。
  activePack = null;
  registeredSource = null;
  resetDomainLexicon();
}
