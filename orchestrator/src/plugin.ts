/**
 * **插件契约(Plugin contract)** —— Core 与垂类之间的那条缝。
 *
 * 这是业界通行做法,不是自创:形状上等同 VS Code 扩展清单里的
 * [contribution points](https://code.visualstudio.com/api/references/contribution-points)
 * (扩展在 `package.json` 的 `contributes` 里声明它贡献了什么);
 * 依赖方向上是 Cockburn 的 **Ports & Adapters**(Core 定义 port,插件是 adapter);
 * "同一内核 + 每个垂类一个包"在学界叫 **Software Product Line**(core assets + variation points),
 * 商业上就是 Salesforce Industries 那套(同一个 Customer 360 + 十几个 Industry Cloud)。
 * ⇒ 遇到不确定的地方,**去查这些名字**,别自己发明。
 *
 * 判断一样东西该放哪边,只问一句:**换个垂类它要不要重写?**
 * - 要重写 → 进插件(阶段名、每阶段的取数脚本 / 计算函数 / 议题、报告章节、证据枚举、标准列、词表)
 * - 不用重写 → 留 Core(状态机、校验骨架、证据契约、数字忠实度判定、编排)
 *
 * 🔴 **为什么用注册期校验替代编译期穷尽性检查**:
 * 原来 `Record<Stage, …>` 靠 `Stage` 这个字面量联合类型保证"每个阶段都配齐了"。
 * 一旦阶段名要随垂类变,这个类型就得变成 `string`,穷尽性检查也就没了。
 * ⇒ 改为**注册时逐项核对**。这同样是通行做法:Kubernetes 的 CRD 必须满足 structural schema,
 * 不合格**在注册那一刻就被拒**,而不是等用到时才炸。
 * ⚠️ **别把它说成"完整替代"**:它补回的是"阶段键穷尽性"这一项,
 * 值的类型、跨表引用完整性要靠下面各自的校验,漏了就是漏了。
 *
 * ## 校验分三层(这是刻意的分工)
 *
 * | 层 | 谁做 | 管什么 |
 * |---|---|---|
 * | **形状** | `ajv` + `PLUGIN_SCHEMA` | 字段在不在、类型对不对、非空、去重、阶段名是不是安全路径段 |
 * | **语义关系** | 手写(`checkRelations`) | 键集要与 stages 一致、子集关系、跨表引用 —— **JSON Schema 表达不了** |
 * | **深层 JSON 性** | 手写(`deepFrozen`) | 两个自由形状字段里不许出现 `Map` / `NaN` / `undefined` / 稀疏数组 |
 *
 * 之所以不全用 ajv:JSON Schema 是**逐字段**的,说不了"A 的键必须等于 B 的元素"。
 * 之所以不全手写:形状校验手写又长又容易漏,而仓库里本来就用 ajv 校验证据与 manifest。
 *
 * ⚠️ 与 `providers.ts` 一样**直接用 Ajv 而不走 `schemas.ts`** ——
 * `schemas.ts → config.ts → plugin.ts` 会成环。
 *
 * ⚠️ 注册纪律与词表(`number_fidelity.ts`)是**同一套**:进程级单例、同一份幂等、
 * 换一份当场失败、逐字段各读一次、克隆冻结快照、最后原子提交、重入守卫。
 * 词表是本契约的一个字段,注册插件时一并注册,**只有一个注册点**(避免半初始化)。
 */
import AjvModule from "ajv";

import { applyCoreFormats, assertKnownFormats } from "./formats.ts";
import { currentLexicon, resetLexicon, setLexicon, type Lexicon } from "./number_fidelity.ts";

/** 每阶段的取数脚本:required 全失败 → 阶段不完整;optional 缺失只记 gap */
//: 数组是 `readonly` 的:快照冻结了对象却没冻数组时,消费者一句 `.required.push(…)` 就能改掉
//: 已生效的运行计划。
export interface StageScripts { readonly required: readonly string[]; readonly optional: readonly string[] }

/**
 * 档案的一个**内容块**。Core 备好一组通用渲染器,插件按顺序引用它们 ——
 * 这跟 VS Code 的 `views` / `walkthroughs` 贡献点是同一形状:**声明式引用内置渲染器,不是模板引擎**。
 * 想要现成渲染器覆盖不了的东西,再谈加新 kind,别在配置里塞代码。
 */
export type ArchiveBlock =
  /** 某阶段的 summary,可附带该阶段产物里的若干字段 */
  | { readonly kind: "stageSummary"; readonly stage: string; readonly extras?: readonly { readonly label: string; readonly field: string; readonly fallback?: string }[] }
  /** 关键数据表:这些阶段顶层引用的证据(受 archive.maxFacts 限制;省略 stages = 全部阶段) */
  | { readonly kind: "evidenceTable"; readonly stages?: readonly string[] }
  /** 一行一个阶段的 summary */
  | { readonly kind: "stageSummaries"; readonly stages: readonly string[]; readonly caption?: string }
  /** 标准产出列 → calc id */
  | { readonly kind: "standardColumnsTable" }
  /** 某阶段的 summary + counter_evidence 表 */
  | { readonly kind: "conclusions"; readonly stage: string }
  /** 数据源冲突条数(取自该阶段产物的 source_conflicts) */
  | { readonly kind: "conflictCount"; readonly stage: string }
  /** 某阶段的 decision_points */
  | { readonly kind: "decisionPoints"; readonly stage: string }
  /** 各阶段的 gaps */
  | { readonly kind: "gaps" }
  /** 各阶段的 knowledge_conflicts(对上次档案的裁决) */
  | { readonly kind: "knowledgeConflicts" };

export interface ArchiveSection {
  readonly title: string;
  /** 截断时**优先保留**(档案被召回注入提示词时有长度上限,尾部章节不能被截掉) */
  readonly tail?: boolean;
  /** 没有内容就整节不出现(如"对上次档案的裁决") */
  readonly omitIfEmpty?: boolean;
  readonly blocks: readonly ArchiveBlock[];
}

/** 传给阶段校验器的只读上下文:Core 不知道插件要看什么,把该阶段的产物与运行视图整个给它 */
export interface StageValidationContext {
  readonly stage: string;
  /** 该阶段的产物(已过 schema) */
  readonly output: Record<string, unknown>;
  /** 运行视图(证据 / 计算 / 冲突 / 取数信封等);类型在 validator.ts,这里用结构化最小面避免成环 */
  readonly run: {
    readonly evidenceIds: ReadonlySet<string>;
    readonly calcIds: ReadonlySet<string>;
    readonly conflicts: readonly { field: string; period: string; values: { id: string }[] }[];
    readonly fetch: Readonly<Record<string, { status?: string; extra?: unknown; evidence?: unknown[] }>>;
    readonly runDir: string;
  };
}

/**
 * 取数之后的垂类后处理上下文。Core 每个阶段取数后**无条件调用一次**,由插件自己决定管不管这个阶段 ——
 * 🔴 原本是 Core 里写死 `if (stage === "risk" || stage === "report")` 再直接 import 金融模块(全审 r4-P1)。
 */
