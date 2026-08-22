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

export function complianceGate(report: string, patterns: string[] = GATE_PATTERNS, exemptLines: string[] = GATE_EXEMPT_LINES): GateResult {
  const hits: GateHit[] = [];
  const exempt = new Set(exemptLines.map((l) => l.trim()));
  report.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/^[-*>\s]+/, "").trim();
    if (!line) return;
    if (exempt.has(line)) return;
    for (const p of patterns) {
      if (line.includes(p)) hits.push({ line: i + 1, pattern: p, text: line.slice(0, 160) });
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
