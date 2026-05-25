import { randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import {
  type ActionProposalRow,
  insertActionProposal,
} from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import { recommendHandling } from '../context/agentContextAssembler.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import type { AgentHandler } from './agentRegistry.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import type { AgentContextPacket } from '../context/agentContextAssembler.js';

export const PREPARE_MEETING_SYSTEM_PROMPT = `你正在为用户准备一个即将开始的会议。你会收到：
1. 会议本身（标题、时间、参会人）
2. 该会议关联的上下文：相关承诺、最近相关消息、相关项目状态
3. 用户的 Work Map 信息（角色 / 项目 / 权威文档 / stakeholders）

任务：用一份简短的会前摘要回应。

铁律：
- 输出 1 段会议主旨（≤60 字）+ 最多 3 个"应带要点" + 1-3 个"缺失/不确定信息"。
- 优先利用 Work Map 中的权威文档与项目目标当上下文锚，不要复述会议标题。
- 不要主动提议联系外部人。
- 如果上下文很少，明确说"上下文较少，可能需要现场补齐"，不要瞎补。
- 输出必须是单个合法 JSON 对象。不要 Markdown。

输出 schema：
{
  "headline": "会议主旨一两句话",
  "talkingPoints": ["要点 1", "要点 2"],
  "missingInfo": ["不确定 1"],
  "confidence": 0.7
}`;

const PREPARE_MEETING_TIMEOUT_MS = 90_000;

export const prepareMeetingHandler: AgentHandler = async ({
  trigger,
  unit,
  packet,
  agentRunId,
}) => {
  if (!unit) {
    return {
      summary: 'prepare_meeting skipped (no unit)',
      proposalIds: [],
      cardIds: [],
    };
  }

  const userMessage = buildUserMessage(unit, packet);

  let parsed: PrepareMeetingResult;
  try {
    const r = await runOneShot(userMessage, {
      agentName: 'aiisn-prepare-meeting',
      systemPrompt: PREPARE_MEETING_SYSTEM_PROMPT,
      timeoutMs: PREPARE_MEETING_TIMEOUT_MS,
    });
    parsed = parseResult(r.text);
  } catch (err) {
    parsed = {
      headline: '上下文较少，需要现场补齐',
      talkingPoints: [],
      missingInfo: [
        `LLM 准备失败：${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
      ],
      confidence: 0.3,
    };
  }

  const handlingRec = packet ? recommendHandling(packet) : null;

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const title = `会前准备：${unit.title}`;
  const bodyLines: string[] = [parsed.headline];
  if (parsed.talkingPoints.length) {
    bodyLines.push('', '要点：');
    for (const p of parsed.talkingPoints) bodyLines.push(`- ${p}`);
  }
  if (parsed.missingInfo.length) {
    bodyLines.push('', '不确定：');
    for (const m of parsed.missingInfo) bodyLines.push(`- ${m}`);
  }
  const body = bodyLines.join('\n');

  // P0 if any related Space is critical
  let priority: 'P0' | 'P1' | 'P2' = 'P1';
  if (packet?.spaces?.some((s) => s.priority === 'critical')) priority = 'P0';
  else if (packet?.spaces?.some((s) => s.priority === 'high')) priority = 'P1';
  else priority = 'P1';

  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: agentRunId,
    proposal_type: 'meeting_brief',
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
      meetingTitle: unit.title,
      startsAt: unit.time?.startsAt ?? unit.time?.occurredAt,
      llmConfidence: parsed.confidence,
      spacePriorities: packet?.spaces?.map((s) => ({ name: s.name, priority: s.priority })) ?? [],
      recommendedHandling: handlingRec?.handling ?? null,
    }),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  const card = createCardFromProposal({
    proposal,
    agentType: 'prepare_meeting',
    priority,
    source: 'agent',
    reason: trigger.reasoning ?? '会议即将开始，已准备会前摘要',
    triggerType: trigger.trigger_type,
    kind: unit.kind,
    entities: unit.entities.map((e) => ({ type: e.type, name: e.name })),
    scope: 'work',
  });

  return {
    summary: `meeting brief for "${unit.title}" — ${parsed.talkingPoints.length} pts, ${parsed.missingInfo.length} unknowns${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: parsed,
  };
};

type PrepareMeetingResult = {
  headline: string;
  talkingPoints: string[];
  missingInfo: string[];
  confidence: number;
};

/**
 * MVP8.1 §5.5.2：prompt 现在直接消费 packet 的 spaces / goals / stakeholders /
 * relatedContext / subject，不再自己 collectRelatedContext。
 */
function buildUserMessage(unit: ContextUnit, packet?: AgentContextPacket): string {
  const meta = {
    title: unit.title,
    startsAt: unit.time?.startsAt ?? unit.time?.occurredAt,
    endsAt: unit.time?.endsAt,
    organizer: unit.entities.find((e) => e.role === 'actor')?.name,
    attendees: unit.entities.map((e) => `${e.type}:${e.name}${e.role ? `(${e.role})` : ''}`),
    description: unit.content,
  };

  const blocks: string[] = ['会议：', '<meeting>', JSON.stringify(meta, null, 2), '</meeting>', ''];

  if (packet?.subject) {
    blocks.push(
      '<subject>',
      JSON.stringify(
        {
          roleTitle: packet.subject.roleTitle,
          teamName: packet.subject.teamName,
          responsibilities: packet.subject.responsibilities,
          preferences: packet.subject.preferences,
        },
        null,
        2
      ),
      '</subject>',
      ''
    );
  }
  if (packet?.spaces?.length) {
    blocks.push(
      '<spaces>',
      JSON.stringify(
        packet.spaces.map((s) => ({
          name: s.name,
          type: s.type,
          priority: s.priority,
          docs: s.docs.map((d) => d.name),
        })),
        null,
        2
      ),
      '</spaces>',
      ''
    );
  }
  if (packet?.goals?.length) {
    blocks.push(
      '<goals>',
      JSON.stringify(
        packet.goals.map((g) => ({ title: g.title, meaning: g.meaning })),
        null,
        2
      ),
      '</goals>',
      ''
    );
  }
  if (packet?.stakeholders?.length) {
    blocks.push(
      '<stakeholders>',
      JSON.stringify(packet.stakeholders, null, 2),
      '</stakeholders>',
      ''
    );
  }
  if (packet?.relatedContext?.length) {
    const ctxLines = packet.relatedContext.map((r) => ({
      kind: r.kind,
      title: r.title,
      entities: r.entities.map((e) => `${e.type}:${e.name}`),
      dueAt: r.time?.dueAt,
      confidence: r.confidence,
      excerpt: r.content.slice(0, 200),
    }));
    blocks.push(
      `相关上下文（共 ${ctxLines.length} 条）：`,
      '<context>',
      JSON.stringify(ctxLines, null, 2),
      '</context>',
      ''
    );
  }
  if (packet?.boundary && packet.boundary.decision !== 'allow') {
    blocks.push(`(boundary: ${packet.boundary.decision} — ${packet.boundary.reason ?? ''})`, '');
  }
  blocks.push('只输出 JSON 对象，不要 Markdown。');
  return blocks.join('\n');
}

function parseResult(text: string): PrepareMeetingResult {
  const obj = extractJson(text);
  const o = (obj ?? {}) as Record<string, unknown>;
  return {
    headline: typeof o.headline === 'string' ? o.headline : '',
    talkingPoints: Array.isArray(o.talkingPoints)
      ? (o.talkingPoints.filter((s) => typeof s === 'string') as string[]).slice(0, 5)
      : [],
    missingInfo: Array.isArray(o.missingInfo)
      ? (o.missingInfo.filter((s) => typeof s === 'string') as string[]).slice(0, 5)
      : [],
    confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
  };
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
