/**
 * MVP51 — 问题类台账 API（只读 + 调试回填）。
 * GET  /api/problem-classes[?spaceId=]  —— 台账：每个问题类 + 根因 + 成员摘要
 * POST /api/problem-classes/backfill     —— 从已有 matters 回填诊断成员并蒸馏一轮（首次填充/手动）
 */
import { Router } from 'express';
import { listLedger, listAllClasses } from '../problemClass/problemClassStore.js';
import { backfillMembersFromMatters, distillAllPending } from '../problemClass/problemClassService.js';

export const problemClassesRouter = Router();

problemClassesRouter.get('/problem-classes', (req, res) => {
  const spaceId = typeof req.query.spaceId === 'string' && req.query.spaceId ? req.query.spaceId : undefined;
  res.json({ items: listLedger(spaceId) });
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
