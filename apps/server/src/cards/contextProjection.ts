import { getCard, db } from '../db.js';
import {
  findEventContextUnitId,
  getContextUnitById,
  listLinksFor,
} from '../context/contextStore.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { getAttentionItem } from '../attention/attentionStore.js';

/**
 * MVP14 Step3：attention item 的 signalIds 来自 LLM，id 可能指向以下任一表：
 *   1) context_units.id  → 直接 ContextUnit
 *   2) cards.id (source_kind='agent_run') → 解开找 raw_event_id → event ContextUnit
 *   3) events.id          → 找对应的 minimal event ContextUnit
 * 三层兜底：哪种命中就用哪种。
 */
function resolveAttentionSignals(ids: string[]): ContextUnit[] {
  const seen = new Set<string>();
  const out: ContextUnit[] = [];
  for (const sid of ids) {
    if (seen.has(sid)) continue;
    seen.add(sid);

    // (1) 直接是 ContextUnit
    const direct = getContextUnitById(sid);
    if (direct) {
      out.push(direct);
      continue;
    }

    // (2) agent_run card → raw_event_id → event ContextUnit
    const card = getCard(sid);
    if (card) {
      if (card.raw_event_id) {
        const evUnitId = findEventContextUnitId(card.raw_event_id);
        if (evUnitId && !seen.has(evUnitId)) {
          seen.add(evUnitId);
          const u = getContextUnitById(evUnitId);
          if (u) out.push(u);
        }
      }
      // card 本身没有 ContextUnit 表示，但我们想把它作为可识别的项返回。
      // 简化：包装为一个虚拟 ContextUnit，前端 ContextPanel 仍然按 kind/title 渲染。
      const virt: ContextUnit = {
        id: card.id,
        subjectId: 'me',
        scope: 'work',
        origin: { kind: 'agent_run', refId: card.source_ref_id ?? card.id },
        kind: 'action_result',
        title: card.title,
        content: card.summary,
        entities: [],
        actionability: 'notify',
        confidence: 0.8,
        version: 1,
        status: 'active',
        createdAt: card.created_at,
        updatedAt: card.updated_at,
      };
      out.push(virt);
      continue;
    }

    // (3) 当 event.id 处理
    const evRow = db
      .prepare(`SELECT id FROM events WHERE id = ?`)
      .get(sid) as { id?: string } | undefined;
    if (evRow?.id) {
      const evUnitId = findEventContextUnitId(evRow.id);
      if (evUnitId && !seen.has(evUnitId)) {
        seen.add(evUnitId);
        const u = getContextUnitById(evUnitId);
        if (u) out.push(u);
      }
    }
  }
  return out;
}

export type CardContextProjection = {
  cardId: string;
  eventContextUnitId: string | null;
  relatedUnits: ContextUnit[];
};

/**
 * For a card, surface the ContextUnits the system associated with the
 * underlying raw event — i.e. "为什么相关". MVP2.2:
 *   card → raw_event_id → event ContextUnit → context_links{from} → related units
 *
 * We deliberately do NOT chase further hops here; one level keeps it readable.
 *
 * MVP14 Step 3: 同一个 id 命名空间下也允许传 attention_item id。
 *   attention item → signalIds → 直接列出对应 ContextUnit（不需要走 event→links 链）
 *   这样 ContextPanel 对 attention 流的卡片也能展示"为什么相关"。
 */
export function projectCardContext(cardId: string): CardContextProjection {
  // 优先看 attention：现在前端唯一来源是 attention，命中率最高
  const attn = getAttentionItem(cardId);
  if (attn) {
    const out = resolveAttentionSignals(attn.signalIds);
    const anchor = out.find((u) => u.kind === 'event') ?? null;
    return {
      cardId,
      eventContextUnitId: anchor?.id ?? null,
      relatedUnits: out,
    };
  }

  // 旧路径：cards 表（专项 agent 残留卡）
  const card = getCard(cardId);
  if (!card) {
    return { cardId, eventContextUnitId: null, relatedUnits: [] };
  }
  const eventId = card.raw_event_id;
  if (!eventId) {
    return { cardId, eventContextUnitId: null, relatedUnits: [] };
  }
  const eventUnitId = findEventContextUnitId(eventId);
  if (!eventUnitId) {
    return { cardId, eventContextUnitId: null, relatedUnits: [] };
  }
  const links = listLinksFor(eventUnitId);
  const seen = new Set<string>([eventUnitId]);
  const out: ContextUnit[] = [];
  for (const l of links) {
    const otherId = l.from_context_id === eventUnitId ? l.to_context_id : l.from_context_id;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const unit = getContextUnitById(otherId);
    if (unit) out.push(unit);
  }
  return { cardId, eventContextUnitId: eventUnitId, relatedUnits: out };
}