export interface AfterFetchContext {
  readonly stage: string;
  readonly runDir: string;
  readonly repoRoot: string;
  /** 登记受保护产物(Core 负责算 sha256 并纳入认证) */
  protect(relPath: string): void;
  /** 往 manifest 写摘要字段。⚠️ 键必须已在 manifest schema 里声明,新垂类要加自己的键得同步改 schema */
  record(key: string, value: unknown): void;
  log(type: string, payload: Record<string, unknown>): void;
}

/** 取数前门控的上下文;返回值 = 本阶段实际要跑的脚本清单 */
export interface BeforeFetchContext {
  readonly stage: string;
  readonly runDir: string;
  readonly repoRoot: string;
  /** 计划里本阶段要跑的脚本 */
  readonly planned: readonly string[];
  /** 注册表端点定义(垂类可能要看端点上的标签来决定跑不跑) */
  readonly endpoints: Readonly<Record<string, unknown>>;
  protect(relPath: string): void;
  record(key: string, value: unknown): void;
  log(type: string, payload: Record<string, unknown>): void;
}

export interface Plugin {
  /** 插件标识,用于报错与诊断("finance" / "restaurant") */
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
     * ⚠️ 与上一条是**两回事**:一个市场可以既允许 MARKET、也允许具体主体;
     * 合并成一条会把"某市场的个体证据"全判成错(实测被既有测试抓到)。
     */
    readonly marketWideOnlyCodes: readonly string[];
  };
  /** 批量摘要的标准列 */
  readonly standardColumns: readonly string[];
  /** 标准列的显示名(批量汇总表头);键必须**恰好**覆盖 standardColumns */
  readonly standardColumnLabels: Readonly<Record<string, string>>;
  /** 标准列住在哪个阶段的产物里(批量汇总从该阶段的 stages/<stage>.json 读) */
  /**
   * **报告阶段**的名字。Core 用它判"本次是否要出报告""哪个阶段产物是报告"等。
   * 🔴 原本 Core 里直接写字面量 `"report"`(全审 r4):换个垂类若把终端阶段叫别的名字,
   * 这些判断会全部落空 —— 而且**纯净度词表看不见英文阶段名**。
   */
  /**
   * **阶段专属的产物字段**:每个阶段在通用骨架之外还要求什么字段(JSON Schema 片段 + 必填名单)。
   *
   * 🔴 全审 r4-P1:原本整段写死在 Core 的 `schemas.ts` 里 —— `if (stage === "profile")` 挂
   * 报价判定与不可替代性标签、`if (stage === "risk")` 挂反证与裁决点。换个垂类时:
   * 它的第一个阶段拿不到该有的字段约束,而契约又强制它提供这些金融概念。
   * ⚠️ 纯净度词表**看不见**这类耦合(英文标识符 + 枚举值),所以它一直是"0 分"下的隐性欠债。
   *
   * Core 只做合并:通用骨架 + 这里声明的 properties / required,不认识任何具体字段名。
   */
  readonly stageSchemas: Readonly<Record<string, { readonly properties: Readonly<Record<string, unknown>>; readonly required: readonly string[] }>>;
  /**
   * **阶段专属的校验**:通用骨架校验之外,该阶段还要核对什么(返回错误清单)。
   * 🔴 全审 r4-P2:原本 `if (stage === "profile")` 核报价新鲜度、`if (stage === "risk")` 核冲突与反证 ——
   * 换个垂类时它自己的阶段即使声明了同类字段也**不会被核验**,而 Core 又会对不存在的阶段名空跑。
   * Core 只负责调用,不认识任何具体字段。
   */
  /** 取数后的垂类后处理(可选)。Core 只负责在每个阶段调用一次,不知道它做什么 */
  readonly afterFetch?: (ctx: AfterFetchContext) => void;
  readonly stageValidators: Readonly<Record<string, (ctx: StageValidationContext) => string[]>>;
  readonly reportStage: string;
  /**
   * **扩展议题的来源阶段**:报告里的扩展章节从哪个阶段产物的 topics 生成。
   * 🔴 原本固定读 `run.stage("risk")` —— 换垂类后那些发现落在别的阶段,报告会**静默漏掉全部扩展章节**。
   */
  readonly topicsSourceStage: string;
  readonly standardColumnsStage: string;
  /** 口径角色(语义槽位按角色解析上游计算) */
  readonly roles: readonly string[];
  /**
   * 语义槽位表:每阶段每个计算函数"输入该怎么选"。
   * Core 只保留**走表的机制**(`validator.ts`),表本身随垂类换。
   */
  readonly semanticSlots: Readonly<Record<string, readonly unknown[]>>;
  /**
   * "数据是否陈旧"的判定 —— **这是插件提供的行为,不只是数据**(Strategy 模式 / SPI)。
   * 什么叫陈旧完全随垂类变,Core 只在该判的时候来问。
   */
  //! 参数用 `unknown`:`RunView` 定义在 `validator.ts`,而本文件不能 import validator
  //! (会成 plugin → validator → plugin 的环)。调用处再收窄类型。
  readonly quoteDecision: (run: unknown) => { decision: string; reason: string };
  /**
   * **运行市场 → 注册表端点的作用域标签**。注册表用 `market: ["CN","US",…]` 标端点适用范围,
   * 而运行时给的市场可能更细(沪深北都归 CN)。这套映射是垂类知识。
   * 🔴 原本写死在 Core 的 `registry.ts`(全审 r4-P1);未知取值必须**抛错,绝不猜**。
   */
  readonly marketRegion: (market: string) => string;
  /**
   * **阶段提示词**与**合规重写提示词**的构造。这是垂类最核心的知识(每个阶段要 agent 做什么)。
   * 🔴 原本 Core 主循环直接 import 金融的 `stages.ts`(全审 r4-P1)——
   * 换个垂类时它的第一个阶段仍会拿到金融阶段提示词。
   */
  readonly buildStagePrompt: (stage: string, cfg: unknown, opts: unknown) => string;
  readonly buildRewritePrompt: (cfg: unknown, hits: unknown) => string;
  /**
   * **取数前的门控**(可选):按垂类标签决定这一阶段实际要跑哪些端点。
   * 🔴 原本 Core 直接 import 金融的 `industry.ts` —— 换垂类时它每次取数都会走产业标签逻辑。
   */
  readonly beforeFetch?: (ctx: BeforeFetchContext) => string[];
  /**
   * **取数执行完之后**对信封做的垂类加工(可选)。与 `afterFetch` 的区别:这个在取数执行器内部、
   * 拿得到本次账本;`afterFetch` 在编排器层面。
   * 🔴 原本 Core 的 `fetchrun.ts` 直接 import 金融的温度计历史(全审 r4-P1)。
   */
  readonly transformFetch?: (cfg: unknown, stage: string, ledger: unknown, log: (t: string, p: Record<string, unknown>) => void) => void;
  /** **归档后**的垂类处理(可选)。原本 Core 直接 import 金融的温度计账本归档。 */
  readonly afterRun?: (ctx: { cfg: unknown; ledger: unknown; record(key: string, value: unknown): void; log(type: string, payload: Record<string, unknown>): void }) => void;
  /** 垂类自己的**体检项**(可选):doctor 会把它们并进报告。原本 doctor 直接 import 金融模块。 */
  readonly doctorChecks?: (ctx: { dataRoot: string; repoRoot: string }) => { id: string; title: string; status: string; detail: string; fix?: string }[];
  /** 基准期(语义槽位里 `fy: "T"` 的那个 T)怎么定 —— 金融看当前财年,别的垂类可能完全不同 */
  readonly baselinePeriod: (run: unknown) => number | null;
  /** 阶段的显示名(进度条 / 日志)。同时是**白名单** —— 只有这些阶段允许被拼进文件路径 */
  readonly stageLabels: Readonly<Record<string, string>>;
  /** 议题 → 报告章节的归并映射(没列的议题不进专属章节,只作全文要求) */
  readonly topicSections: Readonly<Record<string, string>>;
  /** 变化提醒默认盯的证据字段 */
  readonly alertFields: readonly string[];
  /** doctor 的 calc 自检:跑哪个函数、什么入参、期望什么值 */
  /** doctor 的自检计算;垂类若没有确定性计算库,给 `null`(第二垂类验收装置打红) */
  readonly selfTestCalc: { readonly fn: string; readonly args: Readonly<Record<string, unknown>>; readonly expect: number } | null;
  /**
   * 研究档案的模板 —— 章节标题、每节放什么、哪几节在截断时优先保留,全随垂类变。
   * Core 只提供**通用渲染器**与截断 / 脱敏 / 合规 gate。
   */
  readonly archive: {
    /** 档案里的事实多久算过期(召回时据此标 fresh / stale) */
    readonly validDays: number;
    /** 关键数据表最多收几条证据 */
    readonly maxFacts: number;
    readonly sections: readonly ArchiveSection[];
  };
  /**
   * **用户自有台账**的记录种类(可选 —— 不是每个垂类都需要台账)。
   *
   * Core 只提供存储、校验与增删改查(`ledger.ts`);**种类叫什么、每种有哪些字段全在这里声明**。
   * 换个垂类换一套种类,Core 一行不用改。
   *
   * ⚠️ 与研究产物是**两回事**:运行产物是取来的事实(带 raw_ref、可复算),
   * 台账是用户自己写下的东西 —— 它不进证据账本,也不参与数字绑定。
   */
  readonly ledger?: {
    /** 种类名 → 定义。种类名会被拼进文件路径,注册期按安全路径段校验 */
    readonly kinds: Readonly<Record<string, LedgerKindDef>>;
  };
  /** 数字判定用的词表(见 `number_fidelity.ts` 的 `Lexicon`) */
  readonly lexicon: Lexicon;
}

