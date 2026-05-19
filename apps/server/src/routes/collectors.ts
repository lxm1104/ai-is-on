import { Router } from 'express';
import { getCollectorSnapshot, runOnce } from '../collectors/scheduler.js';

export const collectorsRouter = Router();

collectorsRouter.get('/collectors', (_req, res) => {
  res.json({ collectors: getCollectorSnapshot() });
});

collectorsRouter.post('/collectors/run-once', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
  try {
    const results = await runOnce(name);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
