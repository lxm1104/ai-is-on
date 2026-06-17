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

/**
 * MVP60：日报带实证——把过去 24h「AI 自主排查实际查清的结论」(investigation_written_back /
 * matter_auto_resolved 审计行) 汇成一段，让日报不只是低优信号合并，而是「AI 今天替你查清了什么」的回执。
 * 纯本地、只读、按事项去重(自主办结 > 一般查清，取最新一条)。
 */
type AiFinding = { matterId: string; verdict: string; fact: string; autoResolved: boolean; title: string; status: string };
function collectAiFindings(cutoff: string): AiFinding[] {
  const rows = db
    .prepare(
      `SELECT a.action, a.reason, a.payload_json, m.title AS title, m.status AS status
       FROM audit_logs a
       JOIN matters m ON m.id = json_extract(a.payload_json, '$.matterId')
       WHERE a.action IN ('investigation_written_back','matter_auto_resolved')
         AND a.created_at > ?
       ORDER BY a.created_at DESC
       LIMIT 60`
    )
    .all(cutoff) as Array<{ action: string; reason: string; payload_json: string | null; title: string; status: string }>;
  const byMatter = new Map<string, AiFinding>();
  for (const r of rows) {
    let p: any = {};
    try { p = r.payload_json ? JSON.parse(r.payload_json) : {}; } catch { p = {}; }
    const matterId = p.matterId as string | undefined;
    if (!matterId) continue;
    const autoResolved = r.action === 'matter_auto_resolved';
    // factSummary 直接在 matter_auto_resolved 的 payload；investigation_written_back 取 reason「：」后的事实句
    const fact = (p.factSummary as string) || r.reason.split('：').slice(1).join('：') || r.reason;
    const finding: AiFinding = {
      matterId, verdict: (p.verdict as string) || (autoResolved ? 'resolved' : 'unknown'),
      fact: fact.trim(), autoResolved, title: r.title, status: r.status,
    };
    const prev = byMatter.get(matterId);
    // 同一事项：自主办结优先；否则保留最新(rows 已按时间倒序，先到的即最新)
    if (!prev || (autoResolved && !prev.autoResolved)) byMatter.set(matterId, finding);
  }
  return Array.from(byMatter.values());
}

function verdictLabel(v: string, autoResolved: boolean): string {
  if (autoResolved) return '✅ 已自主办结';
  switch (v) {
    case 'resolved': return '✅ 疑似已完成';
    case 'progressed': return '🔵 有进展';
    case 'blocked': return '⛔ 受阻';
    default: return '🔍 已查';
  }
}

export const dailyDigestHandler: AgentHandler = async ({ trigger, agentRunId }) => {
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const aiFindings = collectAiFindings(cutoff);
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

  // MVP60：低优信号 + AI 实证 任一非空才出日报；两者皆空才跳过(否则会漏掉「AI 当天查清」回执)。
  if (rows.length === 0 && aiFindings.length === 0) {
    return {
      summary: 'daily_digest skipped (no low-priority cards or AI findings in last 24h)',
      proposalIds: [],
      cardIds: [],
    };
  }

  // Build digest body
  const lines: string[] = [];

  // MVP60：AI 实证段置顶——日报先说「AI 今天替你查清了什么」(待你过目)，再列低优信号。
  if (aiFindings.length > 0) {
    lines.push(`🔍 AI 当天自主查清 ${aiFindings.length} 件（待你过目）：`, '');
    for (const f of aiFindings.slice(0, 12)) {
      lines.push(`- ${verdictLabel(f.verdict, f.autoResolved)}｜${f.title}`);
      if (f.fact) lines.push(`  ${f.fact.slice(0, 140)}`);
    }
    if (aiFindings.length > 12) lines.push(`  …还有 ${aiFindings.length - 12} 件`);
    if (rows.length > 0) lines.push('');
  }

  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }
  if (rows.length > 0) lines.push(`过去 24h 收到 ${rows.length} 条低优先级信号，已自动合并：`, '');
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
    title: aiFindings.length > 0
      ? `日报：AI 查清 ${aiFindings.length} 件 · ${rows.length} 条低优先级`
      : `日报：过去 24h · ${rows.length} 条低优先级`,
    body: lines.join('\n'),
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 0,
    status: 'projected',
    payload_json: JSON.stringify({
      priority: 'P3',
      cardCount: rows.length,
      aiFindingCount: aiFindings.length,
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
    summary: `daily_digest: ${rows.length} cards merged, ${aiFindings.length} AI findings${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: { cardCount: rows.length, aiFindingCount: aiFindings.length, sources: Array.from(bySource.keys()) },
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
