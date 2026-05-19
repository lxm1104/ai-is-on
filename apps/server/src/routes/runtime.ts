import { Router } from 'express';
import { claudeRuntime } from '../claude/ClaudeRuntime.js';

export const runtimeRouter = Router();

runtimeRouter.get('/runtime/status', (_req, res) => {
  res.json({ status: claudeRuntime.getStatus() });
});

runtimeRouter.post('/runtime/restart', async (_req, res) => {
  try {
    await claudeRuntime.restart();
    res.json({ ok: true, status: claudeRuntime.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
