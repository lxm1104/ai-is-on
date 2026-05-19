import { getCard } from '../db.js';
import {
  findEventContextUnitId,
  getContextUnitById,
  listLinksFor,
} from '../context/contextStore.js';
import type { ContextUnit } from '../context/ContextUnit.js';

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
 */
export function projectCardContext(cardId: string): CardContextProjection {
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
