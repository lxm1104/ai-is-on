import { Router } from 'express';
import { isCaringPaused, setCaringPaused } from '../caring/caringSettings.js';

export const caringRouter = Router();

caringRouter.get('/caring/pause', (_req, res) => {
  res.json({ paused: isCaringPaused() });
});

caringRouter.post('/caring/pause', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.paused !== 'boolean') {
    res.status(400).json({ error: 'paused (boolean) required' });
    return;
  }
  setCaringPaused(body.paused);
  res.json({ paused: body.paused });
});
