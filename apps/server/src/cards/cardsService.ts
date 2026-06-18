import { randomUUID } from 'node:crypto';
import {
  type ActionProposalRow,
  type CardRow,
  getCard,
  insertCard,
  insertUserRule,
  listOpenCards,
  matchMatterId,
  updateCardStatus,
} from '../db.js';
import { evaluateCard, type CardCandidate } from '../boundary/boundaryEvaluator.js';
import { writeAudit } from '../boundary/auditLog.js';
import { createRule } from '../boundary/boundaryStore.js';
import type {
  BoundaryAutonomy,
  CardSourceKey,
  Priority,
} from '../boundary/BoundaryRule.js';
import { broadcast } from '../ws.js';
import { type ChatTopic, sendTopicMessage } from '../chat/chatTopics.js';
import type {
  CardAction,
  CardActionKind,
  CardStatus,
  SignalCard,
} from '../claude/protocol.js';
import {
  getAttentionItem,
  updateAttentionItemStatus,
} from '../attention/attentionStore.js';
import {
  defaultAttentionActions,
  projectAttentionItemToCard,
} from '../attention/attentionProjection.js';
import { buildRichAskAgentPrompt } from '../attention/askAgentPrompt.js';
import { applyAttentionFeedback } from '../attention/attentionFeedback.js';
import { recordAttentionInteraction } from '../attention/attentionInteractions.js';
import { enqueueAttentionTickSoon } from '../attention/attentionEngine.js';
import { userReopenMatter, userResolveMatter } from '../matter/matterActions.js';
import {
  attachMatterContextLink,
  getMatterById,
  setMatterResolveVerification,
} from '../matter/matterStore.js';
import { upsertContextUnit } from '../context/contextStore.js';
import { config } from '../config.js';
import {
  MATTER_REOPEN_PROPOSAL_PREFIX,
  scheduleMatterResolveVerification,
} from '../matter/matterVerifyService.js';
import { MATTER_NEEDHELP_PROPOSAL_PREFIX } from '../matter/matterResolveProposal.js';
import { kickInvestigation } from '../investigation/investigationKick.js';

