import { randomUUID } from 'node:crypto';
import {
  type ActionProposalRow,
  insertActionProposal,
  db,
} from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import { writeAudit } from '../boundary/auditLog.js';
import type { AgentHandler } from './agentRegistry.js';
import { setSetting } from '../db.js';

/**
 * MVP6.1 daily_digest agent. Pure local — no LLM.
 *
 * 任务：把"过去 24h 内、boundary 已经把 status 标成 'batched' 的卡片"+"未处理的
 * P2/P3 卡片" 一次性合成一张"日报"，并把原卡 status→done，附 audit_log。
 * 每天最多出一张，避免重复。
 */

const LOOKBACK_MS = 24 * 3600_000;

export const dailyDigestHandler: AgentHandler = async ({ trigger, agentRunId }) => {
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT id, priority, source, title, summary, status, created_at
       FROM cards
       WHERE status IN ('batched','new')
         AND priority IN ('P2','P3')
         AND created_at > ?
       ORDER BY priority, created_at DESC
       LIMIT 30`
    )
    .all(cutoff) as Array<{
    id: string;
    priority: string;
    source: string;
    title: string;
    summary: string;
    status: string;
    created_at: string;
  }>;

  if (rows.length === 0) {
    return {
      summary: 'daily_digest skipped (no low-priority cards in last 24h)',
      proposalIds: [],
      cardIds: [],
    };
  }

  // Build digest body
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }
  const lines: string[] = [`过去 24h 收到 ${rows.length} 条低优先级信号，已自动合并：`, ''];
  for (const [src, items] of bySource) {
    lines.push(`【${labelSource(src)}】`);
    for (const it of items.slice(0, 8)) {
      lines.push(`- [${it.priority}] ${it.title}`);
    }
    if (items.length > 8) lines.push(`  …还有 ${items.length - 8} 条`);
  }

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: agentRunId,
    proposal_type: 'daily_digest',
    title: `日报：过去 24h · ${rows.length} 条低优先级`,
    body: lines.join('\n'),
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 0,
    status: 'projected',
    payload_json: JSON.stringify({
      priority: 'P3',
      cardCount: rows.length,
      triggerId: trigger.id,
      sources: Array.from(bySource.keys()),
    }),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  const card = createCardFromProposal({
    proposal,
    agentType: 'daily_digest',
    priority: 'P3',
    source: 'agent',
    reason: '过去 24h 多条低优先级信号被合并为日报',
    triggerType: trigger.trigger_type,
    scope: 'work',
    actions: [
      { id: 'ack', label: '看过了', kind: 'ack' },
      { id: 'dismiss', label: '不需要日报', kind: 'dismiss' },
    ],
  });

  // 把原卡 status 改为 done，写 audit
  const idList = rows.map((r) => r.id);
  if (idList.length > 0) {
    const placeholders = idList.map(() => '?').join(',');
    db.prepare(`UPDATE cards SET status='done', updated_at=? WHERE id IN (${placeholders})`).run(
      now,
      ...idList
    );
    for (const r of idList) {
      writeAudit({
        action: 'card_batched_into_digest',
        reason: `合入日报 ${proposalId}`,
        cardId: r,
        payload: { digestProposalId: proposalId },
      });
    }
  }

  // Record last digest time so the trigger evaluator can avoid spamming.
  setSetting('last_digest_at', now);

  return {
    summary: `daily_digest: ${rows.length} cards merged${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: { cardCount: rows.length, sources: Array.from(bySource.keys()) },
  };
};

function labelSource(src: string): string {
  switch (src) {
    case 'calendar': return '日历';
    case 'im': return '@我 / 群';
    case 'mail': return '邮件';
    case 'drive': return '文档';
    case 'manual': return '手动';
    case 'agent': return 'Agent';
    default: return src;
  }
}
