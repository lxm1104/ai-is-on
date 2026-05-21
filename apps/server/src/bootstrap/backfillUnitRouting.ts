/**
 * MVP12 §4.1 P1.9 — backfill unit_sources + unit_routing_cache。
 *
 * 适用：升级到 MVP12 前已有的 context_units / events 没有 unit_sources
 * 与 unit_routing_cache 记录，导致旧 unit 在 Phase 1 上线后短时间内
 * 仍走不到新的路由路径。
 *
 * 策略（不调 LLM、不写 DB 主表）：
 *   1) 遍历 context_units WHERE origin_kind='event'：写 unit_sources
 *      (unit_id, event_id=origin_ref_id)。idempotent on UNIQUE。
 *   2) 拿对应 event 的 raw_json + text，重抽 routing entities：
 *        - im: 用 raw.chat + raw.msg/msgs/sender 重建 chat / app / person entities
 *        - drive: 用 raw.result_meta.url 重建 doc entity
 *        - 任何 source: 用 extractFeishuDocUrls(text) 补 doc entities
 *      然后 filter 到 routing types (chat / doc / app)，写 unit_routing_cache。
 *   3) 通过 context_links{updates} 关联到 event unit 的 semantic units 也写
 *      unit_sources，并把 step 2 的 routing entities 复用。
 *
 * 副作用控制：
 *   - 不调 LLM
 *   - 不修改 events / context_units / context_entities 主表
 *   - 重复执行幂等
 *
 * 触发方式：admin route POST /api/admin/backfill-unit-routing，返回统计。
 */
import { randomUUID } from 'node:crypto';
import {
  db,
  deleteUnitRoutingCacheByEvent,
  insertUnitSource,
  linkUnitEntity,
  listEvents,
  listSpacesForTarget as _unusedListSpaces,
  upsertUnitRoutingCache,
  type EventRow,
} from '../db.js';
import { extractFeishuDocUrls } from '../util/extractFeishuDocRefs.js';
import { mergeDocIdentity, resolveOrCreateEntity } from '../context/entityResolver.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';

// silence unused import (kept for forward use)
void _unusedListSpaces;

type UnitRow = {
  id: string;
  origin_ref_id: string;
  kind: string;
};

export type BackfillStats = {
  eventsScanned: number;
  unitSourcesInserted: number;
  cacheRowsWritten: number;
  entityLinksInserted: number;
};

export function backfillUnitRouting(opts: { eventLimit?: number } = {}): BackfillStats {
  const limit = opts.eventLimit ?? 5000;
  const events = listEvents(limit);
  const stats: BackfillStats = {
    eventsScanned: events.length,
    unitSourcesInserted: 0,
    cacheRowsWritten: 0,
    entityLinksInserted: 0,
  };
  const now = new Date().toISOString();

  // 缓存 routing entities per event
  const routingByEvent = new Map<string, ContextEntityRef[]>();

  for (const ev of events) {
    const routing = extractRoutingEntitiesFromEvent(ev);
    routingByEvent.set(ev.id, routing);
  }

  for (const ev of events) {
    const units = unitsOriginatedFromEvent(ev.id);
    const semanticUnits = unitsLinkedViaUpdates(units.map((u) => u.id));
    const allUnitIds = new Set<string>([
      ...units.map((u) => u.id),
      ...semanticUnits.map((u) => u.id),
    ]);
    const eventUnitIds = new Set(units.map((u) => u.id));

    // 1) unit_sources
    for (const uid of allUnitIds) {
      const ok = insertUnitSource({
        id: randomUUID(),
        unit_id: uid,
        event_id: ev.id,
        recorded_at: now,
      });
      if (ok) stats.unitSourcesInserted++;
    }

    // 2) routing cache (清空此 event 然后重建)
    const routing = routingByEvent.get(ev.id) ?? [];
    deleteUnitRoutingCacheByEvent(ev.id);
    const json = JSON.stringify(routing);
    for (const uid of allUnitIds) {
      upsertUnitRoutingCache({
        id: randomUUID(),
        unit_id: uid,
        source_event_id: ev.id,
        routing_entities_json: json,
        updated_at: now,
      });
      stats.cacheRowsWritten++;
    }

    // 3) MVP12 fix：旧 event ContextUnit 的 context_unit_entities 表里没有
    // chat / doc / app entity（升级前 imCollector 不写它们）。worker 走的是
    // context_unit_entities → event unit 这一链路，所以必须把这些 routing entity
    // 也补进去，否则 chat_affinity 永远扫不到老 event。
    //
    // 只为 event unit 补；semantic unit 的 entities 由 cache 处理。
    if (routing.length > 0) {
      for (const uid of eventUnitIds) {
        for (const e of routing) {
          try {
            const ent = resolveOrCreateEntity(e.type, e.name, e.aliases);
            linkUnitEntity({
              context_unit_id: uid,
              entity_id: ent.id,
              role: e.role ?? 'about',
              confidence: e.confidence ?? 0.7,
            });
            stats.entityLinksInserted++;
          } catch {
            /* swallow */
          }
        }
      }
    }
  }

  return stats;
}

