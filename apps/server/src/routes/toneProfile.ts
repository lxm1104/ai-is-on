/**
 * 「模仿」模块 —— 语气画像的读写 API。
 *
 * GET  /api/tone-profile      读取当前生效画像（用户覆盖优先，否则默认种子）
 * PUT  /api/tone-profile      写入用户自定义画像；空串 = 清除覆盖回落默认
 *
 * 写入后立即重新物化 agent 文件（syncOpencodeAgents），让新语气下次调用即生效，
 * 无需重启服务。
 */
import { Router } from 'express';
import {
  DEFAULT_TONE_PROFILE_MD,
  getToneProfileMd,
  isToneProfileCustomized,
  setToneProfileMd,
} from '../context/toneProfile.js';
import { syncOpencodeAgents } from '../opencode/agents.js';

export const toneProfileRouter = Router();

toneProfileRouter.get('/tone-profile', (_req, res) => {
  res.json({
    md: getToneProfileMd(),
    customized: isToneProfileCustomized(),
    default: DEFAULT_TONE_PROFILE_MD,
  });
});

toneProfileRouter.put('/tone-profile', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.md !== 'string') {
    res.status(400).json({ error: 'md (string) required' });
    return;
  }
  setToneProfileMd(body.md);
  // 重新物化 agent 文件，使新画像立即生效。
  try {
    syncOpencodeAgents();
  } catch (err) {
    res.status(500).json({
      error: `saved but re-sync failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  res.json({
    md: getToneProfileMd(),
    customized: isToneProfileCustomized(),
    default: DEFAULT_TONE_PROFILE_MD,
  });
});
