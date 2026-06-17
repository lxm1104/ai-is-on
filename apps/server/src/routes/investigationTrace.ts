/**
 * MVP53 — 「展开排查过程」只读 API：给一张卡（attention_item id），返回它所属 matter 最近一次
 * 自主排查的工具链（每步用了什么只读工具、怎么填的参数、查到什么）+ 结论。让自主运行的过程在 UI 可见。
 */
import { Router } from 'express';
import { getAttentionItem } from '../attention/attentionStore.js';
import { matchMatterId } from '../db.js';
import { getLatestInvestigationTraceForMatter } from '../playbook/playbookStore.js';

export const investigationTraceRouter = Router();

investigationTraceRouter.get('/cards/:cardId/investigation-trace', (req, res) => {
  const item = getAttentionItem(req.params.cardId);
  if (!item || !item.matterId) return res.json({ trace: null });
  const matterId = matchMatterId(item.matterId) ?? item.matterId;
  const trace = getLatestInvestigationTraceForMatter(matterId);
  if (!trace) return res.json({ trace: null });
  res.json({ trace: { outcome: trace.outcome, steps: trace.steps, createdAt: trace.createdAt } });
});
