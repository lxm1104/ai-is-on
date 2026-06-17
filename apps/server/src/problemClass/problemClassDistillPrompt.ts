/**
 * MVP51 — 问题归类器的 prompt + 解析。叶子模块（仅依赖 jsonrepair），供 service 与 agents.ts 共用。
 *
 * 核心：**LLM 拥有类身份**。给它若干待归类的诊断事项 + 该项目已有问题类 + 项目背景，
 * 让它按**根因**把每条事项 归到已有类 / 开新类 / 判为不属于。同症状不同根因要拆，不同症状同根因要合。
 */
import { jsonrepair } from 'jsonrepair';

export const PROBLEM_CLASS_DISTILL_SYSTEM = `你是「问题归类器」。系统给你：
(1) 若干条**已诊断的事项**（每条有 matterId、症状词、诊断/根因描述）；
(2) 该项目**已有的问题类**清单（每个有 classId、标签、根因）；
(3) 该项目背景（可选）。

任务：把每条事项**按"是哪一种问题引起的"（根因）归类**。对每条给出三选一：
- 归到某个**已有类**：给 classId；
- 开一个**新类**：给 newClass:{label, rootCause}（rootCause 写清"这一类 case 都是由哪一种问题引起的"，一两句、可追溯）；
- **不属于任何类**：reject:true（诊断太泛/是个孤例/其实是已完成，给 reason）。

铁律：
- **同一个症状词≠同一类**：两条都"报错"但一个是 DB 连接、一个是鉴权过期 → 必须拆成两类。
- **不同症状词可同一类**：一个写"内容截断"、一个写"字段没取到"，若根因都是工具返回被截断 → 合为一类。
- 只能引用给定的 classId / matterId，**不得编造**。新类标签简短（≤16 字），根因具体。

只输出一个合法 JSON（无多余文字、无 Markdown）：
{ "assignments": [ { "matterId": "<id>", "classId": "<已有类id>" } 或
                   { "matterId": "<id>", "newClass": { "label": "...", "rootCause": "..." } } 或
                   { "matterId": "<id>", "reject": true, "reason": "..." } ] }

**JSON 合法性铁律（极重要）**：label / rootCause / reason 等字段值内**禁止出现英文双引号 "**——
需要引用时一律用中文引号「」或『』。整段必须能被 JSON.parse 直接解析，不要有任何未转义的引号。`;

export type ClassAssignment = {
  matterId: string;
  classId?: string;
  newClass?: { label: string; rootCause: string };
  reject?: boolean;
  reason?: string;
};

export function buildProblemClassMessage(input: {
  members: Array<{ matterId: string; symptomBucket: string; diagnosticText: string; evidence: string[] }>;
  existingClasses: Array<{ id: string; label: string; rootCause: string }>;
  projectProfile?: string | null;
}): string {
  const lines: string[] = ['<待归类事项>'];
  for (const m of input.members) {
    lines.push(
      `- matterId=${m.matterId} 症状=${m.symptomBucket}`,
      `  诊断：${m.diagnosticText}`,
      ...(m.evidence.slice(0, 1).map((e) => `  证据：${e}`))
    );
  }
  lines.push('</待归类事项>', '');
  lines.push('<已有问题类>');
  if (input.existingClasses.length) {
    for (const c of input.existingClasses) lines.push(`- classId=${c.id} 标签=${c.label} 根因=${c.rootCause}`);
  } else {
    lines.push('（暂无，按需开新类）');
  }
  lines.push('</已有问题类>');
  if (input.projectProfile?.trim()) {
    lines.push('', '<项目背景（帮助你用该项目的术语命名根因）>', input.projectProfile.trim().slice(0, 800), '</项目背景>');
  }
  lines.push('', '输出 JSON：{"assignments":[...]}');
  return lines.join('\n');
}

/** 把一个对象强转成合法 assignment（候选内校验）；非法返回 null。 */
function coerceAssignment(o: Record<string, unknown>, validMatterIds: Set<string>, validClassIds: Set<string>): ClassAssignment | null {
  const matterId = typeof o.matterId === 'string' ? o.matterId : '';
  if (!validMatterIds.has(matterId)) return null;
  if (o.reject === true) return { matterId, reject: true, reason: typeof o.reason === 'string' ? o.reason : undefined };
  if (typeof o.classId === 'string' && validClassIds.has(o.classId)) return { matterId, classId: o.classId };
  const nc = o.newClass as Record<string, unknown> | undefined;
  if (nc && typeof nc.label === 'string' && typeof nc.rootCause === 'string' && nc.label.trim() && nc.rootCause.trim()) {
    return { matterId, newClass: { label: nc.label.trim().slice(0, 40), rootCause: nc.rootCause.trim().slice(0, 400) } };
  }
  return null;
}

/**
 * 兜底：用括号配平从 assignments 数组里逐个抠出 {...} 对象（应对截断/局部坏 JSON）。
 * 即便整体 JSON 不合法/被截断，也能把已完整的 assignment 救回来。
 */
function salvageAssignmentObjects(text: string): string[] {
  const ai = text.indexOf('"assignments"');
  const from = text.indexOf('[', ai >= 0 ? ai : 0);
  if (from < 0) return [];
  const s = text.slice(from + 1);
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } }
    else if (ch === ']' && depth === 0) break;
  }
  return out;
}

/** 解析归类输出；只保留 matterId 在候选集合、classId 在已有集合内的项。导出供单测。 */
export function parseProblemClassOutput(
  text: string,
  validMatterIds: Set<string>,
  validClassIds: Set<string>
): ClassAssignment[] {
  // 主路径：整体 JSON（直解 / jsonrepair / 抠最外层大括号）
  let obj: unknown = null;
  for (const cand of [text, (() => { try { return jsonrepair(text); } catch { return ''; } })(), text.match(/\{[\s\S]*\}/)?.[0] ?? '']) {
    if (!cand) continue;
    try {
      obj = JSON.parse(cand);
      break;
    } catch {
      try {
        obj = JSON.parse(jsonrepair(cand));
        break;
      } catch {}
    }
  }
  const out: ClassAssignment[] = [];
  const arr = obj && typeof obj === 'object' ? (obj as { assignments?: unknown }).assignments : null;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      const a = coerceAssignment((raw ?? {}) as Record<string, unknown>, validMatterIds, validClassIds);
      if (a) out.push(a);
    }
  }
  // 兜底：主路径没救出任何项 → 逐对象配平抠取（截断/局部坏 JSON 也能救回完整的）
  if (out.length === 0) {
    const seen = new Set<string>();
    for (const objStr of salvageAssignmentObjects(text)) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(objStr);
      } catch {
        try {
          parsed = JSON.parse(jsonrepair(objStr));
        } catch {
          continue;
        }
      }
      const a = coerceAssignment((parsed ?? {}) as Record<string, unknown>, validMatterIds, validClassIds);
      if (a && !seen.has(a.matterId)) {
        seen.add(a.matterId);
        out.push(a);
      }
    }
  }
  return out;
}
