import { Router } from 'express';
import {
  archiveSpace,
  confirmChatAffinitySuggestion,
  createSpace,
  getSpaceDetail,
  listSpaces,
  listSuggestionsForSpace,
  reconcileAllUnitsToSpaces,
  rejectSuggestion,
  type ConfirmReasonCode,
  type RejectReasonCode,
  type SpaceType,
} from '../spaces/contextSpaceService.js';
import { getContextUnitById } from '../context/contextStore.js';
import { listDecisionsBySpace } from '../db.js';
import { runSuggestionWorker } from '../spaces/suggestionWorker.js';

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

// ---------- MVP12 Phase 2/3：suggestions ----------

contextSpacesRouter.get('/context-spaces/:id/suggestions', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'suggested';
  const items = listSuggestionsForSpace(req.params.id, status);
  // 解 evidence_json，方便前端直接渲染
  const out = items.map((s) => {
    let evidence: unknown = null;
    try {
      evidence = JSON.parse(s.evidence_json);
    } catch {
      evidence = null;
    }
    return { ...s, evidence };
  });
  res.json({ items: out });
});

const CONFIRM_REASONS: ConfirmReasonCode[] = [
  'exact_project_chat',
  'useful_context_source',
  'name_match',
  'people_match',
  'doc_match',
  'other',
];
const REJECT_REASONS: RejectReasonCode[] = [
  'wrong_space',
  'chat_too_broad',
  'only_incidental_mention',
  'obsolete',
  'duplicate_seed',
  'private_or_noise',
  'permanent_not_relevant',
  'other',
];

contextSpacesRouter.post(
  '/context-spaces/:id/suggestions/:sid/confirm',
  (req, res) => {
    const body = req.body ?? {};
    const reasonCode =
      typeof body.reasonCode === 'string' &&
      CONFIRM_REASONS.includes(body.reasonCode as ConfirmReasonCode)
        ? (body.reasonCode as ConfirmReasonCode)
        : undefined;
    const comment =
      typeof body.comment === 'string' && body.comment.trim().length > 0
        ? body.comment.trim()
        : undefined;
    const r = confirmChatAffinitySuggestion({
      spaceId: req.params.id,
      suggestionId: req.params.sid,
      reasonCode,
      comment,
    });
    if (!r.ok) {
      res.status(400).json({ error: r.reason ?? 'failed' });
      return;
    }
    res.json(r);
  }
);

contextSpacesRouter.post(
  '/context-spaces/:id/suggestions/:sid/reject',
  (req, res) => {
    const body = req.body ?? {};
    const reasonCode =
      typeof body.reasonCode === 'string' &&
      REJECT_REASONS.includes(body.reasonCode as RejectReasonCode)
        ? (body.reasonCode as RejectReasonCode)
        : undefined;
    const comment =
      typeof body.comment === 'string' && body.comment.trim().length > 0
        ? body.comment.trim()
        : undefined;
    const r = rejectSuggestion({
      spaceId: req.params.id,
      suggestionId: req.params.sid,
      reasonCode,
      comment,
      cooldownDays:
        typeof body.cooldownDays === 'number'
          ? body.cooldownDays
          : undefined,
    });
    if (!r.ok) {
      res.status(400).json({ error: r.reason ?? 'failed' });
      return;
    }
    res.json(r);
  }
);

// 触发后台 worker（首期手动；后续可加 setInterval）
contextSpacesRouter.post(
  '/context-spaces/run-suggestion-worker',
  async (_req, res) => {
    try {
      const stats = await runSuggestionWorker();
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
);