function unitsOriginatedFromEvent(eventId: string): UnitRow[] {
  return db
    .prepare(
      `SELECT id, origin_ref_id, kind FROM context_units
       WHERE origin_kind = 'event' AND origin_ref_id = ? AND status = 'active'`
    )
    .all(eventId) as UnitRow[];
}

function unitsLinkedViaUpdates(eventUnitIds: string[]): UnitRow[] {
  if (eventUnitIds.length === 0) return [];
  const placeholders = eventUnitIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT cu.id as id, cu.origin_ref_id as origin_ref_id, cu.kind as kind
       FROM context_links cl
       JOIN context_units cu ON cu.id = cl.to_context_id
       WHERE cl.link_type = 'updates' AND cl.from_context_id IN (${placeholders})
         AND cu.status = 'active'`
    )
    .all(...eventUnitIds) as UnitRow[];
}

function extractRoutingEntitiesFromEvent(ev: EventRow): ContextEntityRef[] {
  const out: ContextEntityRef[] = [];
  const seen = new Set<string>();
  const push = (e: ContextEntityRef) => {
    const key = `${e.type}::${e.name}::${e.role ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  // raw_json 解析
  let raw: unknown = null;
  try {
    raw = JSON.parse(ev.raw_json);
  } catch {
    raw = null;
  }

  if (ev.source === 'im' && raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const chat = (r.chat as Record<string, unknown> | undefined) ?? undefined;
    const chatId =
      (chat?.chat_id as string | undefined) ?? (r.chatId as string | undefined);
    if (chatId) {
      const chatName = (chat?.name as string | undefined) ?? undefined;
      push({
        type: 'chat',
        name: `lark_chat:${chatId}`,
        aliases: chatName ? [chatName] : undefined,
        role: 'container',
        confidence: 1.0,
      });
    }
    // 单条 msg
    const msg = r.msg as Record<string, unknown> | undefined;
    if (msg) {
      const sender = msg.sender as Record<string, unknown> | undefined;
      const senderEnt = buildSenderEntity(sender);
      if (senderEnt) push(senderEnt);
    }
    // aggregated msgs
    const msgs = Array.isArray(r.msgs) ? (r.msgs as Array<Record<string, unknown>>) : null;
    if (msgs) {
      for (const m of msgs) {
        const sender = m.sender as Record<string, unknown> | undefined;
        const senderEnt = buildSenderEntity(sender);
        if (senderEnt) push(senderEnt);
      }
    }
  } else if (ev.source === 'drive' && raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const meta = (r.result_meta as Record<string, unknown> | undefined) ?? undefined;
    const docUrl = meta?.url as string | undefined;
    const token = meta?.token as string | undefined;
    if (docUrl) {
      if (token) {
        try {
          mergeDocIdentity(token, docUrl);
        } catch {
          /* swallow */
        }
      }
      push({ type: 'doc', name: docUrl, role: 'about', confidence: 1.0 });
    }
    const editor = meta?.edit_user_name as string | undefined;
    if (editor) {
      push({ type: 'person', name: editor, role: 'actor', confidence: 0.9 });
    }
  }

  // 通用：扫 text 抽 feishu doc URL
  const { urls, tokens } = extractFeishuDocUrls(ev.text ?? '');
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const tk = tokens[i];
    if (tk) {
      try {
        mergeDocIdentity(tk, url);
      } catch {
        /* swallow */
      }
    }
    push({ type: 'doc', name: url, role: 'about', confidence: 1.0 });
  }

  // 只保留 routing 类型
  return out.filter((e) => e.type === 'chat' || e.type === 'doc' || e.type === 'app');
}

function buildSenderEntity(
  sender?: Record<string, unknown>
): ContextEntityRef | null {
  if (!sender) return null;
  const id = sender.id as string | undefined;
  const name = sender.name as string | undefined;
  const senderType = sender.sender_type as string | undefined;
  const displayName = name?.trim() || id?.trim();
  if (!displayName) return null;
  const isBot = senderType === 'app' || (id && id.startsWith('cli_'));
  if (isBot) {
    return { type: 'app', name: displayName, role: 'actor', confidence: 0.9 };
  }
  return { type: 'person', name: displayName, role: 'actor', confidence: 0.9 };
}
