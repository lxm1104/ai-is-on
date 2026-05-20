import { randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import {
  type ActionProposalRow,
  insertActionProposal,
  listContextUnits,
} from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import { getContextUnitById, listLinksFor } from '../context/contextStore.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import type { AgentHandler } from './agentRegistry.js';
import type { ContextUnit } from '../context/ContextUnit.js';

const PREPARE_MEETING_SYSTEM_PROMPT = `你正在为用户准备一个即将开始的会议。你会收到：
1. 会议本身（标题、时间、参会人）
2. 该会议关联的上下文：相关承诺、最近相关消息、相关项目状态

任务：用一份简短的会前摘要回应。

铁律：
- 输出 1 段会议主旨（≤60 字）+ 最多 3 个"应带要点" + 1-3 个"缺失/不确定信息"。
- 不要复述会议标题；不要主动提议联系外部人。
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

export const prepareMeetingHandler: AgentHandler = async ({ trigger, unit }) => {
  if (!unit) {
    return {
      summary: 'prepare_meeting skipped (no unit)',
      proposalIds: [],
      cardIds: [],
    };
  }

  // Gather related context: other ContextUnits linked to this event +
  // ContextUnits sharing entities with it.
  const related = collectRelatedContext(unit);
  const userMessage = buildUserMessage(unit, related);

  let parsed: PrepareMeetingResult;
  try {
    const r = await runOneShot(userMessage, {
      systemPrompt: PREPARE_MEETING_SYSTEM_PROMPT,
      timeoutMs: PREPARE_MEETING_TIMEOUT_MS,
    });
    parsed = parseResult(r.text);
  } catch (err) {
    // LLM 失败也写一张 fallback 卡片，让用户知道系统看到了这个会但没准备好
    parsed = {
      headline: '上下文较少，需要现场补齐',
      talkingPoints: [],
      missingInfo: [
        `LLM 准备失败：${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
      ],
      confidence: 0.3,
    };
  }

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

  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: null,
    proposal_type: 'meeting_brief',
    title,
    body,
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 0,
    status: 'projected',
    payload_json: JSON.stringify({
      priority: 'P1',
      contextUnitId: unit.id,
      triggerId: trigger.id,
      meetingTitle: unit.title,
      startsAt: unit.time?.startsAt ?? unit.time?.occurredAt,
      llmConfidence: parsed.confidence,
    }),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  const card = createCardFromProposal({
    proposal,
    agentType: 'prepare_meeting',
    priority: 'P1',
    source: 'agent',
    reason: trigger.reasoning ?? '会议即将开始，已准备会前摘要',
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

function buildUserMessage(unit: ContextUnit, related: ContextUnit[]): string {
  const meta = {
    title: unit.title,
    startsAt: unit.time?.startsAt ?? unit.time?.occurredAt,
    endsAt: unit.time?.endsAt,
    organizer: unit.entities.find((e) => e.role === 'actor')?.name,
    attendees: unit.entities.map((e) => `${e.type}:${e.name}${e.role ? `(${e.role})` : ''}`),
    description: unit.content,
  };
  const ctxLines = related.map((r) => ({
    kind: r.kind,
    title: r.title,
    entities: r.entities.map((e) => `${e.type}:${e.name}`),
    dueAt: r.time?.dueAt,
    confidence: r.confidence,
    excerpt: r.content.slice(0, 200),
  }));
  return [
    '会议：',
    '<meeting>',
    JSON.stringify(meta, null, 2),
    '</meeting>',
    '',
    `相关上下文（按价值排序，共 ${ctxLines.length} 条）：`,
    '<context>',
    JSON.stringify(ctxLines, null, 2),
    '</context>',
    '',
    '只输出 JSON 对象，不要 Markdown。',
  ].join('\n');
}

/**
 * Collect ContextUnits relevant to this meeting:
 * - via context_links from the meeting's event ContextUnit
 * - other active commitments / goals whose entities overlap with attendees
 * Capped to avoid prompt bloat.
 */
function collectRelatedContext(meetingUnit: ContextUnit, capPerKind = 5): ContextUnit[] {
  const out = new Map<string, ContextUnit>();

  // 1. Direct links from the event ContextUnit
  const links = listLinksFor(meetingUnit.id);
  for (const l of links) {
    const otherId = l.from_context_id === meetingUnit.id ? l.to_context_id : l.from_context_id;
    if (otherId === meetingUnit.id || out.has(otherId)) continue;
    const u = getContextUnitById(otherId);
    if (u) out.set(u.id, u);
  }

  // 2. Active commitments / goals / states whose entity names overlap
  const attendeeNames = new Set(
    meetingUnit.entities.filter((e) => e.type === 'person').map((e) => e.name)
  );
  if (attendeeNames.size > 0) {
    const kinds: Array<{ kind: string; cap: number }> = [
      { kind: 'commitment', cap: capPerKind },
      { kind: 'goal', cap: 2 },
      { kind: 'state', cap: 3 },
      { kind: 'uncertainty', cap: 2 },
    ];
    for (const { kind, cap } of kinds) {
      const rows = listContextUnits({ kind, status: 'active', limit: 30 });
      let added = 0;
      for (const row of rows) {
        if (out.has(row.id) || row.id === meetingUnit.id) continue;
        const u = getContextUnitById(row.id);
        if (!u) continue;
        const overlap = u.entities.some(
          (e) => e.type === 'person' && attendeeNames.has(e.name)
        );
        if (overlap) {
          out.set(u.id, u);
          added++;
          if (added >= cap) break;
        }
      }
    }
  }

  return Array.from(out.values());
}

function parseResult(text: string): PrepareMeetingResult {
  // jsonrepair-tolerant parse via the same extractor as triage
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
