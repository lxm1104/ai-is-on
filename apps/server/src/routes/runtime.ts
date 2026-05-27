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

// MVP14: 中断当前 Claude turn（用户在前端点 "停止" 时触发）
// MVP18 Stage 1: 增加可选 body.topicId 参数；无参时退化为"中断所有 busy session"。
runtimeRouter.post('/runtime/interrupt', async (req, res) => {
  const topicId =
    typeof req.body?.topicId === 'string' && req.body.topicId.trim()
      ? req.body.topicId.trim()
      : undefined;
  try {
    const r = await claudeRuntime.interrupt(topicId);
    res.json({ ...r, status: claudeRuntime.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// MVP18 Stage 1: 给前端 WS reconnect 时一次性拉全量 topic_status，
// 补 R1（重连期间漏掉的 status 变化）。
runtimeRouter.get('/runtime/topic-status', (_req, res) => {
  res.json({ topics: claudeRuntime.getAllTopicStatus() });
});
