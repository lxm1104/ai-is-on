import { randomUUID } from 'node:crypto';
import { type ActionProposalRow, insertActionProposal } from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import type { AgentHandler } from './agentRegistry.js';
import { decodeSemanticTags } from '../context/semanticTags.js';
import type { CardAction } from '../claude/protocol.js';

/**
 * MVP11.0-b docCommentAgent — 零 LLM，把一条 doc_comment_attention trigger
 * 投影成一张 P1 卡片。actions：
 *   - 复用现有 ask_agent 通道让 AI 起草回复（前端可额外传 extraPrompt 覆盖默认）
 *   - open_source：打开原文
 *   - ack / dismiss / auto_henceforth：标准
 */
export const docCommentHandler: AgentHandler = async ({
  trigger,
  unit,
  agentRunId,
}) => {
  if (!unit) {
    return { summary: 'doc_comment skipped (no unit)', proposalIds: [], cardIds: [] };
  }
  const { tags } = decodeSemanticTags(unit.meaning);
  const isAtMe = tags.is_at_me === true;
  const onAuthoritativeDoc = tags.on_authoritative_doc === true;
  const docEnt = unit.entities.find((e) => e.type === 'doc');
  const authorEnt = unit.entities.find((e) => e.role === 'author');
  const authorName = authorEnt?.name ?? '某人';
  const docUrl = docEnt?.name ?? unit.entities.find((e) => e.type === 'doc')?.name;

  // 优先 is_at_me 措辞
  const title = isAtMe
    ? `${authorName} 在「${shortDocLabel(docUrl)}」@ 了你`
    : `${authorName} 在你的权威文档「${shortDocLabel(docUrl)}」加了评论`;

  const bodyLines: string[] = [];
  // unit.content 已经带了"作者：内容\n文档：url"，但首行可能冗余，拆开重排
  const contentLines = (unit.content ?? '').split('\n').filter(Boolean);
  for (const line of contentLines) {
    if (line.startsWith('文档：')) continue;
    bodyLines.push(line);
  }
  if (onAuthoritativeDoc && !isAtMe) {
    bodyLines.push('（这是你标记的权威文档）');
  }
  if (docUrl) {
    bodyLines.push(`原文：${docUrl}`);
  }
  const body = bodyLines.join('\n');

  const priority: 'P0' | 'P1' | 'P2' | 'P3' = 'P1';

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: agentRunId,
    proposal_type: 'doc_comment_attention',
    title,
    body,
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 0,
    status: 'projected',
    payload_json: JSON.stringify({
      priority,
      contextUnitId: unit.id,
      triggerId: trigger.id,
      isAtMe,
      onAuthoritativeDoc,
      docUrl,
      authorName,
    }),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  const actions: CardAction[] = [
    {
      id: 'draft_reply',
      label: '让 AI 起草回复',
      kind: 'ask_agent',
      prompt: defaultDraftPrompt(authorName, docUrl, body),
    },
    ...(docUrl
      ? [{ id: 'open_source', label: '打开原文', kind: 'open_source' as const }]
      : []),
    { id: 'ack', label: '知道了', kind: 'ack' },
    { id: 'dismiss', label: '忽略这类', kind: 'dismiss' },
  ];

  const card = createCardFromProposal({
    proposal,
    agentType: 'doc_comment',
    priority,
    source: 'drive',
    reason: trigger.reasoning ?? '文档评论需要关注',
    sourceUrl: docUrl,
    actions,
    triggerType: trigger.trigger_type,
    kind: unit.kind,
    entities: unit.entities.map((e) => ({ type: e.type, name: e.name })),
    scope: 'work',
  });

  return {
    summary: `doc_comment P1 from ${authorName}${isAtMe ? ' (@me)' : ''}${
      onAuthoritativeDoc ? ' (auth doc)' : ''
    }${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: { isAtMe, onAuthoritativeDoc },
  };
};

function shortDocLabel(url?: string): string {
  if (!url) return '某文档';
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    const tail = seg[seg.length - 1];
    if (!tail) return u.host;
    return tail.length > 10 ? `${tail.slice(0, 8)}…` : tail;
  } catch {
    return url.slice(0, 16);
  }
}

function defaultDraftPrompt(author: string, url: string | undefined, body: string): string {
  return [
    `请帮我针对以下文档评论起草一段简短的中文回复（≤120 字，直接、不客套）：`,
    `评论作者：${author}`,
    url ? `文档：${url}` : '',
    `评论内容：`,
    body,
  ]
    .filter(Boolean)
    .join('\n');
}
