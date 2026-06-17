/**
 * MVP56 — 问题类「系统性分析」的 prompt + 解析。叶子模块（仅 jsonrepair）。
 *
 * 把一个问题类的多条 case（根因+排查轨迹）综合成**系统性**结论：不是单 case 的修法，而是这一类
 * 由哪种根本原因引起、系统性的解法/修复方向、影响面、建议动作。结论交用户审阅，**绝不自动执行**。
 */
import { jsonrepair } from 'jsonrepair';

export const PROBLEM_CLASS_ANALYZE_SYSTEM = `你是「系统性问题分析师」。系统给你**一个问题类**：它的标签、当前根因，以及归在这一类下的**多条真实 case**
（每条带诊断/排查发现）。你的任务是综合这些 case，给出**系统性**的结论——着眼"这一类"而非单条：

- systematicRootCause：这一类问题**系统性的根本原因**（多条共性的本质原因，而非罗列每条；若 case 其实根因不一致，要指出）。
- systematicSolution：**系统性解法/修复方向**（治本，覆盖这一类，而非临时绕过单条；可给 1-3 步）。
- affectedScope：影响面/涉及的组件、模块、范围。
- recommendedAction：给用户的**建议下一步**（决策建议，不代替用户执行）。
- verificationCommands：1-5 条**只读**命令，用来**确认或证伪**上面的 systematicRootCause（证据优先、不靠猜）。
  · 只能是只读检索/查看：rg / grep / git log / git show / git blame / fornax-cli 拿 trace 等；**禁止**任何写/删/改/发布/装包/凭证类命令。
  · 给项目背景里的代码库路径下可直接跑的真实命令（含关键词/文件/commit），让用户或下一轮排查跑一下就能验真。
  · 若证据不足以给出可验证命令，给空数组 []，别编。
- confidence：0-1，对上述判断的把握。

纪律：基于给的证据，不编造；case 不足以下系统性结论时，confidence 给低并在 systematicRootCause 里说明还缺什么。
**JSON 合法性**：所有字段值内禁用英文双引号 "，需要引用用「」。整段必须能被 JSON.parse 直接解析。

只输出一个 JSON：
{ "systematicRootCause": "...", "systematicSolution": "...", "affectedScope": "...", "recommendedAction": "...", "verificationCommands": ["rg -n 「关键词」 src/", "git log --oneline -5 -- 路径"], "confidence": 0.0 }`;

export function buildClassAnalyzeMessage(input: {
  label: string;
  rootCause: string;
  members: Array<{ diagnosticText: string; traceOutcome?: string | null }>;
  projectProfile?: string | null;
}): string {
  const lines = [
    '<问题类>',
    `标签：${input.label}`,
    `当前根因：${input.rootCause}`,
    '</问题类>',
    '',
    '<这一类下的 case>',
  ];
  input.members.forEach((m, i) => {
    lines.push(`[case ${i + 1}] ${m.diagnosticText}`);
    if (m.traceOutcome) lines.push(`  排查结论：${m.traceOutcome.slice(0, 200)}`);
  });
  lines.push('</这一类下的 case>');
  if (input.projectProfile?.trim()) {
    lines.push('', '<项目背景>', input.projectProfile.trim().slice(0, 800), '</项目背景>');
  }
  lines.push('', '输出系统性分析 JSON。');
  return lines.join('\n');
}

export type ParsedClassAnalysis = {
  systematicRootCause: string;
  systematicSolution: string;
  affectedScope: string;
  recommendedAction: string;
  verificationCommands: string[];
  confidence: number;
};

// MVP63：只读命令白名单——展示给用户的"验证命令"必须明显只读，挡掉模型偶发写/删/发指令。
const READONLY_CMD_RE = /^\s*(rg|grep|git\s+(log|show|blame|diff|status|cat-file|rev-list|grep)|fornax-cli|bytedcli|cat|less|head|tail|find|ls|sed\s+-n|awk)\b/i;
const FORBIDDEN_CMD_RE = /\b(rm|mv|cp|chmod|chown|kill|curl|wget|ssh|scp|npm|pnpm|yarn|pip|push|commit|reset|checkout|merge|rebase|apply|clean|sudo|tee|>>?|\||&&|;)\b|[`$()]/;
function sanitizeVerificationCommands(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const cmd = item.trim();
    if (!cmd || cmd.length > 200) continue;
    if (!READONLY_CMD_RE.test(cmd)) continue; // 必须以只读命令开头
    if (FORBIDDEN_CMD_RE.test(cmd)) continue; // 含写/删/管道/重定向/命令替换等 → 丢弃
    out.push(cmd);
    if (out.length >= 5) break;
  }
  return out;
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** 解析系统性分析输出；缺关键字段返回 null。导出供单测。 */
export function parseClassAnalysis(text: string): ParsedClassAnalysis | null {
  let obj: unknown = null;
  try {
    obj = JSON.parse(text);
  } catch {
    try {
      obj = JSON.parse(jsonrepair(text));
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          obj = JSON.parse(jsonrepair(m[0]));
        } catch {
          obj = null;
        }
      }
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const rootCause = str(o.systematicRootCause);
  const solution = str(o.systematicSolution);
  if (!rootCause || !solution) return null; // 系统性根因+解法是核心，缺则视为无效
  return {
    systematicRootCause: rootCause.slice(0, 600),
    systematicSolution: solution.slice(0, 800),
    affectedScope: str(o.affectedScope).slice(0, 300),
    recommendedAction: str(o.recommendedAction).slice(0, 400),
    verificationCommands: sanitizeVerificationCommands(o.verificationCommands),
    confidence: clamp01(o.confidence),
  };
}
