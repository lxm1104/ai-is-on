import { Router } from 'express';
import { previewImReply, sendImReplyFromCard } from '../lark/larkImReplyService.js';
import { createDocFromCard } from '../lark/larkDocService.js';

export const larkReplyRouter = Router();

// 预览（不发送）：解析"回复给谁/回应哪条原话"+ 建议草稿，供前端在用户确认前展示。
// 解析失败（无可回复消息 / 会话不唯一）→ 400，前端据此隐藏「发送」入口。
larkReplyRouter.get('/cards/:id/im-reply/preview', (req, res) => {
  try {
    const result = previewImReply(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 执行发送：confirm 必填，text 为用户可能编辑过的草稿。
larkReplyRouter.post('/cards/:id/im-reply', async (req, res) => {
  const body = req.body ?? {};
  try {
    const result = await sendImReplyFromCard({
      cardId: req.params.id,
      text: typeof body.text === 'string' ? body.text : undefined,
      confirm: body.confirm === true,
      dryRun: body.dryRun === true,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// MVP35：AI 起草并新建飞书文档（内部可逆，docx scope 已授权）。confirm 必填，支持 dryRun。
larkReplyRouter.post('/cards/:id/lark-doc', async (req, res) => {
  const body = req.body ?? {};
  try {
    const result = await createDocFromCard({
      cardId: req.params.id,
      title: typeof body.title === 'string' ? body.title : undefined,
      confirm: body.confirm === true,
      dryRun: body.dryRun === true,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