/** 台账里一个记录种类的定义(字段部分;`id`/`kind`/`created_at`/`updated_at` 由 Core 拥有) */
export interface LedgerKindDef {
  /** 显示名(界面用);Core 不解释它 */
  readonly label: string;
  /** 字段:JSON Schema 的 properties 片段 */
  readonly properties: Readonly<Record<string, unknown>>;
  /** 其中哪些必填(必须是 properties 的子集) */
  readonly required: readonly string[];
}

/** Core 拥有的信封键 —— 垂类字段不许与它们重名(注册期校验) */
export const LEDGER_ENVELOPE_KEYS = ["id", "kind", "created_at", "updated_at"] as const;

// ---------- 形状:交给 ajv ----------

const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (o: object) => {
  compile: (s: object) => ((d: unknown) => boolean) & { errors?: { instancePath?: string; message?: string }[] | null };
  addFormat: (name: string, def: { type: "string"; validate: (s: string) => boolean }) => unknown;
};
// `discriminator: true` 让区块的判别式 union 报出精确错误
// (实测:缺参数 → "must have required property 'stage'";未知 kind → "value of tag \"kind\" must be in oneOf")
const ajv = new AjvCtor({ allErrors: true, strict: false, discriminator: true });

/**
 * 非空白字符串。⚠️ **不能只写 `minLength: 1`** —— 那放行纯空格 `" "`,
 * 而旧的手写校验用的是 `trim() !== ""`。迁移时差点把这条弄丢(自查对照旧版清单时才发现)。
 */
const NONBLANK = { type: "string", minLength: 1, pattern: "\\S" };
const strArray = (extra: object = {}) => ({ type: "array", items: NONBLANK, ...extra });
/** 键随垂类而变的表:只约束值的形状 */
const mapOf = (values: object) => ({ type: "object", additionalProperties: values });

/**
 * 阶段名会被 `path.join(runDir, "stages", `${s}.json`)` 拼进文件路径 ——
 * 插件里写个 `../../etc` 就能穿出运行目录。必须是安全路径段。
 */
const STAGE_NAME = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" };

/** 一个内容块的 schema:`kind` 是判别式,每种 kind 各自声明必需参数 */
const blockVariant = (kind: string, props: Record<string, object> = {}, required: string[] = []) => ({
  type: "object", additionalProperties: false,
  required: ["kind", ...required],
  properties: { kind: { const: kind }, ...props },
});
const ARCHIVE_BLOCK = {
  type: "object", required: ["kind"], discriminator: { propertyName: "kind" },
  oneOf: [
    blockVariant("stageSummary", {
      stage: NONBLANK,
      extras: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "field"],
        properties: { label: NONBLANK, field: NONBLANK, fallback: { type: "string" } } } },
    }, ["stage"]),
    blockVariant("evidenceTable", { stages: strArray({ minItems: 1 }) }),
    blockVariant("stageSummaries", { stages: strArray({ minItems: 1 }), caption: { type: "string" } }, ["stages"]),
    blockVariant("standardColumnsTable"),
    blockVariant("conclusions", { stage: NONBLANK }, ["stage"]),
    blockVariant("conflictCount", { stage: NONBLANK }, ["stage"]),
    blockVariant("decisionPoints", { stage: NONBLANK }, ["stage"]),
    blockVariant("gaps"),
    blockVariant("knowledgeConflicts"),
  ],
};

/**
 * 台账种类名会被拼进 `<dataRoot>/ledger/<kind>.json` —— 与阶段名同理,必须是安全路径段。
 * 比 STAGE_NAME 更严(只许小写 + 下划线):它同时是 HTTP 路径段与前端的键,大小写变体只会制造歧义。
 */
const RISKY_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const LEDGER_KIND_NAME = { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" };
const LEDGER = {
  type: "object", additionalProperties: false, required: ["kinds"],
  properties: {
    kinds: {
      type: "object",
      // 键要过 LEDGER_KIND_NAME;ajv 的 propertyNames 就是干这个的
      propertyNames: LEDGER_KIND_NAME,
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["label", "properties", "required"],
        properties: { label: NONBLANK, properties: { type: "object" }, required: strArray({ uniqueItems: true }) },
      },
    },
  },
};

