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
import { resolveAttentionSignalDetails, signalIdsForOrigin } from '../cards/contextProjection.js';
import { matchMatterId } from '../db.js';
import { getMatterById } from '../matter/matterStore.js';

export function projectAttentionItemToCard(item: AttentionItem): SignalCard {
  // 后续："查看原始信息"——若所有 signal 指向同一个 url，就透出为顶层 sourceUrl，
  // 让卡片直接出现"打开原文 ↗"按钮（多个不同 url 时不强行选一个，留给抽屉展示）。
  let inferredSourceUrl: string | undefined;
  const originIds = signalIdsForOrigin(item);
  if (originIds.length > 0) {
    const details = resolveAttentionSignalDetails(originIds);
    const urls = Array.from(
      new Set(details.map((d) => d.url).filter((u): u is string => !!u))
    );
    if (urls.length === 1) inferredSourceUrl = urls[0];
  }

  // MVP32：acted + 绑定 matter 已 resolved → 投影成 'done'（已处理抽屉里诚实显示「已完成」），
  // 并透出办结核实结果。matter_id 可能是 LLM 截断前缀（MVP29D），统一 matchMatterId 还原。
  // 只对 acted item 多做这 1-2 次单行查询；live 卡片不付此成本。
  let status = mapAttentionStatus(item.status);
  let verification: SignalCard['verification'];
  if (item.status === 'acted' && item.matterId) {
    const fullMatterId = matchMatterId(item.matterId);
    const matter = fullMatterId ? getMatterById(fullMatterId) : null;
    if (matter?.status === 'resolved') {
      status = 'done';
      if (matter.resolveVerification) {
        verification = {
          verdict: matter.resolveVerification.verdict,
          evidence: matter.resolveVerification.evidence || undefined,
          checkedAt: matter.resolveVerification.checkedAt,
        };
      }
    }
  }

  return {
    id: item.id,
    priority: item.priority,
    source: 'agent',
    title: item.title,
    summary: item.why,
    reason: item.why,
    suggestedAction: item.suggestedAction ?? undefined,
    status,
    actions: defaultAttentionActions(item),
    rawEventId: item.signalIds[0] ?? undefined,
    sourceUrl: inferredSourceUrl,
    sourceKind: 'agent_run' as CardSourceKind,
    sourceRefId: item.id,
    verification,
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
  // MVP31：办结提案卡（chatConclusionService 产）专属动作组 —— 确认即回写 matter 状态。
  // 「忽略」语义 = 不办结、继续跟进（卡片消失，matter 不动）。
  if (item.inputHash.startsWith('proposal:matter-resolve:')) {
    return [
      { id: 'matter_resolve', label: '确认办结', kind: 'matter_resolve' },
      { id: 'dismiss', label: '还没完，继续跟', kind: 'dismiss' },
    ];
  }

  // MVP40：进展回执卡（自主排查 progressed/blocked 产）——AI 已查清进展，用户「知道了/办结/继续跟进」。
  // 「继续跟进」走 dismiss 通道但不学 not_relevant 负反馈（cardsService 按前缀豁免）。
  if (item.inputHash.startsWith('proposal:matter-progress:')) {
    return [
      { id: 'ack', label: '知道了', kind: 'ack' },
      { id: 'matter_resolve', label: '办结', kind: 'matter_resolve' },
      { id: 'dismiss', label: '继续跟进', kind: 'dismiss' },
    ];
  }

  // MVP32：核实存疑提案卡（matterVerifyService 产）——用户裁决"重开跟进"还是"确实已完成"。
  // 「确实已完成」走 dismiss 通道但不学 not_relevant 负反馈（cardsService 按前缀白名单豁免）。
  if (item.inputHash.startsWith('proposal:matter-reopen:')) {
    return [
      { id: 'matter_reopen', label: '重新打开', kind: 'matter_reopen' },
      { id: 'dismiss', label: '确实已完成', kind: 'dismiss' },
    ];
  }

  // MVP69：「需要你帮忙」求助卡 —— AI 卡住、明确缺一件具体的事。「补充给 AI」走 mark_done(needhelp 支路)：
  // 把用户补的内容落成挂该 matter 的外部证据 → MVP66 下一 tick 自动解封重查。「不用了」走 dismiss(豁免负反馈)。
  if (item.inputHash.startsWith('proposal:matter-needhelp:')) {
    return [
      { id: 'mark_done', label: '补充给 AI 接着查', kind: 'mark_done' },
      { id: 'dismiss', label: '不用了', kind: 'dismiss' },
    ];
  }

  // MVP67/71：「你欠的承诺，查无跟进」提醒 —— 你来决定：补一句进展(AI 接着办)/办结/不再跟进。
  // MVP71：原「我来跟进」是空 ack（什么都没接住）→ 换成「补一句进展」走 mark_done(dangling 支路)：
  // 把你补的真实状态落成 card_action 证据 → KEYSTONE 喂回重查 → AI 据此接着办（推进/办结）。空补则等同收下。
  if (item.inputHash.startsWith('proposal:matter-dangling:')) {
    return [
      { id: 'mark_done', label: '补一句进展，AI 接着办', kind: 'mark_done' },
      { id: 'matter_resolve', label: '标记办结', kind: 'matter_resolve' },
      { id: 'dismiss', label: '不再跟进', kind: 'dismiss' },
    ];
  }

  // MVP74/P1-6：「交付件」卡 —— AI 产出最推进一步的可执行件（code_fix 修复方案 / task_spec 待建任务 /
  // decision_brief 决策信息包），卡正文已含全部内容。动作通用于三种 kind：
  // 「复制」纯前端 clipboard（kind:'copy'，零后端、不用死的 open_source）；「让 AI 接着办」走 ask_agent
  //（起草补丁/帮建任务/继续拉齐）；「办结」=matter_resolve；「继续跟进」走 dismiss（豁免负反馈）。
  if (item.inputHash.startsWith('proposal:matter-artifact:')) {
    return [
      { id: 'copy_fix', label: '复制内容', kind: 'copy' },
      { id: 'ask_agent', label: '让 AI 接着办', kind: 'ask_agent' },
      { id: 'matter_resolve', label: '办结', kind: 'matter_resolve' },
      { id: 'dismiss', label: '继续跟进', kind: 'dismiss' },
    ];
  }

  // MVP75：「💡 我的建议」卡 —— AI 给了建议 + 直接起草好的成品（卡正文含全文）。参与入口要清晰：
  // 「复制去发」纯前端复制卡正文（含起草的话术，你粘到飞书发）；「让 AI 改一版」走 ask_agent 到右侧会话细改；
  // 「我发了·办结」走 matter_resolve（你按建议办完了→办结）；「先不弄」走 dismiss（豁免负反馈，是裁决非不相关）。
  if (item.inputHash.startsWith('proposal:matter-reco:')) {
    return [
      { id: 'copy_reco', label: '复制去发', kind: 'copy' },
      { id: 'ask_agent', label: '让 AI 改一版', kind: 'ask_agent' },
      { id: 'matter_resolve', label: '我发了·办结', kind: 'matter_resolve' },
      { id: 'dismiss', label: '先不弄', kind: 'dismiss' },
    ];
  }

  // MVP55：AI 已主动办结回执 —— 透明 + 可逆。「知道了」收下，「重开」一键撤销自动办结。
  if (item.inputHash.startsWith('proposal:matter-autoresolved:')) {
    return [
      { id: 'ack', label: '知道了', kind: 'ack' },
      { id: 'matter_reopen', label: '重开', kind: 'matter_reopen' },
    ];
  }

  const actions: CardAction[] = [];

  // MVP32：绑定 Matter 的卡片头部给「已处理」——用户在系统外办完事的一键闭环
  // （resolve matter + 落处理说明 + 清同事项催办）。无 matter 的卡不出（与「知道了」无差别，避免按钮通胀）。
  if (item.matterId) {
    actions.push({ id: 'mark_done', label: '已处理', kind: 'mark_done' });
  }

  actions.push({ id: 'ack', label: '知道了', kind: 'ack' });

  // MVP23：有处理角度 → 逐个投影成 'opt:<id>' 角度按钮（kind 仍是 ask_agent，复用执行通道）。
  //   directive 不下发前端，由 applyAttentionAction 按 id 在后端取回。
  // 无角度（未生成/已降级）→ 退回单个通用「让 AI 处理」。
  if (item.actionOptions?.length) {
    for (const opt of item.actionOptions) {
      actions.push({
        id: `opt:${opt.id}`,
        label: opt.label,
        // M2：create_task 角度投影成 'create_task' kind，前端路由到建任务确认通道；
        //   其余角度仍是 ask_agent，走右侧 Claude 出草稿。
        kind: opt.executor === 'create_task' ? 'create_task' : 'ask_agent',
      });
    }
  } else {
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
