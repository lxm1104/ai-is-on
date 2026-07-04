/**
 * MVP81 —— 可迁移学习包：把 AI 学到的「方法层」知识导出/导入，让学习能力泛化到别的用户/业务场景。
 *
 * 用户目标（2026-07-04 goal）："也希望这个能力能够复用泛化到其他用户其他人的业务场景"。
 *
 * 导出纪律（去个人化）：
 *  - playbooks：中粒度 taskTypeKey + 蒸馏时已「去具体化」的步骤（MVP37 蒸馏 prompt 硬要求不写死人名/id）——方法可携带；
 *  - habits：**只导出通用类型层**的选择统计（taskTypeKey → 选了什么多少次），绝不带请求人实体 id/open_id——
 *    具体对象层的习惯是"你和张三之间"的私事，不出这台机器；
 *  - problemClasses：已归纳的问题类（label + 根因 + 系统性分析），是业务知识，转移正是目的。
 *
 * 导入纪律（人主导，与 MVP37/51 同一联动规则）：
 *  - playbook 一律进 **distilled 草稿（approved=0）**，接收方用户批准后才成为权威——别人的方法永远只是建议；
 *  - 已有权威版（接收方自己写/批准过）的 taskTypeKey 直接跳过，绝不覆盖；
 *  - habits/problemClasses v1 只导出不导入（习惯必须由本地真实选择长出来；问题类依赖本地 matter 关联）——诚实边界。
 */
import { Router } from 'express';
import { listPlaybooks, getPlaybookByType, distillUpsertPlaybook } from '../playbook/playbookStore.js';
import { deriveTaskTypeKey, isAuthoritative, type PlaybookStep } from '../playbook/PlaybookTypes.js';
import { listAllClasses } from '../problemClass/problemClassStore.js';
import { listConsultChoiceHistory } from '../db.js';
import { writeAudit } from '../boundary/auditLog.js';

export const learningRouter = Router();

export const LEARNING_PACK_KIND = 'aiisn-learning-pack';
export const LEARNING_PACK_VERSION = 1;

export type LearningPack = {
  kind: typeof LEARNING_PACK_KIND;
  version: number;
  exportedAt: string;
  playbooks: Array<{ taskTypeKey: string; title: string; steps: PlaybookStep[]; tier: string; approved: boolean }>;
  habits: Array<{ key: string; choiceCounts: Record<string, number>; latestChoice: string | null }>;
  problemClasses: Array<{ label: string; rootCause: string; systematicSolution: string | null }>;
};

/** 通用类型层的习惯统计（无任何人员标识）——供导出与"接收方冷启动提示"参考。 */
export function aggregateGenericHabits(): LearningPack['habits'] {
  const byKey = new Map<string, { counts: Record<string, number>; latestChoice: string | null; latestAt: string }>();
  for (const r of listConsultChoiceHistory(500)) {
    const key = deriveTaskTypeKey({ type: r.matterType ?? '', nextAction: r.nextAction, title: r.title ?? '' });
    const slot = byKey.get(key) ?? { counts: {}, latestChoice: null, latestAt: '' };
    slot.counts[r.choice] = (slot.counts[r.choice] ?? 0) + 1;
    if (r.createdAt > slot.latestAt) {
      slot.latestAt = r.createdAt;
      slot.latestChoice = r.choice;
    }
    byKey.set(key, slot);
  }
  return [...byKey.entries()].map(([key, s]) => ({ key, choiceCounts: s.counts, latestChoice: s.latestChoice }));
}

export function buildLearningPack(now = new Date().toISOString()): LearningPack {
  return {
    kind: LEARNING_PACK_KIND,
    version: LEARNING_PACK_VERSION,
    exportedAt: now,
    playbooks: listPlaybooks({ activeOnly: true }).map((p) => ({
      taskTypeKey: p.taskTypeKey,
      title: p.title,
      steps: p.steps,
      tier: p.tier,
      approved: p.approved,
    })),
    habits: aggregateGenericHabits(),
    problemClasses: listAllClasses().map((c) => ({
      label: c.label,
      rootCause: c.rootCause,
      systematicSolution: c.analysis?.systematicSolution ?? null,
    })),
  };
}

learningRouter.get('/learning/export', (_req, res) => {
  res.json({ pack: buildLearningPack() });
});

function parseSteps(raw: unknown): PlaybookStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlaybookStep[] = [];
  raw.forEach((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const intent = typeof o.intent === 'string' ? o.intent.trim() : '';
    if (!intent) return;
    const step: PlaybookStep = { order: typeof o.order === 'number' ? o.order : i + 1, intent };
    if (typeof o.toolHint === 'string' && o.toolHint.trim()) step.toolHint = o.toolHint.trim();
    if (typeof o.note === 'string' && o.note.trim()) step.note = o.note.trim();
    out.push(step);
  });
  return out;
}

/** 导入学习包（v1 只吃 playbooks；一律进草稿、避让权威版）。返回逐项结果，绝不静默吞。 */
export function importLearningPack(pack: unknown): { imported: string[]; skippedAuthoritative: string[]; invalid: number } {
  const p = (pack ?? {}) as Record<string, unknown>;
  if (p.kind !== LEARNING_PACK_KIND) throw new Error(`不是学习包（kind=${String(p.kind)}）`);
  const imported: string[] = [];
  const skippedAuthoritative: string[] = [];
  let invalid = 0;
  for (const raw of Array.isArray(p.playbooks) ? p.playbooks : []) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const taskTypeKey = typeof o.taskTypeKey === 'string' ? o.taskTypeKey.trim() : '';
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const steps = parseSteps(o.steps);
    if (!taskTypeKey || !title || steps.length === 0) {
      invalid += 1;
      continue;
    }
    const existing = getPlaybookByType(taskTypeKey);
    if (existing && isAuthoritative(existing)) {
      skippedAuthoritative.push(taskTypeKey);
      continue;
    }
    // 进 distilled 草稿（approved=0）——别人的方法只是建议，接收方批准后才权威。
    const r = distillUpsertPlaybook({ taskTypeKey, title, steps, traceCount: 0, confidence: 0.5 });
    if (!r.skipped) imported.push(taskTypeKey);
    else skippedAuthoritative.push(taskTypeKey);
  }
  return { imported, skippedAuthoritative, invalid };
}

learningRouter.post('/learning/import', (req, res) => {
  try {
    const result = importLearningPack((req.body ?? {}).pack ?? req.body);
    writeAudit({
      action: 'learning_pack_imported',
      reason: `导入学习包：${result.imported.length} 份做法进草稿等你批准${result.skippedAuthoritative.length ? `，${result.skippedAuthoritative.length} 份因你已有权威版跳过` : ''}`,
      payload: result as unknown as Record<string, unknown>,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
