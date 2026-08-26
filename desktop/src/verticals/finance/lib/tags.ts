/**
 * **研究 tag 表**:板块中心打开就该看到的那几条线,以及每条线下面的标的池。
 *
 * 🔴 为什么是**固定表**而不是"跟着研究运行走":跟着运行走的话,新用户打开是空的 ——
 *    而这一页的作用恰恰是"让你一眼看到自己在跟的几条线"。空壳教不会人这一页是干嘛的。
 *    ⇒ 随产品发一份默认表;日后要支持用户增删,那属于用户配置(台账),不在这里。
 *
 * ⚠️ **这里只是"我在跟哪些线"的清单,不是推荐**。标的池 = 该 tag 下值得盯的对象,
 *    不含任何"该不该买"的意思;行情与估值仍然只从取数层来。
 *
 * ⚠️ 与后端 `datasources/industry_tags.json` 是**两件事**,别混:
 *    那边只有 2 个标签,决定"研究某只标的时要不要挂产业温度计";
 *    这里决定"板块中心怎么分组显示"。
 */

export interface ResearchTag {
  id: string;
  label: string;
  /** 一句话:这条线在看什么 */
  intent: string;
  /** 该 tag 下的标的池。代码用于取行情,名字用于显示 */
  symbols: { code: string; name: string }[];
  /**
   * 产业链环节(只有环节名,不挂标的)。
   * 🔴 **只抄已核实过的**。开源版 `sectors.json` 里 19 个板块只有 2 个 `verified: true`,
   *    那份文件自己写着"禁止靠模型记忆编" —— 这里照办:没核实过的**留空并标 false**,
   *    界面上如实说"还没核实",而不是编一串看着很像的环节名。
   */
  nodes: string[];
  /** 上面那串环节是不是核实过的。false = 还没做,界面要说出来 */
  nodesVerified: boolean;
}

export const RESEARCH_TAGS: ResearchTag[] = [
  {
    id: "humanoid",
    nodes: ["谐波减速器", "行星滚柱丝杠", "无框力矩电机", "灵巧手", "六维力传感器", "具身大模型"],
    nodesVerified: true,
    label: "人形机器人",
    intent: "本体量产节奏 → 零部件放量;卡口在高精度关节与丝杠",
    symbols: [
      { code: "688017", name: "绿的谐波" },
      { code: "002050", name: "三花智控" },
      { code: "601689", name: "拓普集团" },
      { code: "300124", name: "汇川技术" },
    ],
  },
  {
    id: "ai_compute",
    nodes: ["AI芯片", "光模块", "CPO光互连", "HBM存储", "先进封装", "PCB", "液冷散热"],
    nodesVerified: true,
    label: "AI 算力",
    intent: "机柜代际切换:光互联在柜外、PCB 在柜内,是当前能接到的最大两块",
    symbols: [
      { code: "300308", name: "中际旭创" },
      { code: "002463", name: "沪电股份" },
      { code: "300476", name: "胜宏科技" },
      { code: "300394", name: "天孚通信" },
      { code: "300502", name: "新易盛" },
    ],
  },
  {
    id: "optical",
    // 还没核实过环节骨架 —— 留空并标 false,界面如实说明,不编
    nodes: [],
    nodesVerified: false,
    label: "光互联",
    intent: "铜的物理墙逼出光;真卡口在上游光芯片与磷化铟衬底",
    symbols: [
      { code: "688498", name: "源杰科技" },
      { code: "300394", name: "天孚通信" },
      { code: "300570", name: "太辰光" },
      { code: "002428", name: "云南锗业" },
    ],
  },
  {
    id: "storage",
    // 还没核实过环节骨架 —— 留空并标 false,界面如实说明,不编
    nodes: [],
    nodesVerified: false,
    label: "HBM 存储",
    intent: "三寡头本体买不到,钱在卖铲人;成长性周期股,尊重周期不死拿",
    symbols: [
      { code: "688146", name: "中船特气" },
      { code: "300236", name: "上海新阳" },
      { code: "688072", name: "拓荆科技" },
      { code: "688627", name: "精智达" },
    ],
  },
  {
    id: "semiconductor",
    // 还没核实过环节骨架 —— 留空并标 false,界面如实说明,不编
    nodes: [],
    nodesVerified: false,
    label: "半导体",
    intent: "设备与材料的国产替代进度:看认证与良率,不看订单公告",
    symbols: [
      { code: "688012", name: "中微公司" },
      { code: "002371", name: "北方华创" },
      { code: "688082", name: "盛美上海" },
    ],
  },
  {
    id: "space",
    // 还没核实过环节骨架 —— 留空并标 false,界面如实说明,不编
    nodes: [],
    nodesVerified: false,
    label: "商业航天",
    intent: "可回收火箭的经济性;当前无票可买,价值在扳机表",
    symbols: [
      { code: "300695", name: "兆丰股份" },
      { code: "300699", name: "光威复材" },
    ],
  },
];
