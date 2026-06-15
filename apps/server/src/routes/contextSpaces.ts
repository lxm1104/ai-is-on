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
import { listDecisionsBySpace, getContextSpace, setSpaceInvestigationProfile } from '../db.js';
import { writeAudit } from '../boundary/auditLog.js';
import { runSuggestionWorker } from '../spaces/suggestionWorker.js';
import { classifyContextUnit } from '../context/layerClassifier.js';
import type { ContextUnit } from '../context/ContextUnit.js';

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
  // MVP21 S3 §6.2: 给每条 unit 挂派生 _layerHint，让前端"当前进展"视图按
  // source（work_map_seed vs triage）做视觉区分。字段名不变。
  const attachHint = <T extends ContextUnit>(u: T) => ({
    ...u,
    _layerHint: classifyContextUnit(u),
  });
  res.json({
    space: detail.space,
    entityLinks,
    commitments: (byKind.get('commitment') ?? []).map(attachHint),
    goals: [...(byKind.get('goal') ?? []), ...(byKind.get('intent') ?? [])].map(attachHint),
    decisions: listDecisionsBySpace(detail.space.id),
    risks: [...(byKind.get('uncertainty') ?? []), ...(byKind.get('constraint') ?? [])].map(attachHint),
    state: (byKind.get('state') ?? []).map(attachHint),
    recentEvents: (byKind.get('event') ?? []).slice(0, 10).map(attachHint),
    allUnitCount: units.length,
  });
});

// MVP38：设置项目排查档案（用户写的额外 context + 做事方法）。自主排查/「让 AI 处理」会注入它。
contextSpacesRouter.post('/context-spaces/:id/profile', (req, res) => {
  const space = getContextSpace(req.params.id);
  if (!space) return res.status(404).json({ error: 'not found' });
  const profile = typeof (req.body ?? {}).profile === 'string' ? req.body.profile : '';
  if (profile.length > 8000) return res.status(400).json({ error: '档案过长（>8000 字）' });
  const ok = setSpaceInvestigationProfile(space.id, profile, new Date().toISOString());
  if (ok) writeAudit({ action: 'project_profile_set', reason: `设置项目排查档案：${space.name}`, payload: { spaceId: space.id, len: profile.trim().length } });
  res.json({ ok, profile: profile.trim() || null });
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
