import { Router } from 'express';
import { listRuntimeMessages } from '../db.js';
import { listTopics, sendTopicMessage } from '../chat/chatTopics.js';

export const chatRouter = Router();

chatRouter.get('/topics', (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  res.json({ topics: listTopics(limit) });
});

chatRouter.get('/messages', (req, res) => {
  const limit = clampInt(req.query.limit, 500, 1, 1000);
  const topicId = typeof req.query.topicId === 'string' ? req.query.topicId : undefined;
  const rows = listRuntimeMessages(limit, topicId);
  const messages = rows.map((r) => {
    if (r.raw_json) {
      try {
        return JSON.parse(r.raw_json);
      } catch {}
    }
    return {
      id: r.id,
      topicId: r.topic_id ?? undefined,
      role: r.role,
      text: r.text,
      createdAt: r.created_at,
    };
  });
  res.json({ messages });
});

chatRouter.post('/chat', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const topicId =
    typeof req.body?.topicId === 'string' && req.body.topicId.trim()
      ? req.body.topicId.trim()
      : undefined;
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  try {
    // MVP18 Stage 0: sendTopicMessage 同步返回 { topic, turn }，turn 后台跑。
    // 这里立即 res.json，HTTP 不再卡到 turn 结束。
    const { topic } = sendTopicMessage({ topicId, text, sourceKind: 'manual' });
    res.json({ ok: true, topic });
  } catch (err) {
    // 仅捕获建 topic / 写 user 消息阶段的同步抛错（如 requireTopic 找不到 id）。
    // turn 内部错误已通过 system 消息 + WS 表达，不会进这里。
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
