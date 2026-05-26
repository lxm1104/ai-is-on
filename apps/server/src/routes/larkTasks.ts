import { Router } from 'express';
import { createLarkTaskFromCard } from '../lark/larkTaskService.js';

export const larkTasksRouter = Router();

larkTasksRouter.post('/cards/:id/lark-task', async (req, res) => {
  const body = req.body ?? {};
  try {
    const result = await createLarkTaskFromCard({
      cardId: req.params.id,
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      dueAt: typeof body.dueAt === 'string' ? body.dueAt : undefined,
      tasklistId: typeof body.tasklistId === 'string' ? body.tasklistId : undefined,
      confirm: body.confirm === true,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
