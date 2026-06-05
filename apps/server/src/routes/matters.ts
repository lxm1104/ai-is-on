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
import { listMattersForContextUnit } from '../matter/matterStore.js';
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
