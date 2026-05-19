import { Router } from 'express';
import {
  archiveSpace,
  createSpace,
  getSpaceDetail,
  listSpaces,
  reconcileAllUnitsToSpaces,
  type SpaceType,
} from '../spaces/contextSpaceService.js';
import { getContextUnitById } from '../context/contextStore.js';
import { listDecisionsBySpace } from '../db.js';

export const contextSpacesRouter = Router();

const VALID_TYPES: SpaceType[] = ['project', 'topic'];

contextSpacesRouter.get('/context-spaces', (_req, res) => {
  res.json({ items: listSpaces() });
});

contextSpacesRouter.post('/context-spaces', (req, res) => {
  const body = req.body ?? {};
  const type = typeof body.type === 'string' && VALID_TYPES.includes(body.type as SpaceType)
    ? (body.type as SpaceType)
    : 'project';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const description = typeof body.description === 'string' ? body.description : undefined;
  const entityNames = Array.isArray(body.entities)
    ? (body.entities as Array<{ type: string; name: string }>).filter(
        (e) => e && typeof e.type === 'string' && typeof e.name === 'string'
      )
    : undefined;
  const space = createSpace({ type, name, description, entityNames });
  // Backfill: route any pre-existing units whose entities match this space's seeds.
  const stats = reconcileAllUnitsToSpaces();
  res.json({ space, reconciled: stats });
});

contextSpacesRouter.post('/context-spaces/reconcile', (_req, res) => {
  res.json(reconcileAllUnitsToSpaces());
});

contextSpacesRouter.get('/context-spaces/:id', (req, res) => {
  const detail = getSpaceDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const entityLinks = detail.links.filter((l) => l.target_type === 'entity');
  const unitLinks = detail.links.filter((l) => l.target_type === 'context_unit');
  const units = unitLinks
    .map((l) => getContextUnitById(l.target_id))
    .filter((u): u is NonNullable<typeof u> => !!u);

  // Categorize for the UI: commitments / goals / decisions / risks / recent.
  const byKind = new Map<string, typeof units>();
  for (const u of units) {
    const arr = byKind.get(u.kind) ?? [];
    arr.push(u);
    byKind.set(u.kind, arr);
  }
  res.json({
    space: detail.space,
    entityLinks,
    commitments: byKind.get('commitment') ?? [],
    goals: [...(byKind.get('goal') ?? []), ...(byKind.get('intent') ?? [])],
    decisions: listDecisionsBySpace(detail.space.id),
    risks: [...(byKind.get('uncertainty') ?? []), ...(byKind.get('constraint') ?? [])],
    state: byKind.get('state') ?? [],
    recentEvents: (byKind.get('event') ?? []).slice(0, 10),
    allUnitCount: units.length,
  });
});

contextSpacesRouter.post('/context-spaces/:id/archive', (req, res) => {
  const row = archiveSpace(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ space: row });
});
