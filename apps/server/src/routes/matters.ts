/**
 * MVP26 §8 / §16.3 — Matter debug read API。
 *
 *   GET /api/matters                  列表（?status=open,in_progress&limit=100）
 *   GET /api/matters/:id              详情（含 entities / evidence / timeline / spaces）
 *   GET /api/context/units/:id/matters  反查：一条 ContextUnit 影响了哪些 Matter
 *
 * 纯读：MVP26 不在此暴露写操作（创建走 backfill 脚本 / 之后的 reducer）。
 */
import { Router } from 'express';
import { projectMatterDetail, projectMatters } from '../matter/matterProjection.js';
import {
  listMatterObservationsForEvent,
  listMattersForContextUnit,
} from '../matter/matterStore.js';
import {
  markWrongEvidence,
  mergeMatters,
  splitEvidence,
  userDropMatter,
  userReopenMatter,
  userResolveMatter,
} from '../matter/matterActions.js';
import type { MatterStatus } from '../matter/matterTypes.js';

export const mattersRouter = Router();

const VALID_STATUSES: MatterStatus[] = [
  'open',
  'acknowledged',
  'in_progress',
  'waiting',
  'blocked',
  'resolved',
  'dropped',
];

mattersRouter.get('/matters', (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const statuses = parseStatuses(req.query.status);
  const items = projectMatters({ statuses, limit });
  res.json({ items });
});

mattersRouter.get('/matters/:id', (req, res) => {
  const detail = projectMatterDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ matter: detail });
});

mattersRouter.get('/context/units/:id/matters', (req, res) => {
  const items = listMattersForContextUnit(req.params.id);
  res.json({ items });
});

// 一条 event 的 triage MatterObservation（debug / 审计）
mattersRouter.get('/matter-observations/by-event/:eventId', (req, res) => {
  res.json({ items: listMatterObservationsForEvent(req.params.eventId) });
});

// ---- MVP29 §10.7 Matter 级用户动作 ----

mattersRouter.post('/matters/:id/resolve', (req, res) => {
  const m = userResolveMatter(req.params.id, strOrUndef(req.body?.reason));
  if (!m) return notFound(res);
  res.json({ matter: m });
});

mattersRouter.post('/matters/:id/drop', (req, res) => {
  const m = userDropMatter(req.params.id, strOrUndef(req.body?.reason));
  if (!m) return notFound(res);
  res.json({ matter: m });
});

mattersRouter.post('/matters/:id/reopen', (req, res) => {
  const m = userReopenMatter(req.params.id, strOrUndef(req.body?.reason));
  if (!m) return notFound(res);
  res.json({ matter: m });
});

mattersRouter.post('/matters/merge', (req, res) => {
  const sourceId = strOrUndef(req.body?.sourceId);
  const targetId = strOrUndef(req.body?.targetId);
  if (!sourceId || !targetId) {
    res.status(400).json({ error: 'sourceId and targetId required' });
    return;
  }
  const result = mergeMatters(sourceId, targetId);
  if (!result) {
    res.status(400).json({ error: 'merge failed (not found or same matter)' });
    return;
  }
  res.json(result);
});

mattersRouter.post('/matters/:id/split', (req, res) => {
  const contextUnitId = strOrUndef(req.body?.contextUnitId);
  if (!contextUnitId) {
    res.status(400).json({ error: 'contextUnitId required' });
    return;
  }
  const created = splitEvidence(req.params.id, contextUnitId, strOrUndef(req.body?.title));
  if (!created) return notFound(res);
  res.json({ matter: created });
});

mattersRouter.post('/matters/:id/wrong-evidence', (req, res) => {
  const contextUnitId = strOrUndef(req.body?.contextUnitId);
  if (!contextUnitId) {
    res.status(400).json({ error: 'contextUnitId required' });
    return;
  }
  const ok = markWrongEvidence(req.params.id, contextUnitId, strOrUndef(req.body?.reason));
  if (!ok) return notFound(res);
  res.json({ ok: true });
});

function notFound(res: import('express').Response): void {
  res.status(404).json({ error: 'not found' });
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function parseStatuses(v: unknown): MatterStatus[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = parts.filter((p): p is MatterStatus =>
    (VALID_STATUSES as string[]).includes(p)
  );
  return valid.length ? valid : undefined;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