/** 只覆盖**声明式**字段;函数插槽(quoteDecision / baselinePeriod / lexicon)另行手查 */
export const PLUGIN_SCHEMA = {
  type: "object",
  additionalProperties: false,          // 多写一个字段 = 拼错了名字,当场说,别静默忽略
  required: ["id", "stages", "stageScripts", "criticalScripts", "stageCalcs", "extraTopics", "reportSections",
    "evidence", "standardColumns", "standardColumnLabels", "standardColumnsStage", "stageSchemas", "stageValidators", "reportStage", "topicsSourceStage", "roles", "semanticSlots",
    "stageLabels", "topicSections", "alertFields", "selfTestCalc", "archive"],
  properties: {
    id: NONBLANK,
    stages: { type: "array", items: STAGE_NAME, minItems: 1, uniqueItems: true },
    stageScripts: mapOf({
      type: "object", additionalProperties: false, required: ["required", "optional"],
      properties: { required: strArray(), optional: strArray() },
    }),
    criticalScripts: strArray(),
    stageCalcs: mapOf(strArray()),
    // 空数组会让该阶段的 extra_findings schema 变成"枚举为空",任何议题都过不了 —— 那是静默失效
    // ⚠️ 不要求 minItems ≥ 1:阶段完全可以没有扩展议题(餐饮的"菜单"阶段就没有)。
    //    金融包每个阶段恰好都有,于是这条一直没暴露 —— 第二个垂类的验收装置当场打红(全审 r4)。
    extraTopics: mapOf(strArray()),
    reportSections: strArray({ minItems: 1, uniqueItems: true }),
    evidence: {
      type: "object", additionalProperties: false,
      required: ["markets", "adjustments", "marketWideCodes", "marketWideOnlyCodes"],
      properties: {
        markets: strArray({ minItems: 1, uniqueItems: true }),
        adjustments: strArray({ minItems: 1, uniqueItems: true }),
        marketWideCodes: strArray({ uniqueItems: true }),
        marketWideOnlyCodes: strArray({ uniqueItems: true }),
      },
    },
    standardColumns: strArray({ uniqueItems: true }),
    standardColumnLabels: mapOf(NONBLANK),
    standardColumnsStage: STAGE_NAME,
    stageValidators: mapOf({ }),
    stageSchemas: mapOf({ type: "object", additionalProperties: false, required: ["properties", "required"],
      properties: { properties: { type: "object" }, required: strArray() } }),
    reportStage: STAGE_NAME,
    topicsSourceStage: STAGE_NAME,
    // ⚠️ 允许为空:垂类可以没有"计算角色"这个概念(第二垂类验收装置打红)
    roles: strArray({ uniqueItems: true }),
    semanticSlots: mapOf({ type: "array" }),
    stageLabels: mapOf(NONBLANK),
    topicSections: mapOf(NONBLANK),
    // ⚠️ 允许为空:垂类可以没有预警字段
    alertFields: strArray(),
    // 可选:不声明台账的垂类完全合法(第二垂类验收装置里就没有)
    ledger: LEDGER,
    archive: {
      type: "object", additionalProperties: false, required: ["validDays", "maxFacts", "sections"],
      properties: {
        // 上限不是洁癖:没有上限时 `1e100` 也是合法 integer(Number.isInteger 为真、isSafeInteger 为假),
        // 而 recallKnowledge 里 `as_of + validDays 天` 会算出超出 Date 范围的时刻 → **抛 RangeError**(实测)。
        // maxFacts 的上限按 KNOWLEDGE_MAX_CHARS 定:一行约 100 字符,再多也塞不进召回预算,写大了只是自欺。
        validDays: { type: "integer", minimum: 1, maximum: 3650 },
        maxFacts: { type: "integer", minimum: 1, maximum: 1000 },
        sections: {
          type: "array", minItems: 1,
          items: {
            type: "object", additionalProperties: false, required: ["title", "blocks"],
            properties: {
              title: NONBLANK, tail: { type: "boolean" }, omitIfEmpty: { type: "boolean" },
              blocks: { type: "array", minItems: 1, items: ARCHIVE_BLOCK },
            },
          },
        },
      },
    },
    // ⚠️ 允许 null:垂类可以没有确定性计算库,那就没有自检计算(第二垂类验收装置打红)。
    // 🔴 不能写成 `type: ["object","null"]` —— ajv 的 `required` 对 null 仍会判缺字段(实测)。
    selfTestCalc: {
      oneOf: [
        { type: "null" },
        {
          type: "object", additionalProperties: false, required: ["fn", "args", "expect"],
          properties: {
            fn: NONBLANK,
            args: { type: "object" },
            // 🔴 **ajv v8 的 `type: "number"` 接受 NaN 与 Infinity**(实测 8.20.0,ajv v6 才带有限性检查)。
            //    所以有限性要在 `checkRelations` 里手查 —— 别照旧版行为想当然。
            expect: { type: "number" },
          },
        },
      ],
    },
  },
} as const;

const validateShape = ajv.compile(PLUGIN_SCHEMA as object);

// ---------- 状态 ----------

let active: Plugin | null = null;
/** 注册时传进来的原始对象 —— 只用于"是不是同一份"的身份判断(活动插件本身是冻结快照) */
let registeredSource: Plugin | null = null;
let registering = false;

/** 普通记录:`new Map()` / `new Date()` 展开后会静默变成 `{}`,与"通过校验的那个值"不是一回事 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function mapValues<T, R>(obj: Record<string, T>, f: (v: T, k: string) => R): Record<string, R> {
  const out: Record<string, R> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = f(v, k);
  return out;
}

/**
 * 会跟对象原型打架的键。**作为契约表的键**出现时直接拒。
 * ⚠️ 别把这句说宽了:自由形状字段(`semanticSlots` 元素 / `selfTestCalc.args`)的**深层**对象里
 * 仍允许这些键 —— 那条路径走 `deepFrozen`,容器是 `Object.create(null)`,不会被吞也不会污染原型。
 *
 * 🔴 为什么必须拦:往普通 `{}` 上写 `out["__proto__"] = …` 会触发原型 setter,
 * 那个键**不会成为自有属性**,于是整条配置被静默吞掉 ——
 * `semanticSlots: {"__proto__": []}` 变成空表,"键必须 ∈ stages" 就在空集上平凡通过(Codex ajv-r1 P2)。
 * ⚠️ 另一条路是全程用 `Object.create(null)` 当容器,**实测代价太大**:
 * 那会把 `currentPlugin()` 返回的字典变成无原型对象,`assert.deepEqual` 与任何比较原型的消费者当场炸
 * (三个既有测试打红)。拒键更简单,报错也更直白。
 */
const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * 原对象上不许有契约之外的字段。
 *
 * 🔴 ajv 的 `additionalProperties: false` **看不到它们** —— 校验的是投影出来的 `decl`,
 * 多余字段在进 ajv 之前就被投影丢掉了。所以"多写一个字段就当场说"这句话,
 * 得靠这里显式比对键集才成立(Codex ajv-r1 P1)。
 */
function assertNoExtraKeys(what: string, obj: unknown, allowed: readonly string[]): void {
  if (!isPlainObject(obj)) return;               // 类型错由 ajv / tableOnce 各自报
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`Plugin${what ? "." + what : ""} 有契约之外的字段:${extra.join(" / ")}(拼错了?)`);
}

