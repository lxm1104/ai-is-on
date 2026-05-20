import { randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import {
  type ActionProposalRow,
  insertActionProposal,
  listContextUnits,
} from '../db.js';
import { createCardFromProposal } from '../cards/cardsService.js';
import { getContextUnitById, upsertContextUnit } from '../context/contextStore.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { CARING_SYSTEM_PROMPT } from '../caring/caringPrompt.js';
import { isCaringPaused } from '../caring/caringSettings.js';
import type { AgentHandler } from './agentRegistry.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { setSetting } from '../db.js';

const RECENT_DAYS = 7;
const CARING_TIMEOUT_MS = 90_000;
const RELEVANT_KINDS = new Set([
  'emotion',
  'self_narrative',
  'state',
  'commitment',
  'event',
  'routine',
  'preference',
]);

export const caringHandler: AgentHandler = async ({ trigger }) => {
  if (isCaringPaused()) {
    return {
      summary: 'caring skipped (paused)',
      proposalIds: [],
      cardIds: [],
    };
  }

  const recent = collectRecentPersonal();
  if (recent.length === 0) {
    return {
      summary: 'caring skipped (no personal context)',
      proposalIds: [],
      cardIds: [],
    };
  }

  const userMessage = buildUserMessage(recent);
  let parsed: CaringResult;
  try {
    const r = await runOneShot(userMessage, {
      systemPrompt: CARING_SYSTEM_PROMPT,
      timeoutMs: CARING_TIMEOUT_MS,
    });
    parsed = parseResult(r.text);
  } catch (err) {
    return {
      summary: `caring LLM failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`,
      proposalIds: [],
      cardIds: [],
    };
  }

  if (parsed.observations.length === 0) {
    // 模型选择不说话——尊重它
    setSetting('last_checkin_at', new Date().toISOString());
    return {
      summary: 'caring chose to stay quiet (no observations)',
      proposalIds: [],
      cardIds: [],
    };
  }

  // 写成卡片
  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const bodyLines: string[] = [];
  for (const o of parsed.observations) bodyLines.push(`- ${o}`);
  if (parsed.nextSmallStep && parsed.nextSmallStep.trim()) {
    bodyLines.push('', `下一步（可以小一点）：${parsed.nextSmallStep.trim()}`);
  }
  const body = bodyLines.join('\n');
  const title = '我看到了一些什么';
  const proposal: ActionProposalRow = {
    id: proposalId,
    agent_run_id: null,
    proposal_type: 'caring_note',
    title,
    body,
    reversible: 1,
    impact_scope: 'self',
    requires_approval: 0,
    status: 'projected',
    payload_json: JSON.stringify({
      priority: 'P2',
      tone: parsed.tone,
      triggerId: trigger.id,
      confidence: parsed.confidence,
    }),
    created_at: now,
    updated_at: now,
  };
  insertActionProposal(proposal);

  // 情感卡片用专用 actions
  const card = createCardFromProposal({
    proposal,
    agentType: 'caring',
    priority: 'P2',
    source: 'agent',
    reason: trigger.reasoning ?? '已陪伴你一段时间，做一次轻量回应',
    actions: [
      { id: 'chat', label: '聊聊', kind: 'ask_agent', prompt: '我看了你的 caring 卡片，想跟你聊聊我最近的状态' },
      { id: 'note', label: '先记下', kind: 'ack' },
      { id: 'organize', label: '帮我整理', kind: 'ask_agent', prompt: '基于你刚才的 caring 观察，帮我整理一下接下来一两件可以做的小事' },
      { id: 'dismiss', label: '不要分析这个', kind: 'dismiss' },
    ],
  });

  // 把 caring 输出本身写回成 action_result ContextUnit，让下次 caring 知道自己已经说过什么
  try {
    upsertContextUnit({
      kind: 'action_result',
      title: `caring note: ${parsed.observations[0]?.slice(0, 30) ?? ''}`,
      content: body,
      entities: [],
      time: { occurredAt: now },
      actionability: 'none',
      confidence: parsed.confidence,
      mergeHint: `caring-${now.slice(0, 10)}`,           // 同一天合并
      scope: 'personal',
      origin: { kind: 'agent_run', refId: proposalId },
    });
  } catch (err) {
    console.warn('[caring] action_result upsert failed:', err);
  }

  setSetting('last_checkin_at', now);

  return {
    summary: `caring: ${parsed.observations.length} obs, tone=${parsed.tone}${card ? '' : ' [boundary-blocked]'}`,
    proposalIds: [proposalId],
    cardIds: card ? [card.id] : [],
    data: parsed,
  };
};

// ---- helpers ----

type CaringResult = {
  observations: string[];
  nextSmallStep: string;
  tone: 'calm' | 'gentle' | 'alert' | 'minimal';
  confidence: number;
};

const ALLOWED_TONES = new Set(['calm', 'gentle', 'alert', 'minimal']);

function collectRecentPersonal(): ContextUnit[] {
  const sinceMs = Date.now() - RECENT_DAYS * 86400_000;
  const rows = listContextUnits({ status: 'active', limit: 200 });
  const out: ContextUnit[] = [];
  for (const r of rows) {
    if (!RELEVANT_KINDS.has(r.kind)) continue;
    if (r.scope !== 'personal') continue;
    if (new Date(r.updated_at).getTime() < sinceMs) continue;
    const u = getContextUnitById(r.id);
    if (u) out.push(u);
  }
  return out;
}

function buildUserMessage(units: ContextUnit[]): string {
  const lines = units.map((u) => ({
    kind: u.kind,
    title: u.title,
    excerpt: u.content.slice(0, 200),
    entities: u.entities.map((e) => `${e.type}:${e.name}`),
    occurredAt: u.time?.occurredAt ?? u.updatedAt,
    dueAt: u.time?.dueAt,
    confidence: u.confidence,
  }));
  return [
    '用户最近 7 天的 personal context：',
    '<context>',
    JSON.stringify(lines, null, 2),
    '</context>',
    '',
    '只输出 JSON 对象，不要 Markdown。',
  ].join('\n');
}

function parseResult(text: string): CaringResult {
  const obj = extractJson(text);
  const o = (obj ?? {}) as Record<string, unknown>;
  const tone = typeof o.tone === 'string' && ALLOWED_TONES.has(o.tone) ? (o.tone as CaringResult['tone']) : 'calm';
  return {
    observations: Array.isArray(o.observations)
      ? (o.observations.filter((s) => typeof s === 'string') as string[]).slice(0, 3)
      : [],
    nextSmallStep: typeof o.nextSmallStep === 'string' ? o.nextSmallStep : '',
    tone,
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
