// MVP14 Step 2: AttentionItem → SignalCard 投影。
// 让前端 CardList 不动结构就能消费 attention items。
//
// 设计要点：
// - status 映射：live→'new'（露在待处理）；acted→'acknowledged'（露在已处理抽屉）；
//   dismissed/superseded/expired→'dismissed'（完全不露）
// - source='agent'，复用现有 SignalCard.source 联合
// - sourceKind='agent_run'，sourceRefId=item.id（applyCardAction 通过这个识别）
// - actions: 默认给 ack / ask_agent / dismiss 三个；recommendedAgent 影响 ask_agent.prompt

import type {
  CardAction,
  CardSourceKind,
  CardStatus,
  SignalCard,
} from '../claude/protocol.js';
import type { AttentionItem, AttentionStatus } from './attentionTypes.js';

export function projectAttentionItemToCard(item: AttentionItem): SignalCard {
  return {
    id: item.id,
    priority: item.priority,
    source: 'agent',
    title: item.title,
    summary: item.why,
    reason: item.why,
    suggestedAction: item.suggestedAction ?? undefined,
    status: mapAttentionStatus(item.status),
    actions: defaultAttentionActions(item),
    rawEventId: item.signalIds[0] ?? undefined,
    sourceKind: 'agent_run' as CardSourceKind,
    sourceRefId: item.id,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function mapAttentionStatus(status: AttentionStatus): CardStatus {
  switch (status) {
    case 'live':
      return 'new';
    case 'acted':
      return 'acknowledged';
    case 'dismissed':
    case 'superseded':
    case 'expired':
      return 'dismissed';
    default:
      return 'new';
  }
}

export function defaultAttentionActions(item: AttentionItem): CardAction[] {
  const actions: CardAction[] = [
    { id: 'ack', label: '知道了', kind: 'ack' },
  ];

  if (item.recommendedAgent) {
    actions.push({
      id: 'ask_agent',
      label: '让 AI 处理',
      kind: 'ask_agent',
      prompt: buildAskAgentPrompt(item),
    });
  } else {
    // 没明确推荐 agent 也给个通用 "让 AI 处理"
    actions.push({
      id: 'ask_agent',
      label: '让 AI 处理',
      kind: 'ask_agent',
      prompt: buildAskAgentPrompt(item),
    });
  }

  actions.push({ id: 'dismiss', label: '忽略', kind: 'dismiss' });

  return actions;
}

function buildAskAgentPrompt(item: AttentionItem): string {
  const parts: string[] = [
    '请协助处理以下需要关注的事情：',
    `标题：${item.title}`,
    `背景：${item.why}`,
  ];
  if (item.suggestedAction) {
    parts.push(`建议动作：${item.suggestedAction}`);
  }
  if (item.recommendedAgent) {
    parts.push(`（系统建议调用 ${item.recommendedAgent} 类型的能力）`);
  }
  if (item.signalIds.length) {
    parts.push(
      `相关 context unit / event id：${item.signalIds.slice(0, 6).join(', ')}`
    );
  }
  return parts.join('\n');
}