/**
 * 把一张表的键值**各读一次**,之后只用这份拷贝。
 *
 * 🔴 `Object.entries(obj)` 每调一次就会把所有 getter 再跑一遍 —— 校验时给合法值、
 * 建快照时换一个,未经校验的内容就进了活动插件。
 * 🔴 非法类型要抛,**不能吞成空表** —— 空表会让"键集与 stages 一致"这类检查在空集上平凡通过。
 */
function tableOnce(what: string, obj: unknown): Record<string, unknown> {
  if (!isPlainObject(obj)) throw new Error(`Plugin.${what} 必须是普通对象`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (UNSAFE_KEYS.includes(k)) throw new Error(`Plugin.${what} 不许用 ${k} 作键(它会与对象原型打架,写进普通对象时会被静默吞掉)`);
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

/**
 * 深拷贝 + 深冻结。**只接受 JSON 式的值**:原始值 / 普通对象 / 数组;
 * 碰到 `Map` / `Set` / `Date` / 类实例 / 函数 / `undefined` / `NaN` / 稀疏数组一律抛错。
 *
 * 🔴 为什么要拒而不是"原样返回":原样返回的那个对象是**共享可变引用**,
 * 注册后 `shared.set(…)` 就能改掉已生效的配置,"深冻结"这句声称就是假的。
 * ⚠️ 会不会误拒正当配置?不会 —— 用到它的两个字段本来就必须是 JSON 式:
 * 槽位是纯配置数据,而 `selfTestCalc.args` 要 `JSON.stringify` 后传给 calc CLI
 * (往里放 `Map` 本来就会被序列化成 `{}`,是个坏配置)。
 * ⚠️ 这一层 ajv 替不了:那两个字段是**自由形状**,JSON Schema 管不到里面每一个叶子。
 */
function deepFrozen<T>(what: string, v: T): T {
  if (v === null) return v;
  const t = typeof v;
  // `undefined` / `NaN` / `Infinity` 不是 JSON 值:`JSON.stringify` 会把它们悄悄变成消失 / `null`
  if (v === undefined) throw new Error(`Plugin.${what} 不能是 undefined(JSON 序列化时会消失)`);
  if (t === "number" && !Number.isFinite(v as number)) throw new Error(`Plugin.${what} 不能是 NaN / Infinity(JSON 序列化时会变成 null)`);
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) {
    // ⚠️ 检查**不能写在 `.map()` 回调里** —— 回调对空洞压根不执行,等于检查没跑(我就这么错了一次)
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) throw new Error(`Plugin.${what}[${i}] 是数组空洞(稀疏数组,JSON 序列化时会变成 null)`);
      out.push(deepFrozen(`${what}[${i}]`, v[i]));
    }
    return Object.freeze(out) as unknown as T;
  }
  if (isPlainObject(v)) {
    // 🔴 用 `Object.create(null)`:往普通 `{}` 上写 `out["__proto__"] = …` 会触发原型 setter,
    //    不会建立同名自有属性 —— 一个 `JSON.parse('{"__proto__":{…}}')` 就能让快照内容被改掉。
    // ⚠️ 代价:这些对象**没有原型成员**。`JSON.stringify` / 展开 / `Object.keys` / `in` /
    //    `Object.hasOwn` 都正常,但 `obj.hasOwnProperty(…)` / `obj.toString()` 会炸。
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, x] of Object.entries(v)) out[k] = deepFrozen(`${what}.${k}`, x);
    return Object.freeze(out) as unknown as T;
  }
  throw new Error(`Plugin.${what} 只能是 JSON 式的值(原始值 / 普通对象 / 数组),收到 ${Object.prototype.toString.call(v)}`);
}

/** 键集必须与阶段集**完全一致**:缺一个 = 该阶段没人管;多一个 = 名字写错了却没人告诉你 */
function assertKeysMatchStages(what: string, rawKeys: readonly string[], stages: readonly string[]): void {
  const keys = [...rawKeys].sort();
  const want = [...stages].sort();
  const missing = want.filter((s) => !keys.includes(s));
  const extra = keys.filter((k) => !want.includes(k));
  if (missing.length || extra.length) {
    throw new Error(`Plugin.${what} 的键必须与 stages 完全一致`
      + (missing.length ? `;缺少 ${missing.join(" / ")}` : "")
      + (extra.length ? `;多出 ${extra.join(" / ")}` : ""));
  }
}

interface Decl {
  id: string;
  stages: string[];
  stageScripts: Record<string, { required: string[]; optional: string[] }>;
  criticalScripts: string[];
  stageCalcs: Record<string, string[]>;
  extraTopics: Record<string, string[]>;
  reportSections: string[];
  evidence: { markets: string[]; adjustments: string[]; marketWideCodes: string[]; marketWideOnlyCodes: string[] };
  standardColumns: string[];
  standardColumnLabels: Record<string, string>;
  standardColumnsStage: string;
  stageSchemas: Record<string, { properties: Record<string, unknown>; required: string[] }>;
  stageValidators: Record<string, (ctx: StageValidationContext) => string[]>;
  reportStage: string;
  topicsSourceStage: string;
  roles: string[];
  semanticSlots: Record<string, unknown[]>;
  stageLabels: Record<string, string>;
  topicSections: Record<string, string>;
  alertFields: string[];
  selfTestCalc: { fn: string; args: Record<string, unknown>; expect: number } | null;
  ledger?: { kinds: Record<string, { label: string; properties: Record<string, unknown>; required: string[] }> };
  archive: Plugin["archive"];
}

/**
 * 语义关系校验 —— **JSON Schema 表达不了的那部分**。
 * 它是逐字段的,说不了"A 的键必须等于 B 的元素""X 必须是 Y 的子集"。
 */
