/**
 * MVP51 — 问题类台账 API（只读 + 调试回填）。
 * GET  /api/problem-classes[?spaceId=]  —— 台账：每个问题类 + 根因 + 成员摘要
 * POST /api/problem-classes/backfill     —— 从已有 matters 回填诊断成员并蒸馏一轮（首次填充/手动）
 */
import { Router } from 'express';
import { listLedger, listAllClasses, userEditClass, approveClass, setProblemClassStatus } from '../problemClass/problemClassStore.js';
import type { ProblemClassStatus } from '../problemClass/problemClassTypes.js';
import { backfillMembersFromMatters, distillAllPending } from '../problemClass/problemClassService.js';
import { writeAudit } from '../boundary/auditLog.js';

export const problemClassesRouter = Router();

problemClassesRouter.get('/problem-classes', (req, res) => {
  const spaceId = typeof req.query.spaceId === 'string' && req.query.spaceId ? req.query.spaceId : undefined;
  res.json({ items: listLedger(spaceId) });
});

// 用户校正一个类的标签/根因 → 升权威版（自发蒸馏不再覆盖）
problemClassesRouter.post('/problem-classes/:id', (req, res) => {
  const body = (req.body ?? {}) as { label?: unknown; rootCause?: unknown };
  const label = typeof body.label === 'string' ? body.label : undefined;
  const rootCause = typeof body.rootCause === 'string' ? body.rootCause : undefined;
  const cls = userEditClass(req.params.id, { label, rootCause });
  if (!cls) return res.status(404).json({ error: 'class not found' });
  writeAudit({ action: 'problem_class_edited', reason: `用户校正问题类「${cls.label}」`, payload: { id: cls.id } });
  res.json({ class: cls });
});

// 批准一个蒸馏草稿类 → 升权威
problemClassesRouter.post('/problem-classes/:id/approve', (req, res) => {
  const cls = approveClass(req.params.id);
  if (!cls) return res.status(404).json({ error: 'class not found' });
  writeAudit({ action: 'problem_class_approved', reason: `用户批准问题类「${cls.label}」`, payload: { id: cls.id } });
  res.json({ class: cls });
});

// MVP54：设置修复状态（open/fixing/resolved）——把台账从"看见"延伸到"跟踪修复"
problemClassesRouter.post('/problem-classes/:id/status', (req, res) => {
  const status = (req.body ?? {}).status as ProblemClassStatus;
  if (status !== 'open' && status !== 'fixing' && status !== 'resolved') {
    return res.status(400).json({ error: 'status must be open|fixing|resolved' });
  }
  const cls = setProblemClassStatus(req.params.id, status);
  if (!cls) return res.status(404).json({ error: 'class not found' });
  // 复用 problem_class_edited 审计动作（避免动并行会话在改的 auditLog.ts）
  writeAudit({ action: 'problem_class_edited', reason: `问题类「${cls.label}」状态 → ${status}`, payload: { id: cls.id, status } });
  res.json({ class: cls });
});

problemClassesRouter.post('/problem-classes/backfill', async (_req, res) => {
  try {
    const ingested = backfillMembersFromMatters();
    const distilledSpaces = await distillAllPending();
    res.json({ ingested, distilledSpaces, classes: listAllClasses().length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
