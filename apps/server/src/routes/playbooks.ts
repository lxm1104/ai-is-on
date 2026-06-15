/**
 * MVP37 — playbook 教学/管理 API（前端 Playbook 面板的后端）。
 * 用户在这里补充信息、加速收敛：列出 / 新建编辑(权威) / 批准草稿 / 停用。
 */
import { Router } from 'express';
import {
  listPlaybooks,
  getPlaybookByType,
  userUpsertPlaybook,
  approvePlaybook,
  setPlaybookActive,
} from '../playbook/playbookStore.js';
import { writeAudit } from '../boundary/auditLog.js';
import type { PlaybookStep } from '../playbook/PlaybookTypes.js';

export const playbooksRouter = Router();

playbooksRouter.get('/playbooks', (req, res) => {
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
  res.json({ items: listPlaybooks({ activeOnly }) });
});

function parseSteps(raw: unknown): PlaybookStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlaybookStep[] = [];
  raw.forEach((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const intent = typeof o.intent === 'string' ? o.intent.trim() : '';
    if (!intent) return;
    const step: PlaybookStep = { order: typeof o.order === 'number' ? o.order : i + 1, intent };
    if (typeof o.toolHint === 'string') step.toolHint = o.toolHint;
    if (typeof o.note === 'string') step.note = o.note;
    out.push(step);
  });
  return out;
}

// 用户新建/编辑一份权威 playbook（教 AI 这类任务怎么做）。
playbooksRouter.post('/playbooks', (req, res) => {
  const body = req.body ?? {};
  const taskTypeKey = typeof body.taskTypeKey === 'string' ? body.taskTypeKey.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const steps = parseSteps(body.steps);
  if (!taskTypeKey || !title || steps.length === 0) {
    return res.status(400).json({ error: 'taskTypeKey / title / steps(非空) 必填' });
  }
  const pb = userUpsertPlaybook({ taskTypeKey, title, steps });
  writeAudit({ action: 'playbook_user_upsert', reason: `用户编写 playbook：${title}`, payload: { taskTypeKey, steps: steps.length } });
  res.json({ ok: true, playbook: pb });
});

// 批准一份蒸馏草稿 → 升为权威。
playbooksRouter.post('/playbooks/:key/approve', (req, res) => {
  const pb = approvePlaybook(req.params.key);
  if (!pb) return res.status(404).json({ error: 'playbook not found' });
  writeAudit({ action: 'playbook_approved', reason: `用户批准 playbook：${pb.title}`, payload: { taskTypeKey: pb.taskTypeKey } });
  res.json({ ok: true, playbook: pb });
});

// 停用/启用。
playbooksRouter.post('/playbooks/:key/active', (req, res) => {
  const active = (req.body ?? {}).active !== false;
  const pb = setPlaybookActive(req.params.key, active);
  if (!pb) return res.status(404).json({ error: 'playbook not found' });
  writeAudit({ action: 'playbook_active_set', reason: `用户${active ? '启用' : '停用'} playbook：${pb.title}`, payload: { taskTypeKey: pb.taskTypeKey, active } });
  res.json({ ok: true, playbook: pb });
});

// 单查（前端编辑前拉详情用）。
playbooksRouter.get('/playbooks/:key', (req, res) => {
  const pb = getPlaybookByType(req.params.key);
  if (!pb) return res.status(404).json({ error: 'playbook not found' });
  res.json({ playbook: pb });
});
