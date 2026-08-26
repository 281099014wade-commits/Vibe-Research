/**
 * 启动画面 —— **用户看到的第一屏，也是失败时唯一能看到的一屏。**
 *
 * 界面自己在挂载前就要打后端（台账是同步读的），所以后端没起来之前**不能**加载界面：
 * 加载了就是一屏"连不上后端"。⇒ 外壳先显示这一页，等后端真能应答再换过去。
 *
 * 🔴 **失败必须说人话，而且要说全**。这一层最容易退化成一句"启动失败"——
 *    那句话对用户等于白屏，只不过白屏上写了四个字。凡是我们知道的：
 *    缺哪个文件、子进程退出码是几、它自己打了什么，一并给出来。
 * 🔴 **这一页不碰后端**：它只显示外壳内存里的状态。后端起不来的时候它照样要能显示，
 *    所以它的数据来源不能是后端。
 * 🔴 **HTML 一律转义**：这里要显示的东西包含文件路径与子进程日志——都不是我们写的字面量。
 */

export type StepState = "pending" | "doing" | "done" | "failed";
export type BootPhase = "starting" | "ready" | "failed";

export interface BootStep {
  key: string;
  label: string;
  state: StepState;
  /** 这一步的补充说明（失败原因 / 花了多久）*/
  detail?: string;
}

export interface BootState {
  phase: BootPhase;
  /** 产品名。**外壳不知道自己装的是哪个垂类**，名字由发行包给（Electron 的 productName）*/
  product: string;
  steps: BootStep[];
  /** 人话问题清单：安装缺件、路径不合法…… 每条都应自带"该怎么办" */
  problems: string[];
  /** 子进程最近的输出。失败时把它原样给用户 —— 真正的原因通常就在里面 */
  log: string;
  /** 每次状态变化 +1。启动页靠它判断"要不要重画"，免得每 500ms 白闪一次 */
  revision: number;
}

export function initialBootState(product: string): BootState {
  return {
    phase: "starting",
    product,
    steps: [
      { key: "preflight", label: "检查安装完整性", state: "pending" },
      { key: "backend", label: "启动本机服务", state: "pending" },
      { key: "ui", label: "载入界面", state: "pending" },
    ],
    problems: [],
    log: "",
    revision: 0,
  };
}

/**
 * 不可变更新：整条替换那一步，其余原样带过。
 * 🔴 `revision` 必须跟着涨 —— 启动页只在 revision 变了才重画，忘了涨就是"进度卡住不动"。
 */
export function withStep(state: BootState, key: string, patch: Partial<BootStep>): BootState {
  if (!state.steps.some((s) => s.key === key)) throw new Error(`没有这一步：${key}`);
  return {
    ...state,
    revision: state.revision + 1,
    steps: state.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)),
  };
}

/** 同上：整体打补丁也要涨 revision */
export function patchState(state: BootState, patch: Partial<Omit<BootState, "revision">>): BootState {
  return { ...state, ...patch, revision: state.revision + 1 };
}

/**
 * 🔴 转义要**先转 `&`**，否则后面几步产生的 `&lt;` 会被自己再转一遍。
 *    （同一个坑在档案模板那边踩过：转义必须先转义转义符本身。）
 */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MARK: Record<StepState, string> = { pending: "○", doing: "◐", done: "●", failed: "✕" };

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0b0d11;color:#e7e9ee;
  font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
.card{width:min(640px,88vw);max-height:86vh;overflow:auto;padding:28px 30px;
  background:#12151c;border:1px solid #232936;border-radius:14px}
h1{margin:0 0 2px;font-size:17px;font-weight:600;letter-spacing:.02em}
.sub{margin:0 0 20px;color:#8b93a3;font-size:12.5px}
ul{list-style:none;margin:0;padding:0}
li{display:flex;gap:10px;align-items:baseline;padding:5px 0}
.mark{width:1.1em;text-align:center;flex:none}
.pending .mark{color:#4b5364}.doing .mark{color:#63a7ff}.done .mark{color:#4ec98a}.failed .mark{color:#ff6b6b}
.pending{color:#6b7383}
.detail{color:#8b93a3;font-size:12.5px;margin-left:6px}
.problems{margin-top:20px;padding:14px 16px;background:#2a1618;border:1px solid #5a2a2e;border-radius:10px}
.problems h2{margin:0 0 8px;font-size:13px;font-weight:600;color:#ffb4b4}
.problems li{display:list-item;padding:3px 0;margin-left:18px;list-style:disc;color:#f0d5d5}
pre{margin:14px 0 0;padding:12px 14px;background:#0b0d11;border:1px solid #232936;border-radius:10px;
  white-space:pre-wrap;word-break:break-all;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa3b4;
  max-height:15em;overflow:auto}
.hint{margin:16px 0 0;color:#8b93a3;font-size:12.5px}
.warn{margin:14px 0 0;color:#ffb4b4;font-size:12.5px}
`;

/**
 * 渲染启动页。
 *
 * `nonce` 与响应头里的 CSP 是**同一个值**（由 handler 一次生成、两处使用）——
 * 内联脚本只靠它放行，页面里其它任何脚本（包括万一被塞进来的）都跑不了。
 */
export function bootHtml(state: BootState, nonce: string): string {
  const steps = state.steps
    .map(
      (s) =>
        `<li class="${s.state}"><span class="mark">${MARK[s.state]}</span><span>${esc(s.label)}` +
        (s.detail ? `<span class="detail">${esc(s.detail)}</span>` : "") +
        `</span></li>`,
    )
    .join("");

  const problems = state.problems.length
    ? `<div class="problems"><h2>需要先解决这些</h2><ul>${state.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`
    : "";

  const log = state.log ? `<pre>${esc(state.log)}</pre>` : "";
  const hint =
    state.phase === "failed"
      ? `<p class="hint">这一屏说的就是全部已知信息。修好之后重新打开 ${esc(state.product)}。</p>`
      : "";

  // 轮询只为**显示**：真正切到界面由主进程决定（单一控制点，免得两边抢着导航）。
  // 失败是终态，不再轮询。
  // 🔴 `phase==="ready"` 时**什么都不做**：这一刻主进程正要把窗口导航到界面，
  //    这边再 reload 一次就是两条导航抢同一个窗口 —— 实测能把界面挤掉、停在启动页上。
  const poll =
    state.phase === "failed"
      ? ""
      : `<script nonce="${esc(nonce)}">
window.__rev=${state.revision};window.__bad=0;
setInterval(async()=>{
  var w=document.getElementById("warn");
  try{
    const r=await fetch("/__shell/state",{cache:"no-store"});
    if(!r.ok)throw new Error("HTTP "+r.status);
    const s=await r.json();
    window.__bad=0;if(w)w.textContent="";
    if(s.phase==="ready")return;
    if(s.revision!==window.__rev)location.reload();
  }catch(e){
    // 🔴 静默吞掉 = 页面永远停在"正在启动"，而真正的原因是"读不到状态"。
    //    连续失败到一定次数就说出来 —— 偶发一次不打扰。
    window.__bad++;
    if(window.__bad>=10&&w)w.textContent="读不到启动状态（"+(e&&e.message||e)+"）——外壳可能已经异常退出。";
  }
},500);
</script>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(state.product)}</title><style nonce="${esc(nonce)}">${CSS}</style></head>
<body><div class="card">
<h1>${esc(state.product)}</h1>
<p class="sub">${state.phase === "failed" ? "没能启动" : "正在启动"}</p>
<ul>${steps}</ul>${problems}${log}<p class="warn" id="warn"></p>${hint}
</div>${poll}</body></html>`;
}
