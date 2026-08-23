/**
 * 合规 gate(确定性后处理):最终报告命中"投资动作建议"类模式即拒绝交付(AGENTS.md §0 第 3 条;方案 §9)。
 * 纯函数:输入报告文本,输出命中清单。只有整行精确等于固定免责声明的行才豁免(防"不构成投资建议,但建议建仓")。
 */
import { GATE_EXEMPT_LINES, GATE_PATTERNS } from "./config.ts";

export interface GateHit {
  line: number;
  pattern: string;
  text: string;
}

export interface GateResult {
  ok: boolean;
  hits: GateHit[];
}

/** 简 → 繁(只覆盖 GATE_PATTERNS 用到的、繁简不同的字);与 data-access/scripts/sources/textsafe.py TRAD_CHARS 逐字一致 */
export const TRAD_CHARS: Record<string, string> = { 仓: "倉", 减: "減", 满: "滿", 议: "議", 买: "買", 卖: "賣", 评: "評", 级: "級", 损: "損", 标: "標", 价: "價", 荐: "薦" };
const TRAD2SIMP = new Map(Object.entries(TRAD_CHARS).map(([s, t]) => [t, s]));
const CJK = "\u3400-\u9FFF\uF900-\uFAFF";
// 不可见字符:控制 / 格式字符、零宽、CGJ、蒙文 / 变体选择符(它们是 Mn,不在 Cf 里)
// 规范形还剥组合附加符 / 环绕符(U+0301 等),只用于匹配
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u200B-\u200D\u2060\uFEFF]/gu;
/** 汉字之间可忽略的分隔符;与 textsafe.py CJK_SEP_CHARS 逐字一致(测试强制) */
export const CJK_SEP_CHARS = " \t\r\n\u3000\u00b7\u2022\u30fb_*~|/\\+.\u2010\u2011\u2012\u2013\u2014\u2015-";
const CJK_SEP_RE = new RegExp(`(?<=[${CJK}])[${CJK_SEP_CHARS.replace(/[\\\]^-]/g, (c) => "\\" + c)}]+(?=[${CJK}])`, "gu");

/** gate 匹配用规范形:NFKC、剥不可见字符、繁→简、汉字之间的空白 / 点线分隔符忽略("建 仓" / "建͏仓" / "目️标价" / "目標價" 都命中"建仓 / 目标价")。与 textsafe.canonical_for_match 同构。 */
export function canonicalForGate(text: string): string {
  let t = text.normalize("NFKC").replace(INVISIBLE_RE, "");
  t = Array.from(t, (ch) => TRAD2SIMP.get(ch) ?? ch).join("");
  return t.replace(CJK_SEP_RE, "");
}

export function complianceGate(report: string, patterns: string[] = GATE_PATTERNS, exemptLines: string[] = GATE_EXEMPT_LINES): GateResult {
  const hits: GateHit[] = [];
  const exempt = new Set(exemptLines.map((l) => canonicalForGate(l.trim())));
  report.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/^[-*>\s]+/, "").trim();
    if (!line) return;
    const canon = canonicalForGate(line);
    if (exempt.has(canon)) return;
    for (const p of patterns) {
      if (canon.includes(p)) hits.push({ line: i + 1, pattern: p, text: line.slice(0, 160) });
    }
  });
  return { ok: hits.length === 0, hits };
}

/** 报告必须包含的章节标题是否齐全 */
export function missingSections(report: string, sections: string[]): string[] {
  return sections.filter((s) => !new RegExp(`^#{1,3}\\s*.*${escapeRe(s)}`, "m").test(report));
}

/** 报告中引用的 ev- / calc- id */
export function referencedIds(report: string): { evidence: string[]; calculation: string[] } {
  const ev = new Set(report.match(/ev-[0-9a-f]{6,}/g) ?? []);
  const calc = new Set(report.match(/calc-[0-9a-f]{16}/g) ?? []);
  return { evidence: [...ev], calculation: [...calc] };
}

/** 报告首行的状态标记 */
export function reportStatusToken(report: string): string | null {
  const m = report.split(/\r?\n/)[0]?.match(/状态[::]\s*(complete|incomplete|failed|stale)/);
  return m ? m[1] : null;
}

/** 把首行状态标记改写为 expected(编排器确定性归一,不动正文) */
export function normalizeReportStatus(report: string, expected: string): { text: string; changed: boolean } {
  const lines = report.split(/\r?\n/);
  const before = lines[0] ?? "";
  const after = before.replace(/(状态[::]\s*)(complete|incomplete|failed|stale)/, `$1${expected}`);
  if (after === before) return { text: report, changed: false };
  lines[0] = after;
  return { text: lines.join("\n"), changed: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
