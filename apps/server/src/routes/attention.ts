import { Router } from 'express';
import {
  getAttentionItem,
  getLastEngineRun,
  listLiveAttentionItems,
  updateAttentionItemStatus,
} from '../attention/attentionStore.js';
import {
  enqueueAttentionTickSoon,
  runAttentionTick,
} from '../attention/attentionEngine.js';
import { projectAttentionItemToCard } from '../attention/attentionProjection.js';
import {
  applyAttentionFeedback,
  type AttentionFeedbackType,
} from '../attention/attentionFeedback.js';
import type { AttentionStatus } from '../attention/attentionTypes.js';
import {
  resolveAttentionOriginItems,
  resolveAttentionSignalDetails,
} from '../cards/contextProjection.js';

export const attentionRouter = Router();

// ---- read ----

attentionRouter.get('/attention', (_req, res) => {
  res.json({ items: listLiveAttentionItems() });
});

// Step 2: 给前端 CardList 用的 SignalCard 形状端点。
// 当前只返回 live items（映射为 status='new'）。已处理/已忽略不再露出。
attentionRouter.get('/attention/cards', (_req, res) => {
  const cards = listLiveAttentionItems(100).map(projectAttentionItemToCard);
  res.json({ cards });
});

// "查看原始信息"：把卡片的 signalIds 解开成可点击的原始信号列表。
// 同 chat 的 IM signals 合并成 conversation（按时间顺序的对话块），
// 其他来源保持单条 signal。块间按"最新动静"时间倒序。
// 保留 signals 字段向后兼容（旧前端用），新前端读 items。
attentionRouter.get('/attention/:id/signals', (req, res) => {
  const id = req.params.id;
  const item = getAttentionItem(id);
  if (!item) {
    res.status(404).json({ error: 'attention item not found' });
    return;
  }
  const signals = resolveAttentionSignalDetails(item.signalIds);
  const items = resolveAttentionOriginItems(item.signalIds);
  res.json({ attentionId: id, signals, items });
});

attentionRouter.get('/attention/last-run', (_req, res) => {
  const row = getLastEngineRun();
  if (!row) {
    res.json({ run: null });
    return;
  }
  let inputSummary: unknown = null;
  try {
    inputSummary = JSON.parse(row.input_summary_json);
  } catch {}
  res.json({
    run: {
      id: row.id,
      generation: row.generation,
      trigger: row.trigger,
      inputHash: row.input_hash,
      promptVersion: row.prompt_version,
      modelId: row.model_id,
      status: row.status,
      itemsEmitted: row.items_emitted,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      inputSummary,
      outputTextHead: row.output_text ? row.output_text.slice(0, 2000) : null,
    },
  });
});

// ---- manual trigger（dev-only：要带 X-Internal: 1 才能跑，避免外网随手刷 LLM）----

attentionRouter.post('/attention/run', async (req, res) => {
  const isInternal = req.header('x-internal') === '1';
  if (!isInternal) {
    res.status(403).json({ error: 'X-Internal: 1 header required' });
    return;
  }
  try {
    const summary = await runAttentionTick({ trigger: 'manual' });
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- status update（前端 ack / dismiss / mark_done 用）----

const ALLOWED_STATUS = new Set<AttentionStatus>(['acted', 'dismissed', 'live']);

// MVP14 Step 4：attention 反馈 → 影响 L1 → 触发下一次 tick
const VALID_FEEDBACK_TYPES: AttentionFeedbackType[] = [
  'not_relevant',
  'wrong_space',
  'demote_entity',
  'add_preference',
];

attentionRouter.post('/attention/:id/feedback', (req, res) => {
  const id = req.params.id;
  const body = req.body ?? {};
  const type = body.type;
  if (typeof type !== 'string' || !VALID_FEEDBACK_TYPES.includes(type as AttentionFeedbackType)) {
    res.status(400).json({ error: `invalid feedback type: ${type}` });
    return;
  }
  const payload = (body.payload as Record<string, unknown> | undefined) ?? {};
  const confirm = body.confirm === true;
  try {
    const result = applyAttentionFeedback({
      attentionId: id,
      type: type as AttentionFeedbackType,
      payload,
      confirm,
    });
    // 成功 apply 后 10s 让 attention 重算一次，让用户感知反馈生效
    if (result.applied) enqueueAttentionTickSoon();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

attentionRouter.post('/attention/:id/status', (req, res) => {
  const id = req.params.id;
  const statusRaw = typeof req.body?.status === 'string' ? req.body.status : '';
  if (!ALLOWED_STATUS.has(statusRaw as AttentionStatus)) {
    res.status(400).json({
      error: `status must be one of ${Array.from(ALLOWED_STATUS).join('|')}`,
    });
    return;
  }
  const existing = getAttentionItem(id);
  if (!existing) {
    res.status(404).json({ error: 'attention item not found' });
    return;
  }
  const updated = updateAttentionItemStatus(
    id,
    statusRaw as AttentionStatus,
    new Date().toISOString()
  );
  res.json({ item: updated });
});
