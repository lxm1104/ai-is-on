/**
 * MVP12 Step 2/3 — routing cache + dedup + cross-chat merge + link rank upgrade
 * 端到端测试。使用临时 sqlite db。
 *
 * 运行：npx tsx --test apps/server/test/mvp12-routing.test.ts
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 必须在 import db 之前覆盖 SQLITE_PATH
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp12-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertMinimalEventContextUnit, upsertContextUnit } = await import(
  '../src/context/contextStore.js'
);
const {
  listUnitSourcesByUnit,
  listUnitRoutingCacheByUnit,
  insertContextSpace,
  tryInsertContextSpaceLink,
  getContextSpaceLink,
  upsertContextSpaceLinkBestHit,
  tryInsertEvent,
} = await import('../src/db.js');
const { resolveOrCreateEntity } = await import('../src/context/entityResolver.js');
const { resolveUnitToSpaces } = await import(
  '../src/spaces/contextSpaceService.js'
);

import { randomUUID } from 'node:crypto';

function newEventId(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  tryInsertEvent({
    id,
    source: 'im',
    source_id: `test:${id}`,
    kind: 'group_message',
    occurred_at: now,
    title: 'test',
    text: 'test body',
    actor: null,
    url: null,
    raw_json: '{}',
    content_hash: id,
    processed_at: null,
    created_at: now,
  });
  return id;
}

// ---------- T1: insertMinimalEventContextUnit dedup ----------

test('insertMinimalEventContextUnit dedupes by (type, name, role) and unions collector + actor fallback', () => {
  const eventId = newEventId();
  const unit = insertMinimalEventContextUnit({
    eventId,
    scope: 'work',
    title: 'msg',
    content: 'body',
    occurredAt: new Date().toISOString(),
    source: 'im',
    actor: 'Alice',
    actorRole: 'actor',
    entities: [
      { type: 'chat', name: 'lark_chat:oc_abc', role: 'container' },
      { type: 'person', name: 'Alice', role: 'actor' },
      { type: 'person', name: 'Alice', role: 'actor' }, // duplicate
    ],
  });
  // Alice 既在 collector entities 也在 actor fallback；只保留一份
  const persons = unit.entities.filter((e) => e.type === 'person' && e.name === 'Alice');
  assert.equal(persons.length, 1, 'Alice dedup');
  const chats = unit.entities.filter((e) => e.type === 'chat');
  assert.equal(chats.length, 1, 'chat present');
});

test('actor fallback fires only if no actor-role entity from collector', () => {
  const eventId = newEventId();
  const unit = insertMinimalEventContextUnit({
    eventId,
    scope: 'work',
    title: 'msg',
    content: 'body',
    occurredAt: new Date().toISOString(),
    source: 'im',
    actor: 'Bob',
    actorRole: 'actor',
    entities: [{ type: 'chat', name: 'lark_chat:oc_xyz', role: 'container' }],
  });
  // 没有 collector-side actor → fallback 补一个 Bob
  const bobs = unit.entities.filter((e) => e.type === 'person' && e.name === 'Bob');
  assert.equal(bobs.length, 1, 'fallback Bob added');
});

// ---------- T2: unit_sources / unit_routing_cache 写入 ----------

test('event unit upsert writes unit_sources and unit_routing_cache with chat/doc only', () => {
  const eventId = newEventId();
  const unit = insertMinimalEventContextUnit({
    eventId,
    scope: 'work',
    title: 'msg',
    content: 'body',
    occurredAt: new Date().toISOString(),
    source: 'im',
    entities: [
      { type: 'chat', name: 'lark_chat:oc_routing1', role: 'container' },
      { type: 'doc', name: 'https://www.feishu.cn/docx/Tok1', role: 'about' },
      { type: 'person', name: 'Carol', role: 'actor' },
    ],
  });
  const srcs = listUnitSourcesByUnit(unit.id);
  assert.equal(srcs.length, 1);
  assert.equal(srcs[0].event_id, eventId);

  const cache = listUnitRoutingCacheByUnit(unit.id);
  assert.equal(cache.length, 1);
  const routing = JSON.parse(cache[0].routing_entities_json) as Array<{ type: string }>;
  // person 应该被过滤掉
  assert.equal(routing.length, 2);
  const types = routing.map((r) => r.type).sort();
  assert.deepEqual(types, ['chat', 'doc']);
});

// ---------- T3: semantic unit mergeKey 跨 event 合并保留多 source ----------

test('semantic unit merged across two events via mergeKey keeps both unit_sources', () => {
  const ev1 = newEventId();
  const ev2 = newEventId();
  const draft = {
    kind: 'commitment' as const,
    title: '周三前提交 spec',
    content: 'commitment body',
    entities: [{ type: 'project', name: 'MVP12', role: 'about' as const }],
    mergeHint: 'commit:周三前提交 spec',
  };
  // upsert 1 通过 ev1
  const r1 = upsertContextUnit({
    ...draft,
    scope: 'work',
    origin: { kind: 'event', refId: ev1 },
  });
  // upsert 2 通过 ev2，同 mergeKey 应触发 UPDATE
  const r2 = upsertContextUnit({
    ...draft,
    scope: 'work',
    origin: { kind: 'event', refId: ev2 },
  });
  assert.equal(r1.unit.id, r2.unit.id, 'same unit id');
  assert.equal(r2.wasUpdate, true);
  const srcs = listUnitSourcesByUnit(r1.unit.id);
  const events = srcs.map((s) => s.event_id).sort();
  assert.deepEqual(events, [ev1, ev2].sort(), 'both event sources kept');
});

// ---------- T4: resolver 通过 chat seed 命中 + rank 升级 ----------

test('resolver hits Space via chat seed (rank=1) then upgrades to person direct (rank=3)', () => {
  // 建一个 Space，seed = chat entity + person entity
  const chatEnt = resolveOrCreateEntity('chat', 'lark_chat:oc_seed_rank');
  const personEnt = resolveOrCreateEntity('person', 'David');
  const now = new Date().toISOString();
  const spaceId = randomUUID();
  insertContextSpace({
    id: spaceId,
    type: 'project',
    name: 'RankTestSpace',
    description: null,
    owner_subject_id: 'me',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  // seed chat
  tryInsertContextSpaceLink({
    id: randomUUID(),
    space_id: spaceId,
    target_type: 'entity',
    target_id: chatEnt.id,
    link_type: 'about',
    confidence: 1.0,
    created_at: now,
    reason_json: null,
  });
  // seed person
  tryInsertContextSpaceLink({
    id: randomUUID(),
    space_id: spaceId,
    target_type: 'entity',
    target_id: personEnt.id,
    link_type: 'about',
    confidence: 1.0,
    created_at: now,
    reason_json: null,
  });

  // Step A：commitment unit 起初只通过 chat 命中
  const evA = newEventId();
  // event unit 带 chat routing
  insertMinimalEventContextUnit({
    eventId: evA,
    scope: 'work',
    title: 'note',
    content: 'note body',
    occurredAt: now,
    source: 'im',
    entities: [{ type: 'chat', name: 'lark_chat:oc_seed_rank', role: 'container' }],
  });
  // semantic commitment unit, only 'project' entity (not matching)
  const cu = upsertContextUnit({
    kind: 'commitment',
    title: 'rank test commit',
    content: 'body',
    entities: [{ type: 'project', name: 'IrrelevantProj', role: 'about' }],
    mergeHint: 'commit:rank-test',
    scope: 'work',
    origin: { kind: 'event', refId: evA },
  });
  // resolver run (会通过 hook 自动跑；显式再跑一次保证幂等)
  resolveUnitToSpaces(cu.unit);
  const linkA = getContextSpaceLink(spaceId, 'context_unit', cu.unit.id);
  assert.ok(linkA, 'link created via chat seed');
  assert.equal(linkA!.link_type, 'about_via_chat');

  // Step B：同一 unit 再次 resolve，这次 in-memory 把 person David 加进 entities
  // 模拟 entityResolver / 后续触发器又给该 unit 加了 person 的场景。
  // (注：实际生产中 person 通常来自 commitment LLM 输出，不会影响 mergeKey 因为 mergeKey 用 primary entity ids；
  //  这里测试只关心 resolver 的 rank upgrade 行为。)
  const cuWithPerson = {
    ...cu.unit,
    entities: [
      ...cu.unit.entities,
      { type: 'person', name: 'David', role: 'actor' as const },
    ],
  };
  resolveUnitToSpaces(cuWithPerson);
  const linkB = getContextSpaceLink(spaceId, 'context_unit', cu.unit.id);
  assert.ok(linkB);
  assert.equal(linkB!.link_type, 'about', 'upgraded to about (rank=3)');
  const reason = JSON.parse(linkB!.reason_json ?? '{}');
  assert.equal(reason.via, 'person');
  assert.ok(reason.more && reason.more.length >= 1, 'old chat evidence in more[]');
});

// ---------- T5: link rank no-downgrade ----------

// ---------- T6: event update (追加 doc) → 已 materialize 的 semantic unit cache 重建 ----------

test('event re-upsert with new doc invalidates and rebuilds routing cache for downstream semantic units', () => {
  // 建一个 Space 以 doc URL 作 seed
  const docUrl = 'https://www.feishu.cn/docx/EventUpdateDocAAA';
  const docEnt = resolveOrCreateEntity('doc', docUrl);
  const now = new Date().toISOString();
  const spaceId = randomUUID();
  insertContextSpace({
    id: spaceId,
    type: 'topic',
    name: 'EventUpdateSpace',
    description: null,
    owner_subject_id: 'me',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  tryInsertContextSpaceLink({
    id: randomUUID(),
    space_id: spaceId,
    target_type: 'entity',
    target_id: docEnt.id,
    link_type: 'about',
    confidence: 1.0,
    created_at: now,
    reason_json: null,
  });

  const evId = newEventId();
  // 第一次 event unit：只含 chat，没有 doc
  insertMinimalEventContextUnit({
    eventId: evId,
    scope: 'work',
    title: 'first',
    content: 'no doc yet',
    occurredAt: now,
    source: 'im',
    entities: [{ type: 'chat', name: 'lark_chat:oc_evup', role: 'container' }],
  });
  // semantic commitment 经此 event 创建
  const cu = upsertContextUnit({
    kind: 'commitment',
    title: 'evup commit',
    content: 'body',
    entities: [{ type: 'project', name: 'Whatever', role: 'about' }],
    mergeHint: 'commit:evup',
    scope: 'work',
    origin: { kind: 'event', refId: evId },
  });
  // 此时 cu cache 不含 doc → resolver 不会命中
  resolveUnitToSpaces(cu.unit);
  const link0 = getContextSpaceLink(spaceId, 'context_unit', cu.unit.id);
  assert.equal(link0, null, 'no link before doc');

  // 第二次 event unit upsert（同 eventId）：text 里现在含 doc URL → entities 追加 doc
  insertMinimalEventContextUnit({
    eventId: evId,
    scope: 'work',
    title: 'with doc',
    content: `please see ${docUrl}`,
    occurredAt: now,
    source: 'im',
    entities: [
      { type: 'chat', name: 'lark_chat:oc_evup', role: 'container' },
      { type: 'doc', name: docUrl, role: 'about' },
    ],
  });
  // 现在 cu 的 cache 应该被重建，包含 doc
  const cuCache = listUnitRoutingCacheByUnit(cu.unit.id);
  const allEntities = cuCache.flatMap(
    (r) => JSON.parse(r.routing_entities_json) as Array<{ type: string; name: string }>
  );
  const hasDoc = allEntities.some((e) => e.type === 'doc' && e.name === docUrl);
  assert.ok(hasDoc, 'doc routing entity available to commitment unit via cache');

  resolveUnitToSpaces(cu.unit);
  const link1 = getContextSpaceLink(spaceId, 'context_unit', cu.unit.id);
  assert.ok(link1, 'link created via doc after event update');
  assert.equal(link1!.link_type, 'about_via_doc');
});

test('upsertContextSpaceLinkBestHit does not downgrade higher rank link', () => {
  const personEnt = resolveOrCreateEntity('person', 'Eve');
  const now = new Date().toISOString();
  const spaceId = randomUUID();
  insertContextSpace({
    id: spaceId,
    type: 'project',
    name: 'NoDowngrade',
    description: null,
    owner_subject_id: 'me',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  const unitId = randomUUID();
  // First insert as 'about' (rank=3)
  upsertContextSpaceLinkBestHit(
    spaceId,
    unitId,
    {
      rank: 3,
      linkType: 'about',
      confidence: 0.8,
      reason: { via: 'person', sourceEntityId: personEnt.id, sourceEntityName: 'Eve' },
    },
    randomUUID,
    now
  );
  // Then try lower rank chat seed (rank=1)
  upsertContextSpaceLinkBestHit(
    spaceId,
    unitId,
    {
      rank: 1,
      linkType: 'about_via_chat',
      confidence: 0.9,
      reason: { via: 'chat_seed', sourceEntityId: 'cx', sourceEntityName: 'lark_chat:oc_x' },
    },
    randomUUID,
    now
  );
  const link = getContextSpaceLink(spaceId, 'context_unit', unitId);
  assert.equal(link!.link_type, 'about', 'kept rank=3');
  assert.equal(link!.confidence, 0.8);
  const reason = JSON.parse(link!.reason_json ?? '{}');
  assert.equal(reason.via, 'person');
  assert.ok(reason.more && reason.more.some((m: { via: string }) => m.via === 'chat_seed'));
});