export function rowToCard(row: CardRow): SignalCard {
  let actions: CardAction[] = [];
  try {
    actions = JSON.parse(row.actions_json) as CardAction[];
  } catch {}
  return {
    id: row.id,
    triageId: row.triage_id ?? undefined,
    priority: row.priority as SignalCard['priority'],
    source: row.source as SignalCard['source'],
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    suggestedAction: row.suggested_action ?? undefined,
    draftReply: row.draft_reply ?? undefined,
    status: row.status as CardStatus,
    actions,
    rawEventId: row.raw_event_id ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    sourceKind: (row.source_kind as SignalCard['sourceKind']) ?? 'triage',
    sourceRefId: row.source_ref_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultActionsForSource(source: string): CardAction[] {
  const ack: CardAction = { id: 'ack', label: '知道了', kind: 'ack' };
  const snooze: CardAction = { id: 'snooze', label: '稍后提醒', kind: 'snooze' };
  const dismiss: CardAction = { id: 'dismiss', label: '忽略这类', kind: 'dismiss' };
  const auto: CardAction = {
    id: 'auto_henceforth',
    label: '以后自动',
    kind: 'auto_henceforth',
  };
  const askAgent: CardAction = {
    id: 'ask_agent',
    label: '帮我处理',
    kind: 'ask_agent',
  };
  if (source === 'im') {
    return [
      { id: 'draft_reply', label: '生成回复草稿', kind: 'draft_reply' },
      askAgent,
      ack,
      auto,
      dismiss,
    ];
  }
  return [askAgent, ack, snooze, auto, dismiss];
}

// MVP14 Step 3: createCardsFromTriage 已下线。
// 旧的"per-event triage → cards"链路被 L2 attention engine 全局推理取代。
// 专项 agent（commitmentAgent / prepareMeeting / recapActionItems 等）仍可通过
// 下方的 createCardFromProposal 写卡（agent_run source_kind），但默认前端只看
// attention 投影；这些 agent 产物未来若要走 attention，会在 Step 5 改造。

export type ProposalCardInput = {
  proposal: ActionProposalRow;
  agentType: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  source: string;                     // 'agent' | 'calendar' | 'im' | ...
  reason: string;                     // 为什么生成这张卡
  suggestedAction?: string;
  draftReply?: string;
  rawEventId?: string;
  sourceUrl?: string;
  actions?: CardAction[];             // 默认走 defaultActionsForSource
  // MVP8.1 §5.4: 把这几个字段透传给 evaluateCard，让 boundary 学习/匹配更准
  triggerType?: string;
  kind?: string;
  entities?: Array<{ type: string; name: string }>;
  scope?: 'personal' | 'work' | 'team';
};

/**
 * Project an ActionProposal into a SignalCard. source_kind='agent_run',
 * source_ref_id is the proposal id, so we can trace back through audit logs.
 */
export function createCardFromProposal(input: ProposalCardInput): SignalCard | null {
  const decision = evaluateCard({
    priority: input.priority,
    source: input.source,
    scope: input.scope ?? 'work',
    kind: input.kind,
    triggerType: input.triggerType as CardCandidate['triggerType'],
    entities: input.entities,
  });
  if (decision.decision === 'block') {
    writeAudit({
      action: 'card_blocked',
      reason: decision.reason,
      ruleId: decision.matchedRule.id,
      payload: {
        proposalId: input.proposal.id,
        title: input.proposal.title,
        priority: input.priority,
        agentType: input.agentType,
      },
    });
    return null;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const actions = input.actions?.length ? input.actions : defaultActionsForSource(input.source);
  const status: SignalCard['status'] = decision.decision === 'soften' ? 'batched' : 'new';
  const row: CardRow = {
    id,
    triage_id: null,
    priority: input.priority,
    source: input.source,
    title: input.proposal.title,
    summary: input.proposal.body.slice(0, 120),
    reason: input.reason,
    suggested_action: input.suggestedAction ?? null,
    draft_reply: input.draftReply ?? null,
    status,
    actions_json: JSON.stringify(actions),
    raw_event_id: input.rawEventId ?? null,
    source_url: input.sourceUrl ?? null,
    source_kind: 'agent_run',
    source_ref_id: input.proposal.id,
    created_at: now,
    updated_at: now,
  };
  insertCard(row);
  if (decision.decision === 'soften') {
    writeAudit({
      action: 'card_softened',
      reason: decision.reason,
      cardId: id,
      ruleId: decision.matchedRule.id,
      payload: { priority: input.priority, source: input.source, agentType: input.agentType },
    });
  }
  const card = rowToCard(row);
  broadcast({ type: 'card_created', card });
  return card;
}

export function listCards(): SignalCard[] {
  return listOpenCards(100).map(rowToCard);
}

export type CardActionResult = { ok: boolean; card?: SignalCard; topic?: ChatTopic; error?: string };

export async function applyCardAction(
  cardId: string,
  actionId: string,
  opts?: { extraPrompt?: string; note?: string }
): Promise<CardActionResult> {
  // MVP14 Step 2: 同一个 id 命名空间下，先看是不是 AttentionItem。
  // 命中则走 attention 分支；不命中再走原 cards 表。
  const attn = getAttentionItem(cardId);
  if (attn) {
    return applyAttentionAction(attn, actionId, opts);
  }

  const row = getCard(cardId);
  if (!row) return { ok: false, error: 'card not found' };

  // synthetic built-in: reopen — flip status back to 'new'，前端 UI 上用得到
  if (actionId === '__reopen') {
    const now = new Date().toISOString();
    const updated = updateCardStatus(cardId, 'new', now);
    if (!updated) return { ok: false, error: 'update failed' };
    const card = rowToCard(updated);
    broadcast({ type: 'card_updated', card });
    return { ok: true, card };
  }

  let actions: CardAction[] = [];
  try {
    actions = JSON.parse(row.actions_json) as CardAction[];
  } catch {}
  const action = actions.find((a) => a.id === actionId);
  if (!action) return { ok: false, error: `unknown action ${actionId}` };

  const now = new Date().toISOString();
  const newStatus = mapKindToStatus(action.kind, row.status as CardStatus);

  if (action.kind === 'dismiss') {
    insertUserRule({
      id: randomUUID(),
      rule_type: 'dismiss_like',
      description: `用户在卡片"${row.title}"上点了"忽略这类"。Source=${row.source} Reason=${row.reason}`,
      source_card_id: row.id,
      active: 1,
      created_at: now,
    });
  }

  if (action.kind === 'auto_henceforth') {
    // MVP10.1 §6.4 推断 autonomy/reversible/impactScope：
    //   - im / mail 来源 + P0/P1 → external_always_confirm（这些路径未来可能对外发消息）
    //   - 其他 (record 类) → local_auto（合并到 daily digest，纯本地、可逆）
    const autonomy = inferAutonomy(row.source as CardSourceKey, row.priority as Priority);
    const impactScope =
      autonomy === 'external_always_confirm' ? 'shared' : 'self';
    const rule = createRule({
      scope: 'work',
      condition: {
        source: [row.source as CardSourceKey],
        priorityAtMost: row.priority as Priority,
      },
      allowedAction: 'record',
      requiresApproval: autonomy === 'external_always_confirm',
      confidence: 0.75,
      source: 'card_action',
      learnedFromCardId: row.id,
      active: true,
      autonomy,
      reversible: true,
      impactScope,
    });
    writeAudit({
      action: 'rule_learned',
      reason: `用户在卡片"${row.title}"上选择"以后自动处理"（autonomy=${autonomy}）`,
      cardId: row.id,
      ruleId: rule.id,
      payload: {
        priority: row.priority,
        source: row.source,
        autonomy,
        impactScope,
      },
    });
  }

  if (action.kind === 'ask_agent' || action.kind === 'draft_reply') {
    // MVP11.0-b：前端可传 extraPrompt 覆盖 action 自带的默认 prompt。
    // 优先级：用户输入 > action.prompt（agent 在生卡时填的）> buildDefaultPrompt 兜底。
    const userPrompt = opts?.extraPrompt?.trim();
    const prompt = userPrompt || action.prompt?.trim() || buildDefaultPrompt(row, action.kind);
    try {
      // MVP2.2: 卡片动作的内部 prompt 已经把卡片自身 context 嵌进去了，
      // 不再额外 prepend active_context summary，避免重复并节省 token。
      // MVP18 Stage 0: sendTopicMessage 同步返回 { topic, turn }，turn 后台跑。
      // turn 失败已通过 chatTopics 内部 .catch 写成 topic 内 system 消息，不会进本 try/catch。
      // 这里的 try/catch 仅兜底"建 topic / 写 user 消息阶段的同步抛错"（如 requireTopic 失败）。
      const { topic } = sendTopicMessage({
        text: prompt,
        sourceKind: 'card',
        sourceRefId: row.id,
        title: row.title,
        skipContext: true,
      });
      const updated = updateCardStatus(cardId, newStatus, now);
      if (!updated) return { ok: false, error: 'update failed' };
      const card = rowToCard(updated);
      broadcast({ type: 'card_updated', card });
      return { ok: true, card, topic };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const updated = updateCardStatus(cardId, newStatus, now);
  if (!updated) return { ok: false, error: 'update failed' };
  const card = rowToCard(updated);
  broadcast({ type: 'card_updated', card });
  return { ok: true, card };
}

// MVP14 Step 2: attention item 的动作分支（独立于 cards 表）。
// - ack / mark_done → updateAttentionItemStatus('acted')
// - dismiss → updateAttentionItemStatus('dismissed')
// - ask_agent → recordUserMessage + claudeRuntime.sendUserMessage，然后标 acted
// - open_source → 仅返回当前项（前端打开链接，状态不变）
// - 不支持 snooze / auto_henceforth（attention 走 TTL 与 supersede，不学 boundary rule）
async function applyAttentionAction(
  attn: ReturnType<typeof getAttentionItem> & object,
  actionId: string,
  opts?: { extraPrompt?: string; note?: string }
): Promise<CardActionResult> {
  const actions = defaultAttentionActions(attn);
  let action = actions.find((a) => a.id === actionId);
  // MVP23：有角度的卡片其投影动作里没有通用 'ask_agent'（只有 opt:* 角度按钮）。
  //   但前端「让 AI 处理」自定义指令输入框需要一个通用处理通道——允许 'ask_agent' 作为合法动作，
  //   走 rich prompt + 用户指令、不带任何角度 directive。
  if (!action && actionId === 'ask_agent') {
    action = { id: 'ask_agent', label: '让 AI 处理', kind: 'ask_agent' };
  }
  // MVP32：done 卡上的「撤销已处理」是前端合成动作（不在投影动作组里），同 ask_agent 兜底合法化。
  if (!action && actionId === 'matter_reopen') {
    action = { id: 'matter_reopen', label: '撤销已处理', kind: 'matter_reopen' };
  }
  // MVP32：mark_done 投影只下发给 matter 卡，但旧前端缓存/竞态可能打到无 matter 卡——兜底合法化，
  // 分支内按"无 matter"路径处理（仅 acted + 交互记录）。
  if (!action && actionId === 'mark_done') {
    action = { id: 'mark_done', label: '已处理', kind: 'mark_done' };
  }
  if (!action) return { ok: false, error: `unknown action ${actionId}` };

  const now = new Date().toISOString();

  if (action.kind === 'ask_agent' || action.kind === 'draft_reply') {
    // Step 3 修：action 触发时实时展开 signal/space/entity 真实内容，让右侧 Claude 不再看光秃秃的 id。
    const userPrompt = opts?.extraPrompt?.trim();
    const rich = buildRichAskAgentPrompt(attn);
    // MVP23：角度按钮 id 形如 'opt:<oid>'，从后端持有的 actionOptions 取回该角度 directive。
    //   directive 不经前端传递，避免被篡改、并与 projection 保持一致。
    let directive: string | undefined;
    if (actionId.startsWith('opt:')) {
      directive = attn.actionOptions?.find((o) => `opt:${o.id}` === actionId)?.directive;
    }
    // 拼装顺序：rich 上下文 → 角度指令（置末尾、强语气，抵消 rich 较长的注意力稀释）→ 用户补充
    const prompt = [
      rich,
      directive ? `\n【本次处理角度（请只做这一件）】${directive}` : '',
      userPrompt ? `\n【用户补充】${userPrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      // MVP18 Stage 0: sendTopicMessage 同步返回，turn 后台跑。
      // 产品语义变更：用户点完立即标 acted，turn 失败不回滚 acted 状态
      // （turn 失败会在该 topic 内显示 system error 消息，用户能感知）。
      const { topic } = sendTopicMessage({
        text: prompt,
        sourceKind: 'attention',
        sourceRefId: attn.id,
        title: attn.title,
        skipContext: true,
      });
      recordAttentionInteraction(attn, 'ask_agent', now);
      const updated = updateAttentionItemStatus(attn.id, 'acted', now);
      if (!updated) return { ok: false, error: 'update failed' };
      const card = projectAttentionItemToCard(updated);
      broadcast({ type: 'card_updated', card });
      return { ok: true, card, topic };
    } catch (err) {
      // 同 applyCardAction：仅捕获建 topic 阶段的同步抛错。
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (action.kind === 'open_source') {
    // 不改状态，前端通过 sourceUrl 自己打开
    const card = projectAttentionItemToCard(attn);
    return { ok: true, card };
  }

  // MVP31：办结提案确认 —— 回写 matter 状态，催办卡由下一轮 tick 自动清除。
  if (action.kind === 'matter_resolve') {
    if (!attn.matterId) return { ok: false, error: 'item has no matterId' };
    const fullMatterId = matchMatterId(attn.matterId);
    if (!fullMatterId) return { ok: false, error: `matter ${attn.matterId} not found` };
    const resolved = userResolveMatter(fullMatterId, 'AI 处理结论提案，用户确认办结', now);
    if (!resolved) return { ok: false, error: `matter ${attn.matterId} resolve failed` };
    recordAttentionInteraction(attn, 'matter_resolve', now);
    const updated = updateAttentionItemStatus(attn.id, 'acted', now);
    if (!updated) return { ok: false, error: 'update failed' };
    enqueueAttentionTickSoon(); // 让催办卡尽快被 markAttentionItemsSupersededForResolvedMatters 清掉
    const card = projectAttentionItemToCard(updated);
    broadcast({ type: 'card_updated', card });
    return { ok: true, card };
  }

  // MVP32：「已处理」——用户在系统外办完了。落 Matter 层（resolved + 处理说明 + 证据链接），
  // 同事项催办经 tick 自动清除；随后异步核实（第二档，可配置关闭）。零 LLM、点了即生效。
  if (action.kind === 'mark_done') {
    const note = opts?.note?.trim().slice(0, 2000) || undefined;
    // matter_id 可能是 LLM 截断前缀（MVP29D），canonical 化后再操作；解不出 → 按无 matter 卡兜底。
    const fullMatterId = attn.matterId ? matchMatterId(attn.matterId) : null;

    // MVP69：needhelp 求助卡的 mark_done = 用户**补一手信息让 AI 接着查**，不是"已办结"。
    // 走独立支路：①先置 acted（解 hasLiveMatterProposal skip 门，必须在落证据之前）②把补的内容落成
    // 挂该 matter 的**外部证据**(origin=card_action，过回声门；effect=no_change，不办结；mergeHint 带时间戳，
    // 多轮不覆盖) ③kickInvestigation 近实时解封。下一 tick MVP66 看到新外部证据 → 自动带新证据重查。
    if (attn.inputHash.startsWith(MATTER_NEEDHELP_PROPOSAL_PREFIX)) {
      const updated = updateAttentionItemStatus(attn.id, 'acted', now);
      if (!updated) return { ok: false, error: 'update failed' };
      if (note && fullMatterId) {
        try {
          const { unit } = upsertContextUnit({
            kind: 'action_result',
            origin: { kind: 'card_action', refId: attn.id }, // ★ 不被 hasNewExternalEvidenceSince 回声门排除
            title: `补充：${attn.title.slice(0, 60)}`,
            content: note,
            scope: 'work',
            actionability: 'record',
            confidence: 1,
            mergeHint: `needhelp-backfill:${attn.id}:${now}:${randomUUID().slice(0, 8)}`, // ★ 唯一键：多轮补位各落新 unit，不互相覆盖（同毫秒也不撞）
            silent: true,
          });
          attachMatterContextLink({
            matterId: fullMatterId,
            contextUnitId: unit.id,
            relation: 'evidence',
            effect: 'no_change', // ★ 只补证据，绝不办结
            confidence: 1,
            reason: '用户应答「需要你帮忙」求助卡补充的信息',
            now,
          });
        } catch (err) {
          console.warn('[needhelp-backfill] note unit write failed:', err instanceof Error ? err.message : String(err));
        }
      }
      recordAttentionInteraction(attn, 'mark_done', now);
      kickInvestigation(); // ★ 叶子信号，绕开 cardsService→dispatcher 循环依赖
      const card = projectAttentionItemToCard(updated);
      broadcast({ type: 'card_updated', card });
      return { ok: true, card };
    }

    // ① Matter → resolved（幂等：已 resolved/dropped 跳过，不写重复 transition）
    if (fullMatterId) {
      const m = getMatterById(fullMatterId);
      if (m && m.status !== 'resolved' && m.status !== 'dropped') {
        userResolveMatter(
          fullMatterId,
          note ? `用户标记已处理：${note}` : '用户标记已处理',
          now
        );
      }
    }

    // ② 处理说明 → action_result unit（silent：状态已确定性落库，不再触发 Reducer echo）
    if (note) {
      try {
        const { unit } = upsertContextUnit({
          kind: 'action_result',
          origin: { kind: 'card_action', refId: attn.id },
          title: `已处理：${attn.title.slice(0, 60)}`,
          content: note,
          scope: 'work',
          actionability: 'record',
          confidence: 1,
          mergeHint: `mark-done:${attn.id}`, // 幂等：重复提交合并为同一 unit
          silent: true,
        });
        if (fullMatterId) {
          attachMatterContextLink({
            matterId: fullMatterId,
            contextUnitId: unit.id,
            relation: 'resolved_by',
            effect: 'resolve',
            confidence: 1,
            reason: '用户标记已处理时填写的处理说明',
            now,
          });
        }
      } catch (err) {
        // note 落库失败不阻塞主流程（matter 已 resolved，卡片状态照常推进），只记日志。
        console.warn(
          '[mark-done] note unit write failed:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // ③ 交互记录 + 卡片状态
    recordAttentionInteraction(attn, 'mark_done', now);
    const updated = updateAttentionItemStatus(attn.id, 'acted', now);
    if (!updated) return { ok: false, error: 'update failed' };

    // ④ 尽快清同事项其余催办卡
    enqueueAttentionTickSoon();

    // ⑤ 第二档：异步核实（默认延迟 ~5min，等 collector 把新证据采进来）
    if (fullMatterId && config.matterVerifyEnabled) {
      scheduleMatterResolveVerification({
        matterId: fullMatterId,
        attentionId: attn.id,
        userNote: note,
      });
    }

    const card = projectAttentionItemToCard(updated);
    broadcast({ type: 'card_updated', card });
    return { ok: true, card };
  }

  // MVP32：重开事项。两个入口共用：
  //   a) 「核实存疑」提案卡的「重新打开」→ matter 重开，提案卡自身 acted（原催办由下轮 tick 对
  //      active matter 自然重生，不手工复活旧卡）；
  //   b) done 卡上的「撤销已处理」（前端合成动作）→ matter 重开 + 该 item 置回 live（卡片回到待处理）。
  if (action.kind === 'matter_reopen') {
    if (!attn.matterId) return { ok: false, error: 'item has no matterId' };
    const fullMatterId = matchMatterId(attn.matterId);
    if (!fullMatterId) return { ok: false, error: `matter ${attn.matterId} not found` };
    const isReopenProposal = attn.inputHash.startsWith(MATTER_REOPEN_PROPOSAL_PREFIX);

    const m = getMatterById(fullMatterId);
    if (m && (m.status === 'resolved' || m.status === 'dropped')) {
      userReopenMatter(
        fullMatterId,
        isReopenProposal ? '核实存疑，用户确认重开' : '用户撤销已处理',
        now
      );
    } // matter 已是活跃态（如 Reducer 先一步自动重开）→ 幂等跳过，只动卡片状态

    recordAttentionInteraction(attn, 'matter_reopen', now);
    const updated = updateAttentionItemStatus(attn.id, isReopenProposal ? 'acted' : 'live', now);
    if (!updated) return { ok: false, error: 'update failed' };
    enqueueAttentionTickSoon();
    const card = projectAttentionItemToCard(updated);
    broadcast({ type: 'card_updated', card });
    return { ok: true, card };
  }

  // MVP31/32 提案卡（matter-resolve / matter-reopen）的 dismiss 都不学 not_relevant 负反馈：
  // 用户只是裁决提案，不是说内容不相关。
  const isResolveProposal = attn.inputHash.startsWith('proposal:matter-resolve:');
  const isReopenProposal = attn.inputHash.startsWith(MATTER_REOPEN_PROPOSAL_PREFIX);
  // MVP40：进展回执卡的「继续跟进」=裁决，不是说内容不相关 → 同样豁免 not_relevant 学习。
  const isProgressProposal = attn.inputHash.startsWith('proposal:matter-progress:');
  // MVP67：「你欠的承诺查无跟进」提醒的「不再跟进」=裁决（这事不必再追），不是内容不相关 → 同样豁免。
  const isDanglingProposal = attn.inputHash.startsWith('proposal:matter-dangling:');
  // MVP69：「需要你帮忙」求助卡的「不用了」=裁决（这件不用我继续追），不是内容不相关 → 同样豁免。
  const isNeedHelpProposal = attn.inputHash.startsWith(MATTER_NEEDHELP_PROPOSAL_PREFIX);

  if (action.kind === 'dismiss' && (isResolveProposal || isReopenProposal || isProgressProposal || isDanglingProposal || isNeedHelpProposal)) {
    // 提案卡的「还没完 / 确实已完成」≠ 内容不相关：只关卡片，不学 not_relevant 负反馈。
    recordAttentionInteraction(attn, 'dismiss', now);
    // MVP32：重开提案上的「确实已完成」是用户对核实结论的否决——把 verification 改记 user_confirmed。
    if (isReopenProposal && attn.matterId) {
      const fullMatterId = matchMatterId(attn.matterId);
      const matter = fullMatterId ? getMatterById(fullMatterId) : null;
      if (fullMatterId && matter?.resolveVerification) {
        setMatterResolveVerification(fullMatterId, {
          ...matter.resolveVerification,
          verdict: 'user_confirmed',
          checkedAt: now,
        });
        broadcast({ type: 'matter_updated', matterId: fullMatterId });
      }
    }
    const updated = updateAttentionItemStatus(attn.id, 'dismissed', now);
    if (!updated) return { ok: false, error: 'update failed' };
    const card = projectAttentionItemToCard(updated);
    broadcast({ type: 'card_updated', card });
    return { ok: true, card };
  }

  if (action.kind === 'dismiss') {
    try {
      applyAttentionFeedback({
        attentionId: attn.id,
        type: 'not_relevant',
        payload: {},
        confirm: true,
        sourceAction: 'dismiss',
      });
      enqueueAttentionTickSoon();
      const updated = getAttentionItem(attn.id);
      if (!updated) return { ok: false, error: 'update failed' };
      const card = projectAttentionItemToCard(updated);
      broadcast({ type: 'card_updated', card });
      return { ok: true, card };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ack / mark_done → 'acted'；snooze 当 ack 用（保守）。dismiss 上面已走负反馈分支。
  if (action.kind === 'ack') {
    recordAttentionInteraction(attn, 'ack', now);
  }
  const updated = updateAttentionItemStatus(attn.id, 'acted', now);
  if (!updated) return { ok: false, error: 'update failed' };
  const card = projectAttentionItemToCard(updated);
  broadcast({ type: 'card_updated', card });
  return { ok: true, card };
}

function inferAutonomy(source: CardSourceKey, priority: Priority): BoundaryAutonomy {
  // 高优 + 通讯类 → 永远确认，避免学个规则把重要消息也丢进 digest
  if ((source === 'im' || source === 'mail') && (priority === 'P0' || priority === 'P1')) {
    return 'external_always_confirm';
  }
  // 其他 → 本地、可逆，自动
  return 'local_auto';
}

function mapKindToStatus(kind: CardActionKind, prev: CardStatus): CardStatus {
  switch (kind) {
    case 'ack':
      return 'acknowledged';
    case 'snooze':
      return 'snoozed';
    case 'dismiss':
    case 'auto_henceforth':
      // 学了规则后，这张卡片本身也算"以后不需要看了"
      return 'dismissed';
    case 'mark_done':
      return 'done';
    case 'ask_agent':
    case 'draft_reply':
      // 触发后台 Claude，但保留为 new/ack，让用户能继续看到
      return prev === 'new' ? 'acknowledged' : prev;
    case 'open_source':
      return prev;
    default:
      return prev;
  }
}

function buildDefaultPrompt(row: CardRow, kind: 'ask_agent' | 'draft_reply'): string {
  const base = [
    `请处理这条来自卡片的请求。`,
    `来源：${row.source}`,
    `标题：${row.title}`,
    `摘要：${row.summary}`,
    row.suggested_action ? `建议动作：${row.suggested_action}` : '',
    row.source_url ? `链接：${row.source_url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (kind === 'draft_reply') {
    return `${base}\n\n请只生成一份适合用飞书消息回复的草稿，不要发送、不要调用任何写操作工具。`;
  }
  return `${base}\n\n请按你的判断给出下一步建议或必要的查询结果，不要调用任何写操作工具。`;
}
