import { Router } from 'express';
import { claudeRuntime } from '../claude/ClaudeRuntime.js';
import { listRuntimeMessages } from '../db.js';
import { recordUserMessage } from '../messageBus.js';

export const chatRouter = Router();

chatRouter.get('/messages', (_req, res) => {
  const rows = listRuntimeMessages(500);
  const messages = rows.map((r) => {
    if (r.raw_json) {
      try {
        return JSON.parse(r.raw_json);
      } catch {}
    }
    return {
      id: r.id,
      role: r.role,
      text: r.text,
      createdAt: r.created_at,
    };
  });
  res.json({ messages });
});

chatRouter.post('/chat', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  try {
    recordUserMessage(text);
    await claudeRuntime.sendUserMessage(text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
