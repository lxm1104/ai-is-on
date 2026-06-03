import { randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import {
  type ActionProposalRow,
  insertActionProposal,
} from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import type { AgentHandler } from './agentRegistry.js';

/**
 * MVP5.1 syncDraftAgent — when divergenceDetector says "team committed to X
 * but the relevant doc hasn't moved" (or "decision wasn't sunk into the
 * doc"), this agent drafts a short Lark message the user can send to the
 * relevant person to either prompt status update or escalate.
 *
 * Hard limit: NEVER auto-send. The card surfaces 复制 / 编辑后发送, both of
 * which require explicit user action.
 */

export const SYNC_DRAFT_SYSTEM_PROMPT = `你正在为用户起草一段简短的飞书消息草稿，目的是同步一个团队信息差。

输入：一个 divergence finding，描述了"团队约定了什么，但相关文档/状态没跟上"。

任务：写一段适合在飞书发出去的短消息，**面向那个最该同步的人**。

铁律：
1. 风格：用 system prompt 里「关于"我"的说话风格（模仿）」那套语气来写——按收件人选 register（同事/平级走对内：直接、碎句、不客套；客户/跨组织走对客：礼貌完整句）。中文。
2. 长度：≤120 字。
3. **不要直接发**——你只是草稿。
4. 必须包含：(a) 你为什么发这条消息，(b) 你具体在追问什么 / 提议什么。
5. 不要威胁、不要冒犯、不要替对方下结论。
6. 如果 finding 指向的人不明确，target 字段给空，draft 写一段"待发送给 XX"的版本让用户填。
7. 输出必须是单个合法 JSON 对象，不要 Markdown。

输出 schema：
{
  "target": "建议发送给谁（人名或 '相关方'）",
  "draft": "草稿正文",
  "reasoning": "我为什么建议发这条（一句话）",
  "confidence": 0.7
}`;

export const syncDraftHandler: AgentHandler = async ({
  trigger,
  unit,
  packet,
  agentRunId,
}) => {
  const payload = safeJSON(trigger.payload_json) as Record<string, unknown> | null;
  if (!payload) {
    return { summary: 'sync_draft skipped (no payload)', proposalIds: [], cardIds: [] };
  }

  const llmInput: Record<string, unknown> = { divergence: payload };
  if (packet?.spaces?.length) {
    llmInput.spaces = packet.spaces.map((s) => ({
      name: s.name,
      priority: s.priority,
      docs: s.docs.map((d) => d.name),
    }));
  }
  if (packet?.focalUnit) {
    llmInput.focalUnit = {
      kind: packet.focalUnit.kind,
      title: packet.focalUnit.title,
      meaning: packet.focalUnit.meaning,
    };
  }
  if (packet?.stakeholders?.length) {
    llmInput.stakeholders = packet.stakeholders;
  }
  const userMessage = JSON.stringify(llmInput, null, 2);
  let parsed: SyncDraftResult;
  try {
    const r = await runOneShot(userMessage, {
      agentName: 'aiisn-sync-draft',
      systemPrompt: SYNC_DRAFT_SYSTEM_PROMPT,
      timeoutMs: 90_000,
    });
    parsed = parseResult(r.text);
  } catch (err) {
    return {
      summary: `sync_draft LLM failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`,
      proposalIds: [],
      cardIds: [],
    };
  }

  if (!parsed.draft.trim()) {
    return { summary: 'sync_draft empty', proposalIds: [], cardIds: [] };
  }

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const spaceName = String(payload.spaceName ?? '某个项目');
  const target = parsed.target?.trim() || '相关方';
  const title = `同步草稿（${spaceName}）→ ${target}`;
  const body = [
    parsed.reasoning && `为什么：${parsed.reasoning}`,
    '',
    '草稿：',
    parsed.draft,
  ]
    .filter(Boolean)
    .join('\n');

  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: agentRunId,
    proposal_type: 'sync_draft',
    title,
    body,
    reversible: 1,
    impact_scope: 'team',
    requires_approval: 1,            // 强制人工确认才发
    status: 'projected',
    payload_json: JSON.stringify({
      priority: 'P1',
      target: parsed.target,
      triggerId: trigger.id,
      confidence: parsed.confidence,
    }),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  const card = createCardFromProposal({
    proposal,
    agentType: 'sync_draft',
    priority: 'P1',
    source: 'agent',
    reason: trigger.reasoning ?? 'Context divergence — 准备同步草稿',
    draftReply: parsed.draft,
    triggerType: trigger.trigger_type,
    kind: unit?.kind,
    entities: unit?.entities.map((e) => ({ type: e.type, name: e.name })),
    scope: 'work',
    actions: [
      // MVP5 范围：不自动发；用户复制/编辑后自己发飞书。
      { id: 'copy', label: '复制草稿', kind: 'ack' },
      { id: 'redraft', label: '让 AI 改写', kind: 'ask_agent', prompt: '把刚才的同步草稿改写一下：更礼貌；同时保留追问要点' },
      { id: 'dismiss', label: '不需要同步', kind: 'dismiss' },
    ],
  });

  return {
    summary: `sync_draft: target=${target}, ${parsed.draft.length} chars${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: parsed,
  };
};

type SyncDraftResult = {
  target: string;
  draft: string;
  reasoning: string;
  confidence: number;
};

function parseResult(text: string): SyncDraftResult {
  const obj = extractJson(text);
  const o = (obj ?? {}) as Record<string, unknown>;
  return {
    target: typeof o.target === 'string' ? o.target : '',
    draft: typeof o.draft === 'string' ? o.draft : '',
    reasoning: typeof o.reasoning === 'string' ? o.reasoning : '',
    confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
  };
}

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
