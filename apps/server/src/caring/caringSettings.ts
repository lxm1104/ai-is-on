import { getSetting, setSetting } from '../db.js';

const KEY = 'caring_paused';
const DEFAULT_PAUSED = false; // MVP4 default: caring on

export function isCaringPaused(): boolean {
  const v = getSetting(KEY);
  if (v === null) return DEFAULT_PAUSED;
  return v === '1' || v === 'true';
}

export function setCaringPaused(paused: boolean): void {
  setSetting(KEY, paused ? '1' : '0');
}

/**
 * §6.5 硬开关效果（散落各处使用本函数判断）：
 * - triagePrompt 注入时附加 "不要提取 emotion/self_narrative"
 * - activeContext 过滤 kind=emotion/self_narrative
 * - Caring Agent (MVP4.1) 不启动
 * - check-in trigger (MVP4.1) 不触发
 */
