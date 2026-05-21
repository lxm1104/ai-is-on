import { Router } from 'express';
import {
  confirmWorkMap,
  generateWorkMapDraft,
  getCurrentWorkMap,
} from '../bootstrap/workMapService.js';
import type { WorkMapDraft } from '../bootstrap/workMapTypes.js';

export const bootstrapRouter = Router();

bootstrapRouter.get('/bootstrap/work-map/current', (_req, res) => {
  res.json(getCurrentWorkMap());
});

bootstrapRouter.post('/bootstrap/work-map/confirm', (req, res) => {
  const body = req.body as Partial<WorkMapDraft> | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'WorkMapDraft body required' });
    return;
  }
  const draft: WorkMapDraft = {
    profile: {
      roleTitle: typeof body.profile?.roleTitle === 'string' ? body.profile.roleTitle : undefined,
      teamName: typeof body.profile?.teamName === 'string' ? body.profile.teamName : undefined,
      responsibilities: Array.isArray(body.profile?.responsibilities)
        ? body.profile!.responsibilities.filter((s): s is string => typeof s === 'string')
        : [],
    },
    projects: Array.isArray(body.projects)
      ? body.projects.map((p) => ({
          name: typeof p?.name === 'string' ? p.name : '',
          description: typeof p?.description === 'string' ? p.description : undefined,
          goals: Array.isArray(p?.goals)
            ? p.goals.filter((s): s is string => typeof s === 'string')
            : [],
          authoritativeDocs: Array.isArray(p?.authoritativeDocs)
            ? p.authoritativeDocs.filter((s): s is string => typeof s === 'string')
            : [],
          upcomingDeadlines: Array.isArray(p?.upcomingDeadlines)
            ? p.upcomingDeadlines
                .filter(
                  (d): d is { title: string; dueAt?: string } =>
                    !!d && typeof d.title === 'string'
                )
                .map((d) => ({
                  title: d.title,
                  dueAt: typeof d.dueAt === 'string' ? d.dueAt : undefined,
                }))
            : [],
          risks: Array.isArray(p?.risks)
            ? p.risks.filter((s): s is string => typeof s === 'string')
            : [],
        }))
      : [],
    stakeholders: Array.isArray(body.stakeholders)
      ? body.stakeholders
          .filter((s): s is { name: string; note?: string } => !!s && typeof s.name === 'string')
          .map((s) => ({ name: s.name, note: typeof s.note === 'string' ? s.note : undefined }))
      : [],
    preferences: Array.isArray(body.preferences)
      ? body.preferences.filter((s): s is string => typeof s === 'string')
      : [],
    boundaries: Array.isArray(body.boundaries)
      ? body.boundaries
          .filter((b): b is { description: string; [k: string]: unknown } =>
            !!b && typeof b.description === 'string'
          )
          .map((b) => ({
            description: b.description,
            triggerType: Array.isArray((b as Record<string, unknown>).triggerType)
              ? ((b as Record<string, unknown>).triggerType as string[]).filter(
                  (s) => typeof s === 'string'
                ) as WorkMapDraft['boundaries'][number]['triggerType']
              : undefined,
            priorityAtMost:
              typeof (b as Record<string, unknown>).priorityAtMost === 'string'
                ? ((b as Record<string, unknown>).priorityAtMost as
                    WorkMapDraft['boundaries'][number]['priorityAtMost'])
                : undefined,
            source: Array.isArray((b as Record<string, unknown>).source)
              ? ((b as Record<string, unknown>).source as string[]).filter(
                  (s) => typeof s === 'string'
                ) as WorkMapDraft['boundaries'][number]['source']
              : undefined,
            allowedAction:
              typeof (b as Record<string, unknown>).allowedAction === 'string'
                ? ((b as Record<string, unknown>).allowedAction as
                    WorkMapDraft['boundaries'][number]['allowedAction'])
                : undefined,
          }))
      : [],
  };

  try {
    const summary = confirmWorkMap(draft);
    res.json({ summary, current: getCurrentWorkMap() });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// MVP7.1 LLM 草稿
bootstrapRouter.post('/bootstrap/work-map/draft', async (req, res) => {
  try {
    const out = await generateWorkMapDraft({
      seedText: typeof req.body?.seedText === 'string' ? req.body.seedText : undefined,
      lookbackDays:
        typeof req.body?.lookbackDays === 'number' ? req.body.lookbackDays : 14,
      mode: req.body?.mode === 'incremental' ? 'incremental' : 'full',
    });
    res.json(out);
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});
