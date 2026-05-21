import { randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import { type ActionProposalRow, insertActionProposal } from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import type { AgentHandler } from './agentRegistry.js';
import { decodeSemanticTags } from '../context/semanticTags.js';
import type { CardAction } from '../claude/protocol.js';

/**
 * MVP11.1 recapActionItemsAgent — 会议纪要 ready 时调 LLM 抽 action items，
 * 输出走 ask 卡片让用户确认，**不直接落 commitment**（§I-5）。
 *
 * 写入 action_proposals.payload_json，让 /api/cards/:id/action-items/confirm
 * controller 读出 actionItems 后再做 upsertContextUnit。
 */

const RECAP_SYSTEM_PROMPT = `你正在读一段刚结束的会议的 AI 纪要。任务：抽出最多 5 条「明确的行动项 / 待办」，并给出可选的会议主旨 + 关键决策 + 未决问题。

铁律：
1. action item 的 owner 必须明确（"我" / 某人姓名 / "待定"）。模糊就标 "待定"。
2. task 用动词开头，≤30 字，去掉客套。
3. suggestedDueAt 用 ISO 8601，若纪要里没说就 null。
4. confidence 0-1，反映你抽出这条的把握。
5. **不要发明纪要里没有的内容**。宁可 actionItems=[]。
6. 输出必须是单个合法 JSON 对象，不要 Markdown。

输出 schema：
{
  "summary": "≤80 字会议主旨",
  "actionItems": [
    { "owner": "我 / Alice / 待定", "task": "...", "suggestedDueAt": "ISO 或 null", "confidence": 0.7 }
  ],
  "decisions": ["关键决策 1"],
  "openQuestions": ["未决问题"]
}`;

const RECAP_TIMEOUT_MS = 120_000;

/** 测试钩子：传入则跳过 runOneShot，直接用此函数返回 LLM 文本。 */
type LlmStub = (userMessage: string, systemPrompt: string) => Promise<string>;
let llmStub: LlmStub | null = null;
export function __setRecapLlmStub(stub: LlmStub | null): void {
  llmStub = stub;
}

export type RecapResult = {
  summary: string;
  actionItems: Array<{
    owner: string;
    task: string;
    suggestedDueAt: string | null;
    confidence: number;
  }>;
  decisions: string[];
  openQuestions: string[];
};

export const recapActionItemsHandler: AgentHandler = async ({
  trigger,
  unit,
  packet,
  agentRunId,
}) => {
  if (!unit) {
    return { summary: 'recap_action_items skipped (no unit)', proposalIds: [], cardIds: [] };
  }
  const { tags } = decodeSemanticTags(unit.meaning);
  const minuteToken = typeof tags.minute_token === 'string' ? tags.minute_token : '';
  const triggerPayload = safeJSON(trigger.payload_json) as
    | { minuteToken?: string; hasActionItems?: boolean }
    | null;

  const llmInput: Record<string, unknown> = {
    meetingTitle: unit.title,
    minuteContent: unit.content,
    occurredAt: unit.time?.occurredAt,
    minuteToken: minuteToken || triggerPayload?.minuteToken,
  };
  if (packet?.spaces?.length) {
    llmInput.spaces = packet.spaces.map((s) => ({
      name: s.name,
      priority: s.priority,
      docs: s.docs?.map((d) => d.name).slice(0, 5) ?? [],
    }));
  }
  if (packet?.goals?.length) {
    llmInput.goals = packet.goals.map((g) => ({ title: g.title, meaning: g.meaning }));
  }
  if (packet?.subject?.responsibilities?.length) {
    llmInput.userRole = packet.subject.responsibilities;
  }
  if (packet?.stakeholders?.length) {
    llmInput.stakeholders = packet.stakeholders;
  }

  let parsed: RecapResult;
  try {
    const userMsg = JSON.stringify(llmInput, null, 2);
    const text = llmStub
      ? await llmStub(userMsg, RECAP_SYSTEM_PROMPT)
      : (
          await runOneShot(userMsg, {
            systemPrompt: RECAP_SYSTEM_PROMPT,
            timeoutMs: RECAP_TIMEOUT_MS,
          })
        ).text;
    parsed = parseResult(text);
  } catch (err) {
    return {
      summary: `recap_action_items LLM failed: ${
        err instanceof Error ? err.message.slice(0, 80) : String(err)
      }`,
      proposalIds: [],
      cardIds: [],
    };
  }

  // 空 action items 也出卡片（让用户知道纪要到了，但 P2）
  const priority: 'P1' | 'P2' = parsed.actionItems.length > 0 ? 'P1' : 'P2';

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const title = parsed.actionItems.length
    ? `会议「${unit.title}」抽到 ${parsed.actionItems.length} 条待办，确认入库？`
    : `会议「${unit.title}」纪要已到位`;

  const bodyLines: string[] = [];
  if (parsed.summary) bodyLines.push(parsed.summary);
  if (parsed.actionItems.length) {
    bodyLines.push('', '待办：');
    for (const it of parsed.actionItems) {
      const due = it.suggestedDueAt ? `（${it.suggestedDueAt.slice(0, 10)}）` : '';
      bodyLines.push(`- ${it.owner}：${it.task}${due}`);
    }
  }
  if (parsed.decisions.length) {
    bodyLines.push('', '决定：');
    for (const d of parsed.decisions) bodyLines.push(`- ${d}`);
  }
  if (parsed.openQuestions.length) {
    bodyLines.push('', '未决：');
    for (const q of parsed.openQuestions) bodyLines.push(`- ${q}`);
  }
  const body = bodyLines.join('\n') || '（LLM 未抽出可结构化内容）';

  const payload = {
    priority,
    contextUnitId: unit.id,
    triggerId: trigger.id,
    minuteToken: minuteToken || triggerPayload?.minuteToken || '',
    summary: parsed.summary,
    actionItems: parsed.actionItems,
    decisions: parsed.decisions,
    openQuestions: parsed.openQuestions,
  };
  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: agentRunId,
    proposal_type: 'meeting_action_items',
    title,
    body,
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 1,
    status: 'projected',
    payload_json: JSON.stringify(payload),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  // ask 卡片：confirm_all / confirm_none 走专用 controller；其余保留标准 ack
  const actions: CardAction[] = [];
  if (parsed.actionItems.length) {
    // confirm_* 在前端被拦截走 /api/cards/:id/action-items/confirm；kind 仅用于按钮样式
    actions.push({
      id: 'action_items_confirm_all',
      label: '全部入库',
      kind: 'ack',
    });
    actions.push({
      id: 'action_items_confirm_none',
      label: '全都不要',
      kind: 'ack',
    });
  }
  actions.push({ id: 'ack', label: '知道了', kind: 'ack' });
  if (unit.entities.some((e) => e.type === 'meeting')) {
    actions.push({ id: 'open_source', label: '打开妙记', kind: 'open_source' });
  }

  const card = createCardFromProposal({
    proposal,
    agentType: 'recap_action_items',
    priority,
    source: 'agent',
    reason: trigger.reasoning ?? '会议纪要 ready',
    sourceUrl: unit.entities.find((e) => e.type === 'meeting')
      ? `https://www.feishu.cn/minutes/${minuteToken}`
      : undefined,
    actions,
    triggerType: trigger.trigger_type,
    kind: unit.kind,
    entities: unit.entities.map((e) => ({ type: e.type, name: e.name })),
    scope: 'work',
  });

  return {
    summary: `recap: ${parsed.actionItems.length} action item(s)${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: { actionItemCount: parsed.actionItems.length, decisionCount: parsed.decisions.length },
  };
};

// ---------- helpers ----------

function safeJSON(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  return null;
}

function extractJson(s: string): unknown {
  const whole = tryParse(s);
  if (whole !== null) return whole;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1]);
    if (inside !== null) return inside;
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = tryParse(s.slice(first, last + 1));
    if (sliced !== null) return sliced;
  }
  return null;
}

function parseResult(text: string): RecapResult {
  const obj = extractJson(text);
  const o = (obj ?? {}) as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const items = Array.isArray(o.actionItems) ? o.actionItems : [];
  const actionItems: RecapResult['actionItems'] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Record<string, unknown>;
    const owner = typeof it.owner === 'string' ? it.owner.trim() : '';
    const task = typeof it.task === 'string' ? it.task.trim() : '';
    if (!task) continue;
    const due = typeof it.suggestedDueAt === 'string' && it.suggestedDueAt.trim()
      ? it.suggestedDueAt.trim()
      : null;
    const confidence = typeof it.confidence === 'number' ? it.confidence : 0.6;
    actionItems.push({ owner: owner || '待定', task, suggestedDueAt: due, confidence });
  }
  const decisions = Array.isArray(o.decisions)
    ? o.decisions.filter((x): x is string => typeof x === 'string').slice(0, 10)
    : [];
  const openQuestions = Array.isArray(o.openQuestions)
    ? o.openQuestions.filter((x): x is string => typeof x === 'string').slice(0, 10)
    : [];
  return { summary, actionItems, decisions, openQuestions };
}
