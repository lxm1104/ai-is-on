/**
 * MVP39 — 升「确认办结」提案卡的共享 helper（MVP31 起多处复用：聊天结论、自主排查结论…）。
 *
 * AI 在某处得出"这件事疑似已完成"的高置信结论 → 升一张提案卡，用户一键确认 = userResolveMatter，
 * 相关催办卡下轮 tick 自动清除。幂等：同事项已有在场办结提案则跳过。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { insertAttentionItem } from '../attention/attentionStore.js';
import { broadcast } from '../ws.js';
import type { Matter } from './matterTypes.js';

export const MATTER_RESOLVE_PROPOSAL_PREFIX = 'proposal:matter-resolve:';

/** 升办结提案卡。已 resolved/dropped 或已有在场提案 → 跳过。返回是否真的升了。 */
export function raiseMatterResolveProposal(
  matter: Matter,
  opts: { why: string; suggestedAction?: string }
): boolean {
  if (matter.status === 'resolved' || matter.status === 'dropped') return false;
  const proposalHash = `${MATTER_RESOLVE_PROPOSAL_PREFIX}${matter.id}`;
  const existing = db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(proposalHash);
  if (existing) return false;

  insertAttentionItem({
    id: randomUUID(),
    generation: 0, // 系统提案不参与 LLM 代际
    llmRunId: null,
    inputHash: proposalHash,
    llmItem: {
      priority: 'P1',
      title: `确认办结：${matter.title.slice(0, 40)}`,
      why: opts.why,
      suggestedAction: opts.suggestedAction ?? '确认办结，或忽略保持跟进',
      signalIds: [],
      matterId: matter.id,
    },
    now: new Date().toISOString(),
  });
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
  return true;
}
