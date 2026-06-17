/**
 * MVP61 会前自动拉齐：为一个即将开始的会议，确定性地汇总「与参会人之间的未了往来」——
 *   - 我欠对方（owner=自己 的 open matter）
 *   - 对方欠我（owner=参会人 的 open matter）
 *   - 相关跟进（与参会人共担、owner 不明）
 * 每条带「上次结论」(currentSummary，含自主排查写回的 [AI 排查]…) + 「待答/下一步」(nextAction)。
 *
 * 纯本地、只读、确定性——不调 LLM、不触发新排查（会议前要低延迟；matters 的 currentSummary
 * 已承载排查 loop 的最新结论，直接复用即可，省 token、不从 0 探索）。
 */
import { db, getSetting } from '../db.js';
import { resolveAliased } from '../context/entityResolver.js';

export type MeetingLedgerItem = {
  matterId: string;
  title: string;
  summary: string; // 上次结论（currentSummary）
  nextAction: string; // 待答/下一步
  priority: string;
};

export type MeetingLedger = {
  iOwe: MeetingLedgerItem[]; // 我欠对方
  owedToMe: MeetingLedgerItem[]; // 对方欠我
  related: MeetingLedgerItem[]; // 共担/owner 不明
};

const EMPTY: MeetingLedger = { iOwe: [], owedToMe: [], related: [] };

export function gatherMeetingLedger(meetingUnitId: string, limit = 12): MeetingLedger {
  const selfRaw = getSetting('self_person_entity_id') ?? '';
  const self = selfRaw ? resolveAliased(selfRaw) : '';

  // 参会人 entity ids（会议 unit 关联的实体，去掉自己）
  const attRows = db
    .prepare(`SELECT DISTINCT entity_id FROM context_unit_entities WHERE context_unit_id = ?`)
    .all(meetingUnitId) as Array<{ entity_id: string }>;
  const attendeeIds = new Set<string>();
  for (const r of attRows) {
    const id = resolveAliased(r.entity_id);
    if (id && id !== self) attendeeIds.add(id);
  }
  if (attendeeIds.size === 0) return EMPTY;

  // 与任一参会人共担的 open/in_progress matter（排除会议自身派生的 matter）
  const placeholders = Array.from(attendeeIds).map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT m.id AS id, m.title AS title, m.owner_entity_id AS owner,
              m.current_summary AS summary, m.next_action AS next_action,
              m.priority AS priority, m.updated_at AS updated_at
       FROM matters m
       JOIN matter_entities me ON me.matter_id = m.id
       WHERE m.status IN ('open','in_progress')
         AND m.created_from_context_unit_id != ?
         AND me.entity_id IN (${placeholders})
       ORDER BY m.priority ASC, m.updated_at DESC
       LIMIT ?`
    )
    .all(meetingUnitId, ...Array.from(attendeeIds), limit) as Array<{
    id: string; title: string; owner: string | null;
    summary: string; next_action: string | null; priority: string; updated_at: string;
  }>;

  const ledger: MeetingLedger = { iOwe: [], owedToMe: [], related: [] };
  for (const r of rows) {
    const item: MeetingLedgerItem = {
      matterId: r.id,
      title: r.title,
      summary: (r.summary || '').trim(),
      nextAction: (r.next_action || '').trim(),
      priority: r.priority,
    };
    const owner = r.owner ? resolveAliased(r.owner) : '';
    if (owner && owner === self) ledger.iOwe.push(item);
    else if (owner && attendeeIds.has(owner)) ledger.owedToMe.push(item);
    else ledger.related.push(item);
  }
  return ledger;
}

export function isLedgerEmpty(l: MeetingLedger): boolean {
  return l.iOwe.length === 0 && l.owedToMe.length === 0 && l.related.length === 0;
}

/** 渲染成可直接进卡片正文 / prompt 的确定性段落（不依赖 LLM 是否复述）。 */
export function renderLedgerBlock(l: MeetingLedger): string {
  if (isLedgerEmpty(l)) return '';
  const lines: string[] = ['📋 与参会人未了往来：'];
  const section = (label: string, items: MeetingLedgerItem[]) => {
    if (!items.length) return;
    lines.push(`【${label}】`);
    for (const it of items.slice(0, 6)) {
      lines.push(`- [${it.priority}] ${it.title}`);
      if (it.summary) lines.push(`  上次：${it.summary.slice(0, 120)}`);
      if (it.nextAction) lines.push(`  待答：${it.nextAction.slice(0, 80)}`);
    }
  };
  section('我欠对方', l.iOwe);
  section('对方欠我', l.owedToMe);
  section('相关跟进', l.related);
  return lines.join('\n');
}
