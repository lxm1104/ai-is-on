/**
 * MVP53 — 设置类只读 API：目前承载「自主排查只读 CLI 白名单」的查看 / 改 / 恢复默认。
 *
 * 白名单是安全敏感面（给无人在环的自主 AI 用）。后端 readClisSettings 已做硬拒黑名单 + 校验，
 * 这里只做薄包装：GET 给前端展示（含风险分级），POST 改（逐项校验，违规 400），reset 恢复默认；
 * 每次写都落 audit（可追溯谁/何时改了排查工具的可执行边界）。
 */
import { Router } from 'express';
import {
  describeReadClis,
  setInvestigationReadClis,
  resetInvestigationReadClis,
} from '../investigation/readClisSettings.js';
import { writeAudit } from '../boundary/auditLog.js';

export const settingsRouter = Router();

settingsRouter.get('/settings/cli-whitelist', (_req, res) => {
  res.json(describeReadClis());
});

settingsRouter.post('/settings/cli-whitelist', (req, res) => {
  const body = (req.body ?? {}) as { clis?: unknown };
  if (!Array.isArray(body.clis)) {
    res.status(400).json({ error: 'clis (string[]) required' });
    return;
  }
  // 校验失败（含 DENY 黑名单命中）→ 400，错误信息直给前端展示。
  let saved: string[];
  try {
    saved = setInvestigationReadClis(body.clis);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  // 落库成功后再 audit / 取描述：这里若抛是 DB 故障 → 500（不要误当成校验 400）。
  try {
    writeAudit({
      action: 'investigation_clis_edited',
      reason: `用户修改自主排查只读 CLI 白名单（${saved.length} 项）`,
      payload: { clis: saved },
    });
    res.json(describeReadClis());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

settingsRouter.post('/settings/cli-whitelist/reset', (_req, res) => {
  try {
    resetInvestigationReadClis();
    writeAudit({
      action: 'investigation_clis_edited',
      reason: '用户将自主排查只读 CLI 白名单恢复默认',
    });
    res.json(describeReadClis());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
