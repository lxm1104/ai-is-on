/**
 * MVP70 — AI 自我感官健康自检（tripwire）。
 *
 * 教训（2026-06-18）：IM 搜索结果解析 bug 让每次搜索都报"0 条"，AI 误判"查不到"长达数周、
 * 产出 55% unknown，却没人察觉。根因之一是**AI 不会怀疑自己的工具**——查到 95 条真实名字却
 * "0 命中"时，本该想"是不是我瞎了"，而不是闷头下"查不到"。
 *
 * 这里维护一个**内存滚动窗口**记录"感官类只读工具"的命中/空/失败，当近期几乎全空时——这在搜真实
 * 关键词的情况下统计上几乎不可能——升一张**去重的系统提醒**："AI 的飞书读取疑似失效，建议检查"。
 * 内存态（重启即清）：度量的是**当前**健康，不被历史脏数据污染，修好后随新查询自愈。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { insertAttentionItem } from '../attention/attentionStore.js';
import { broadcast } from '../ws.js';

export const READ_TOOL_HEALTH_HASH = 'system:read-tool-health';

type Outcome = 'hit' | 'empty' | 'fail';
const WINDOW = 40;
const ring: Outcome[] = [];
// "感官类"：从外部系统取信息的只读工具（run_command 查本地代码不算——它一直正常）。
const SENSING_TOOLS = new Set(['search_im_messages', 'read_chat_messages', 'list_my_tasks']);
// "N 条"里的 0（"10 条"不算）：0 前面不是数字。
const EMPTY_RE = /(?:^|[^0-9])0\s*条/;

/** 记一次感官工具的结果（loop 每步调用）。导出供测试。 */
export function recordReadOutcome(tool: string, ok: boolean, summary: string): void {
  if (!SENSING_TOOLS.has(tool)) return;
  const o: Outcome = !ok ? 'fail' : EMPTY_RE.test(summary) ? 'empty' : 'hit';
  ring.push(o);
  if (ring.length > WINDOW) ring.shift();
}

export function getReadToolHealth(): { total: number; bad: number; badRate: number } {
  const total = ring.length;
  const bad = ring.filter((o) => o !== 'hit').length;
  return { total, bad, badRate: total ? bad / total : 0 };
}

/** 纯函数判据：样本够多 + 坏比例过高 → 疑似感官失效。导出供测试。 */
export function isSensingLikelyBroken(h: { total: number; badRate: number }, minSamples = 12, badThreshold = 0.9): boolean {
  return h.total >= minSamples && h.badRate >= badThreshold;
}

function hasLiveHealthAlert(): boolean {
  return !!db.prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash=? LIMIT 1`).get(READ_TOOL_HEALTH_HASH);
}

/** 自检 + 必要时升一张去重的系统提醒。fire-and-forget，排查结束后调。 */
export function maybeAlertReadToolHealth(): boolean {
  const h = getReadToolHealth();
  if (!isSensingLikelyBroken(h)) return false;
  if (hasLiveHealthAlert()) return false; // 去重：同时只一张
  const pct = Math.round(h.badRate * 100);
  insertAttentionItem({
    id: randomUUID(),
    generation: 0,
    llmRunId: null,
    inputHash: READ_TOOL_HEALTH_HASH,
    llmItem: {
      priority: 'P1',
      title: '🛠 AI 的飞书读取疑似失效，需要你看一下',
      why:
        `AI 近 ${h.total} 次飞书搜索/读取里有 ${h.bad} 次空手而归（${pct}%）。搜真实关键词却几乎全空，` +
        `统计上不正常——很可能是 lark-cli 登录过期 / 权限不足 / 网络问题，而非信息真不在。\n` +
        `这会让 AI 误判"查不到"。建议检查：lark-cli 是否已登录、对相关群是否有读权限。`,
      suggestedAction: '检查 lark-cli 登录与权限 / 知道了',
      signalIds: [],
    },
    now: new Date().toISOString(),
  });
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
  return true;
}
