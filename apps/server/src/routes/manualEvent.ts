import { Router } from 'express';
import { ingestSignal } from '../collectors/ingest.js';
import type { ContextScope } from '../context/ContextUnit.js';

export const manualEventRouter = Router();

const VALID_SCOPES = new Set<ContextScope>(['personal', 'work', 'team']);

manualEventRouter.post('/manual-event', (req, res) => {
  const body = req.body ?? {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const scopeRaw = typeof body.scope === 'string' ? body.scope : '';
  const scope = VALID_SCOPES.has(scopeRaw as ContextScope)
    ? (scopeRaw as ContextScope)
    : 'personal';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind : 'note';

  const result = ingestSignal({
    source: 'manual',
    kind,
    text,
    title: title || null,
    scope,
  });

  if (!result.ok) {
    res.status(500).json({ error: 'ingest failed' });
    return;
  }
  if (!('created' in result) || !result.created) {
    res.json({ ok: true, created: false });
    return;
  }
  res.json({ ok: true, created: true, eventId: result.event.id });
});
