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
                   { "matterId": "<id>", "reject": true, "reason": "..." } ] }`;

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

/** 解析归类输出；只保留 matterId 在候选集合、classId 在已有集合内的项。导出供单测。 */
export function parseProblemClassOutput(
  text: string,
  validMatterIds: Set<string>,
  validClassIds: Set<string>
): ClassAssignment[] {
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
  if (!obj || typeof obj !== 'object') return [];
  const arr = (obj as { assignments?: unknown }).assignments;
  if (!Array.isArray(arr)) return [];
  const out: ClassAssignment[] = [];
  for (const raw of arr) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const matterId = typeof o.matterId === 'string' ? o.matterId : '';
    if (!validMatterIds.has(matterId)) continue;
    if (o.reject === true) {
      out.push({ matterId, reject: true, reason: typeof o.reason === 'string' ? o.reason : undefined });
      continue;
    }
    if (typeof o.classId === 'string' && validClassIds.has(o.classId)) {
      out.push({ matterId, classId: o.classId });
      continue;
    }
    const nc = o.newClass as Record<string, unknown> | undefined;
    if (nc && typeof nc.label === 'string' && typeof nc.rootCause === 'string' && nc.label.trim() && nc.rootCause.trim()) {
      out.push({ matterId, newClass: { label: nc.label.trim().slice(0, 40), rootCause: nc.rootCause.trim().slice(0, 400) } });
      continue;
    }
    // 无法识别的赋值 → 跳过（保守，不乱归）
  }
  return out;
}