function checkRelations(d: Decl): void {
  for (const what of ["stageScripts", "stageCalcs", "extraTopics", "stageLabels"] as const) {
    assertKeysMatchStages(what, Object.keys(d[what]), d.stages);
  }
  // ⚠️ 只查键在不在 stages 里,不要求每个阶段都有槽位 —— 很多阶段本来就没有计算
  for (const k of Object.keys(d.semanticSlots)) {
    if (!d.stages.includes(k)) throw new Error(`Plugin.semanticSlots 出现了不存在的阶段 ${k}`);
  }
  if (!d.stages.includes(d.standardColumnsStage)) throw new Error(`Plugin.standardColumnsStage ${JSON.stringify(d.standardColumnsStage)} 不是已声明的阶段`);
  for (const key of ["stageSchemas", "stageValidators"] as const) {
    for (const st of Object.keys(d[key])) {
      if (!d.stages.includes(st)) throw new Error(`Plugin.${key} 出现了不存在的阶段 ${st}`);
    }
  }
  // 🔴 值也要校验,否则是典型的"注册期能过、运行期才炸"(修复复审 r1-P1-1 / P1-2):
  //    · stageValidators 的值若不是函数 → 跑到该阶段才 TypeError;
  //    · stageSchemas 的内层若不是合法 JSON Schema → 首次编译该阶段 schema 时整轮异常退出。
  for (const [st, fn] of Object.entries(d.stageValidators)) {
    if (typeof fn !== "function") throw new Error(`Plugin.stageValidators.${st} 必须是函数,收到 ${typeof fn}`);
  }
  for (const [st, ext] of Object.entries(d.stageSchemas)) {
    // ⚠️ 明确禁止 `$ref`:注册期只能拿扩展这一块当根去编译,而运行期的根是**合并后**的完整 schema
    //    ⇒ 指向核心字段的 `$ref`(如 `#/properties/summary`)在注册期解析不了、会被**误拒**;
    //    要真支持就得在注册期复刻合并逻辑,而合并的另一半此时还没注册完(修复复审 r2-P2-1)。
    //    跨扩展边界引用本身也脆:核心骨架一改,插件的引用就悄悄指向别处。
    if (JSON.stringify(ext.properties).includes('"$ref"')) {
      throw new Error(`Plugin.stageSchemas.${st} 不支持 $ref —— 注册期无法解析跨核心骨架的引用,请把片段展开写全`);
    }
    // 🔴 与 ledger 那处**同一根因**:未知 format 被 ajv 静默忽略。上一轮只改了 ledger 一处,
    //    这个兄弟编译点漏了 ⇒ 阶段产物里写 `format: "date"` 等于没写、拼错成 "data" 也照样注册成功。
    assertKnownFormats(`Plugin.stageSchemas.${st}`, ext.properties);
    try {
      applyCoreFormats(new AjvCtor({ allErrors: true, strict: false })).compile({ type: "object", properties: ext.properties, required: [...ext.required] });
    } catch (e) {
      throw new Error(`Plugin.stageSchemas.${st} 不是合法 JSON Schema(注册期编译失败,否则会拖到首次运行才炸):${e instanceof Error ? e.message : String(e)}`);
    }
    for (const k of ext.required) {
      if (!(k in ext.properties)) throw new Error(`Plugin.stageSchemas.${st}.required 里的 ${k} 没有对应的 properties 定义`);
    }
  }
  for (const k of ["reportStage", "topicsSourceStage"] as const) {
    if (!d.stages.includes(d[k])) throw new Error(`Plugin.${k} ${JSON.stringify(d[k])} 不是已声明的阶段`);
  }
  if (d.stages[d.stages.length - 1] !== d.reportStage) throw new Error(`Plugin.reportStage 必须是 stages 的最后一个阶段(报告要在别的阶段都跑完之后出):stages 末位是 ${JSON.stringify(d.stages[d.stages.length - 1])}`);
  // ⚠️ 这条严格说属于**形状层**,只因 ajv v8 收 NaN / Infinity 才落在这里(见 PLUGIN_SCHEMA 的说明)
  if (d.selfTestCalc && !Number.isFinite(d.selfTestCalc.expect)) throw new Error("Plugin.selfTestCalc.expect 必须是有限数(不能是 NaN / Infinity)");

  for (const key of ["marketWideCodes", "marketWideOnlyCodes"] as const) {
    for (const c of d.evidence[key]) if (!d.evidence.markets.includes(c)) throw new Error(`Plugin.evidence.${key} 里的 ${c} 不在 markets 中`);
  }
  // "只能是全市场"必然也"可以是全市场";反过来不成立
  for (const c of d.evidence.marketWideOnlyCodes) {
    if (!d.evidence.marketWideCodes.includes(c)) throw new Error(`Plugin.evidence.marketWideOnlyCodes 里的 ${c} 不在 marketWideCodes 中`);
  }
  // 🔴 关键脚本拼错时,"关键脚本全失败 → 运行 failed" 这条永远匹配不上,表现为**静默降级**而不是报错。
  //    回退计划是这份插件自己给的,所以关键脚本必须至少出现在某个阶段的 required / optional 里。
  const planned = new Set(Object.values(d.stageScripts).flatMap((v) => [...v.required, ...v.optional]));
  for (const c of d.criticalScripts) {
    if (!planned.has(c)) throw new Error(`Plugin.criticalScripts 里的 ${c} 没出现在任何阶段的取数计划里(拼错了?)`);
  }
  // 缺列标签会让表头静默少一列 —— 补不齐就当场说
  for (const k of Object.keys(d.standardColumnLabels)) {
    if (!d.standardColumns.includes(k)) throw new Error(`Plugin.standardColumnLabels 出现了不存在的列 ${k}`);
  }
  for (const c of d.standardColumns) {
    if (!(c in d.standardColumnLabels)) throw new Error(`Plugin.standardColumnLabels 缺列 ${c} 的显示名`);
  }
  // 键必须是**已声明的议题**:拼错的话该议题永远进不了专属章节,而且不会报错(静默失效)。
  // ⚠️ 值**不能**拿 reportSections 去校验 —— 那是必需骨架章节(报告的固定小标题),
  //    而这里的值是**扩展章节**名("资金与市场行为"),两个命名空间(照字面查会全判错)。
  // 档案模板里引用的阶段必须真的存在 —— 拼错的话该节会静默空着(JSON Schema 说不了"这个字符串得是别处的元素")
  for (const [i, sec] of d.archive.sections.entries()) {
    for (const b of sec.blocks) {
      const refs: readonly string[] = "stage" in b ? [b.stage] : ("stages" in b && b.stages) ? b.stages : [];
      for (const r of refs) {
        if (!d.stages.includes(r)) throw new Error(`Plugin.archive.sections[${i}](${sec.title})的 ${b.kind} 引用了不存在的阶段 ${r}`);
      }
    }
  }
  // tail 必须是**连续后缀**:截断只认"第一个 tail 到结尾"这一段,中间夹一个 tail 会把它后面的普通章节
  // 一起当尾部保护(而且不报错)。在这里拒掉,渲染 / 截断两侧就都不用处理交错情形。
  const firstTail = d.archive.sections.findIndex((sec) => sec.tail);
  if (firstTail >= 0 && !d.archive.sections.slice(firstTail).every((sec) => sec.tail)) {
    throw new Error(`Plugin.archive.sections 的 tail 章节必须是连续的结尾几节(第 ${firstTail} 节起出现了非 tail 章节)`);
  }
  if (!d.archive.sections.some((sec) => sec.tail)) {
    // 一节都不标 tail,截断时"优先保留"就没有意义 —— 裁决点 / 缺口会被一起截掉
    throw new Error("Plugin.archive.sections 至少要有一节标 tail: true(截断时优先保留)");
  }
  const declaredTopics = new Set(Object.values(d.extraTopics).flat());
  for (const k of Object.keys(d.topicSections)) {
    if (!declaredTopics.has(k)) throw new Error(`Plugin.topicSections 里的议题 ${k} 没有出现在任何阶段的 extraTopics 里(拼错了?)`);
  }
  // 台账:与 stageSchemas 同样的三条 —— required ⊆ properties、片段真能编译、不许 $ref。
  // 🔴 少了"注册期编译"这一条,一个写错的字段 schema 会拖到**用户第一次点保存**才炸,
  //    而那时他刚写完一条记录 —— 最糟的时机。
  for (const [kind, def] of Object.entries(d.ledger?.kinds ?? {})) {
    // 🔴 pattern 挡不住 `constructor` / `prototype`(它们本身就是小写字母)。
    //    作为文件名它们无害,但作为**对象键**会和原型打架:普通 `{}` 上 `obj["constructor"]`
    //    在键不存在时返回构造函数(truthy),任何用"取值判真"当守卫的地方都会被它绕过。
    if (RISKY_KEYS.has(kind)) throw new Error(`Plugin.ledger.kinds 不能用 ${kind} 当种类名(与对象原型成员重名)`);
    for (const k of LEDGER_ENVELOPE_KEYS) {
      if (k in def.properties) throw new Error(`Plugin.ledger.kinds.${kind} 的字段 ${k} 与 Core 的信封字段重名(Core 拥有 ${LEDGER_ENVELOPE_KEYS.join(" / ")})`);
    }
    for (const k of def.required) {
      if (!(k in def.properties)) throw new Error(`Plugin.ledger.kinds.${kind}.required 里的 ${k} 没有对应的 properties 定义`);
    }
    if (JSON.stringify(def.properties).includes('"$ref"')) {
      throw new Error(`Plugin.ledger.kinds.${kind} 不支持 $ref —— 请把片段展开写全`);
    }
    // 🔴 未知 format 会被 ajv **静默忽略** —— 字段上写着 `format: "xxx"`,校验却什么都没做。
    //    注册期认不出来就当场拒,别让"写了等于没写"混过去。
    assertKnownFormats(`Plugin.ledger.kinds.${kind}`, def.properties);
    try {
      // 编译时装上 Core 的 format,否则这里的"能编译"证明不了运行时那份能校验(两处口径不同)
      applyCoreFormats(new AjvCtor({ allErrors: true, strict: false })).compile({ type: "object", properties: def.properties, required: [...def.required] });
    } catch (e) {
      throw new Error(`Plugin.ledger.kinds.${kind} 不是合法 JSON Schema(注册期编译失败,否则会拖到用户第一次保存才炸):${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * 注册插件。**同一进程只允许一份**;同一份幂等,换一份当场抛错。
 *
 * ⚠️ 进程级单例是**刻意的**:产品形态是"一个垂类一个仓库、一个安装包、一个进程"。
 * 要同进程多租户(一个服务同时跑金融与餐饮请求)才需要实例级容器,那是另一件事。
 */
export function registerPlugin(plugin: Plugin): void {
  if (registering) throw new Error("registerPlugin 不支持重入(注册过程中不许再次注册)");
  registering = true;
  try {
    register(plugin);
  } finally {
    registering = false;
  }
}

function register(plugin: Plugin): void {
  if (registeredSource === plugin) return;               // 真幂等:身份判断在所有校验之前
  if (registeredSource) {
    throw new Error(`已注册过插件 ${active?.id ?? "?"}:进程级单例不支持多垂类并存,请在各自进程 / composition root 里注入`);
  }
  // 🔴 **每个字段在这里各读一次,之后校验与冻结只用读到的那份。**
  //    声明式字段进 `decl`,函数插槽与词表进局部变量(它们不进 JSON Schema)——
  //    合起来才是"整棵配置",别只看 `decl` 就以为读全了。
  //    插件若是带 getter 的对象 / Proxy,任何"读第二次"都可能拿到另一个值。
  const st = plugin.selfTestCalc as { fn?: unknown; args?: unknown; expect?: unknown } | undefined;
  const ev = plugin.evidence as Partial<Plugin["evidence"]> | undefined;
  const cp = (v: unknown) => (Array.isArray(v) ? [...v] : v);
  // 🔴 函数插槽也**只读一次**:先校验 `plugin.quoteDecision` 再从 `plugin.quoteDecision` 建快照,
  //    带 getter 的插件就能第一次给函数、第二次给字符串(Codex ajv-r1 P1)。
  const quoteDecision = plugin.quoteDecision;
  const marketRegion = plugin.marketRegion;
  const transformFetch = plugin.transformFetch;
  if (transformFetch !== undefined && typeof transformFetch !== "function") throw new Error("Plugin.transformFetch 必须是函数或不提供");
  const afterRun = plugin.afterRun;
  if (afterRun !== undefined && typeof afterRun !== "function") throw new Error("Plugin.afterRun 必须是函数或不提供");
  const doctorChecks = plugin.doctorChecks;
  if (doctorChecks !== undefined && typeof doctorChecks !== "function") throw new Error("Plugin.doctorChecks 必须是函数或不提供");
  const beforeFetch = plugin.beforeFetch;
  if (beforeFetch !== undefined && typeof beforeFetch !== "function") throw new Error("Plugin.beforeFetch 必须是函数或不提供");
  const buildRewritePrompt = plugin.buildRewritePrompt;
  const buildStagePrompt = plugin.buildStagePrompt;
  // 可选函数插槽:同样**只读一次**,且不进 ajv 投影(那里 additionalProperties:false,函数过不去)
  const afterFetch = plugin.afterFetch;
  if (afterFetch !== undefined && typeof afterFetch !== "function") throw new Error("Plugin.afterFetch 必须是函数或不提供");
  const baselinePeriod = plugin.baselinePeriod;
  const lexicon = plugin.lexicon;
  // 🔴 `stageScripts` 也只读一次:多余字段检查与 decl 投影**共用这一份**。
  //    我一度让检查再 `tableOnce(plugin.stageScripts)` 一遍 —— 同一个根因第三次犯(Codex ajv-r2)。
  const rawScripts = tableOnce("stageScripts", plugin.stageScripts);
  const rawLedger = plugin.ledger;
  const decl = {
    id: plugin.id,
    stages: cp(plugin.stages),
    stageScripts: mapValues(rawScripts, (v) =>
      isPlainObject(v) ? { required: cp(v.required), optional: cp(v.optional) } : v),
    criticalScripts: cp(plugin.criticalScripts),
    stageCalcs: tableOnce("stageCalcs", plugin.stageCalcs),
    extraTopics: tableOnce("extraTopics", plugin.extraTopics),
    reportSections: cp(plugin.reportSections),
    evidence: {
      markets: cp(ev?.markets), adjustments: cp(ev?.adjustments),
      marketWideCodes: cp(ev?.marketWideCodes), marketWideOnlyCodes: cp(ev?.marketWideOnlyCodes),
    },
    standardColumns: cp(plugin.standardColumns),
    standardColumnLabels: tableOnce("standardColumnLabels", plugin.standardColumnLabels),
    standardColumnsStage: plugin.standardColumnsStage,
    stageSchemas: deepFrozen("stageSchemas", plugin.stageSchemas),
    stageValidators: tableOnce("stageValidators", plugin.stageValidators),
    reportStage: plugin.reportStage,
    topicsSourceStage: plugin.topicsSourceStage,
    roles: cp(plugin.roles),
    semanticSlots: tableOnce("semanticSlots", plugin.semanticSlots),
    stageLabels: tableOnce("stageLabels", plugin.stageLabels),
    topicSections: tableOnce("topicSections", plugin.topicSections),
    alertFields: cp(plugin.alertFields),
    // null(垂类没有确定性计算库)要原样传给 ajv —— 拆成 { fn: undefined } 会被判成"缺字段的对象"
    selfTestCalc: st == null ? null : { fn: st.fn, args: st.args, expect: st.expect },
    // 台账种类表:**只读一次**,而且只在真的声明了才放进 decl ——
    // ajv 在 additionalProperties:false 下会把"键存在但值是 undefined"当成一个类型不对的字段。
    ...(rawLedger === undefined ? {} : { ledger: deepFrozen("ledger", rawLedger) }),
    // 档案模板整棵**深拷贝一次**:它是纯声明数据,后面既要校验又要进快照
    archive: deepFrozen("archive", plugin.archive),
  };
  // 函数插槽 JSON Schema 表达不了,单独查(放在 ajv 之前:类型错时先给出更直白的信息)
  for (const [k, fn] of [["quoteDecision", quoteDecision], ["baselinePeriod", baselinePeriod], ["marketRegion", marketRegion], ["buildStagePrompt", buildStagePrompt], ["buildRewritePrompt", buildRewritePrompt]] as const) {
    if (typeof fn !== "function") throw new Error(`Plugin.${k} 必须是函数`);
  }
  // ⓪ 原对象的键集:ajv 只看得到投影后的 `decl`,多余字段得在这里比
  assertNoExtraKeys("", plugin, [...(PLUGIN_SCHEMA.required as readonly string[]), "quoteDecision", "baselinePeriod", "marketRegion", "buildStagePrompt", "buildRewritePrompt", "lexicon", "afterFetch", "beforeFetch", "transformFetch", "afterRun", "doctorChecks", "ledger"]);
  assertNoExtraKeys("evidence", ev, ["markets", "adjustments", "marketWideCodes", "marketWideOnlyCodes"]);
  assertNoExtraKeys("selfTestCalc", st, ["fn", "args", "expect"]);
  assertNoExtraKeys("archive", decl.archive, ["validDays", "maxFacts", "sections"]);
  if (rawLedger !== undefined) {
    assertNoExtraKeys("ledger", rawLedger, ["kinds"]);
    for (const [k, v] of Object.entries((decl as { ledger?: { kinds: Record<string, unknown> } }).ledger?.kinds ?? {})) {
      assertNoExtraKeys(`ledger.kinds.${k}`, v, ["label", "properties", "required"]);
    }
  }
  for (const [k, v] of Object.entries(rawScripts)) {
    assertNoExtraKeys(`stageScripts.${k}`, v, ["required", "optional"]);
  }
  // ① 形状:ajv
  if (!validateShape(decl)) {
    const msg = (validateShape.errors ?? []).slice(0, 4)
      .map((e) => `${e.instancePath || "(根)"} ${e.message ?? ""}`.trim()).join(";");
    throw new Error(`Plugin 不符契约:${msg}`);
  }
  const d = decl as unknown as Decl;
  // ② 语义关系:手写
  checkRelations(d);
  // ③ 自由形状字段的深层 JSON 性 + 深冻结
  const slots = mapValues(d.semanticSlots, (v, k) => deepFrozen(`semanticSlots.${k}`, v)) as Record<string, readonly unknown[]>;
  const args = d.selfTestCalc ? deepFrozen("selfTestCalc.args", d.selfTestCalc.args) : null;

  const draft = {
    id: d.id,
    stages: Object.freeze([...d.stages]),
    stageScripts: mapValues(d.stageScripts, (v) => Object.freeze({
      required: Object.freeze([...v.required]), optional: Object.freeze([...v.optional]),
    })) as Record<string, StageScripts>,
    criticalScripts: Object.freeze([...d.criticalScripts]),
    stageCalcs: mapValues(d.stageCalcs, (v) => Object.freeze([...v])) as Record<string, readonly string[]>,
    extraTopics: mapValues(d.extraTopics, (v) => Object.freeze([...v])) as Record<string, readonly string[]>,
    reportSections: Object.freeze([...d.reportSections]),
    evidence: Object.freeze({
      markets: Object.freeze([...d.evidence.markets]),
      adjustments: Object.freeze([...d.evidence.adjustments]),
      marketWideCodes: Object.freeze([...d.evidence.marketWideCodes]),
      marketWideOnlyCodes: Object.freeze([...d.evidence.marketWideOnlyCodes]),
    }),
    standardColumns: Object.freeze([...d.standardColumns]),
    standardColumnLabels: Object.freeze({ ...d.standardColumnLabels }),
    standardColumnsStage: d.standardColumnsStage,
    stageSchemas: d.stageSchemas,
    stageValidators: d.stageValidators,
    afterFetch,
    reportStage: d.reportStage,
    topicsSourceStage: d.topicsSourceStage,
    roles: Object.freeze([...d.roles]),
    semanticSlots: Object.freeze(slots),
    quoteDecision,
    marketRegion,
    buildStagePrompt,
    buildRewritePrompt,
    beforeFetch,
    transformFetch,
    afterRun,
    doctorChecks,
    baselinePeriod,
    stageLabels: Object.freeze({ ...d.stageLabels }),
    topicSections: Object.freeze({ ...d.topicSections }),
    alertFields: Object.freeze([...d.alertFields]),
    selfTestCalc: d.selfTestCalc ? Object.freeze({ fn: d.selfTestCalc.fn, args: args as Record<string, unknown>, expect: d.selfTestCalc.expect }) : null,
    // 摄入时已 deepFrozen;没声明就整个不带这个键(消费方一律走 `?.`)
    ...(d.ledger === undefined ? {} : { ledger: d.ledger }),
    archive: d.archive,          // 摄入时已 deepFrozen
  };

  // 词表有自己的一套校验(标志、形状、克隆快照)。放在提交之前:它抛错时这里也还没提交,不会半注册。
  // ⚠️ 插件里存**词表自己的那份冻结快照**(`currentLexicon()`)而不是原引用 ——
  //    否则 `plugin.lexicon` 与 `number_fidelity` 实际在用的会是两个版本。
  setLexicon(lexicon);
  const snapshot: Plugin = Object.freeze({ ...draft, lexicon: currentLexicon() });
  active = snapshot;
  registeredSource = plugin;
}

/** 当前插件;未注册直接抛错(不给静默默认值 —— 那等于让 Core 偷偷藏一份某垂类的配置)。 */
export function currentPlugin(): Plugin {
  if (!active) throw new Error("未注入插件:入口处应先调用 registerPlugin(见 finance/register.ts)");
  return active;
}

/** 已注册与否(诊断用;**不要**拿它做"没注册就用默认值"的分支) */
export function hasPlugin(): boolean { return active !== null; }

/** 仅供测试:清掉已注册的插件(生产路径不该用) */
export function resetPlugin(): void {
  // 🔴 词表也要一起清:只清插件会留下"插件没了、词表还在"的状态,下一个插件注册到词表那步就会失败。
  active = null;
  registeredSource = null;
  resetLexicon();
}
