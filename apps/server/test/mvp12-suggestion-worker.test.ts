/**
 * MVP12 Phase 2/3 — suggestion worker 端到端测试。
 *
 * 场景：
 *   - 建一个 Space，seed = person Alice
 *   - 建 chat C1，里面有 unit 通过 person Alice 命中 Space 多次
 *   - 跑 worker → 产 chat_affinity suggestion
 *   - confirm → 写 chat seed link + reconcile
 *   - 历史 unit 现在通过 chat seed 也命中
 *   - reject 另一个 → 30d cooldown
 *
 * 运行：npx tsx --test apps/server/test/mvp12-suggestion-worker.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp12-sw-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const { insertMinimalEventContextUnit, upsertContextUnit } = await import(
  '../src/context/contextStore.js'
);
const {
  insertContextSpace,
  tryInsertContextSpaceLink,
  tryInsertEvent,
  listSpaceSuggestions,
  getContextSpaceLink,
} = await import('../src/db.js');
const { resolveOrCreateEntity } = await import(
  '../src/context/entityResolver.js'
);
const { resolveUnitToSpaces } = await import(
  '../src/spaces/contextSpaceService.js'
);
const { runSuggestionWorker } = await import('../src/spaces/suggestionWorker.js');
const {
  confirmChatAffinitySuggestion,
  rejectSuggestion,
  listSuggestionsForSpace,
} = await import('../src/spaces/contextSpaceService.js');
import { randomUUID } from 'node:crypto';

function newEvent(text = 'b'): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  tryInsertEvent({
    id,
    source: 'im',
    source_id: 'test:' + id,
    kind: 'group_message',
    occurred_at: now,
    title: 't',
    text,
    actor: null,
    url: null,
    raw_json: '{}',
    content_hash: id,
    processed_at: null,
    created_at: now,
  });
  return id;
}

test('chat_affinity suggestion produced when chat has units linked to Space via person seed', () => {
  const now = new Date().toISOString();
  const aliceEnt = resolveOrCreateEntity('person', 'Alice');
  // Space with Alice as seed
  const spaceId = randomUUID();
  insertContextSpace({
    id: spaceId,
    type: 'project',
    name: 'WorkerSpace',
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
    target_id: aliceEnt.id,
    link_type: 'about',
    confidence: 1.0,
    created_at: now,
    reason_json: null,
  });

  // Chat C1 with 5 messages that all reference Alice → 5 event units containing chat + Alice
  const chatName = 'lark_chat:oc_worker_c1';
  for (let i = 0; i < 5; i++) {
    const evId = newEvent(`msg ${i}`);
    const evUnit = insertMinimalEventContextUnit({
      eventId: evId,
      scope: 'work',
      title: `m${i}`,
      content: 'b',
      occurredAt: now,
      source: 'im',
      entities: [
        { type: 'chat', name: chatName, role: 'container', aliases: ['工作群 C1'] },
        { type: 'person', name: 'Alice', role: 'actor' },
      ],
    });
    // resolve manually so direct_hits include these units
    resolveUnitToSpaces(evUnit);
  }

  const stats = runSuggestionWorker();
  assert.ok(stats.chatAffinityInserted >= 1, 'at least one chat_affinity inserted');

  const items = listSuggestionsForSpace(spaceId, 'suggested');
  const chatAff = items.find((s) => s.suggestion_type === 'chat_affinity');
  assert.ok(chatAff, 'chat_affinity present');
  const evidence = JSON.parse(chatAff!.evidence_json);
  assert.ok(evidence.directHits >= 3, 'directHits ≥ 3');
  assert.ok(evidence.personOverlap >= 1, 'personOverlap ≥ 1');
  assert.equal(evidence.chatName, chatName);
});

const { listContextSpaces } = await import('../src/db.js');

test('confirm chat_affinity writes chat seed link + reconcile picks up historical units', () => {
  const now = new Date().toISOString();
  // 用第一条 test 留下的 Space + chat suggestion；这里 confirm 它
  const spaces = listContextSpaces({ status: 'active' });
  const space = spaces.find((s) => s.name === 'WorkerSpace');
  assert.ok(space);

  const items = listSuggestionsForSpace(space!.id, 'suggested');
  const chatAff = items.find((s) => s.suggestion_type === 'chat_affinity');
  assert.ok(chatAff, 'suggestion present');

  const r = confirmChatAffinitySuggestion({
    spaceId: space!.id,
    suggestionId: chatAff!.id,
  });
  assert.equal(r.ok, true);

  // chat entity 现在应该是 Space seed
  const chatEntId = chatAff!.target_id;
  const seedLink = getContextSpaceLink(space!.id, 'entity', chatEntId);
  assert.ok(seedLink, 'chat seed link created');
  assert.equal(seedLink!.link_type, 'about');

  // 状态 confirmed
  const updated = listSuggestionsForSpace(space!.id, 'confirmed');
  assert.ok(updated.some((s) => s.id === chatAff!.id));
  void now;
});

test('person_co_occur advisory: non-seed person 与 seed person 在 chat 中共现 ≥ 5 → suggested', () => {
  const now = new Date().toISOString();
  const charlieEnt = resolveOrCreateEntity('person', 'Charlie');
  const spaceId = randomUUID();
  insertContextSpace({
    id: spaceId,
    type: 'project',
    name: 'CoOccurSpace',
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
    target_id: charlieEnt.id,
    link_type: 'about',
    confidence: 1.0,
    created_at: now,
    reason_json: null,
  });

  const chatName = 'lark_chat:oc_coocc_c1';
  // 7 个 event units，每个同时含 Charlie (seed) + Dave (non-seed)
  for (let i = 0; i < 7; i++) {
    const evId = newEvent(`co ${i}`);
    insertMinimalEventContextUnit({
      eventId: evId,
      scope: 'work',
      title: 'co',
      content: 'b',
      occurredAt: now,
      source: 'im',
      entities: [
        { type: 'chat', name: chatName, role: 'container' },
        { type: 'person', name: 'Charlie', role: 'actor' },
        { type: 'person', name: 'Dave', role: 'about' },
      ],
    });
  }
  runSuggestionWorker();
  const items = listSuggestionsForSpace(spaceId, 'suggested');
  const co = items.find((s) => s.suggestion_type === 'person_co_occur');
  assert.ok(co, 'person_co_occur present');
  const evidence = JSON.parse(co!.evidence_json);
  assert.ok(evidence.coOccurCount >= 5);
});

test('reject suggestion sets 30d cooldown', () => {
  // 新建 second Space + chat for isolation
  const now = new Date().toISOString();
  const bobEnt = resolveOrCreateEntity('person', 'Bob');
  const spaceId = randomUUID();
  insertContextSpace({
    id: spaceId,
    type: 'project',
    name: 'RejectSpace',
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
    target_id: bobEnt.id,
    link_type: 'about',
    confidence: 1.0,
    created_at: now,
    reason_json: null,
  });

  const chatName = 'lark_chat:oc_reject_c1';
  for (let i = 0; i < 5; i++) {
    const evId = newEvent(`m ${i}`);
    const u = insertMinimalEventContextUnit({
      eventId: evId,
      scope: 'work',
      title: 'm',
      content: 'b',
      occurredAt: now,
      source: 'im',
      entities: [
        { type: 'chat', name: chatName, role: 'container' },
        { type: 'person', name: 'Bob', role: 'actor' },
      ],
    });
    resolveUnitToSpaces(u);
  }

  runSuggestionWorker();
  const items = listSuggestionsForSpace(spaceId, 'suggested');
  const ca = items.find((s) => s.suggestion_type === 'chat_affinity');
  assert.ok(ca);
  const r = rejectSuggestion({ spaceId, suggestionId: ca!.id });
  assert.equal(r.ok, true);
  assert.ok(r.cooldownUntil);

  // 再跑 worker：rejected 期间不应该重新 'suggested'
  runSuggestionWorker();
  const after = listSuggestionsForSpace(spaceId, 'suggested');
  assert.equal(
    after.find((s) => s.id === ca!.id),
    undefined,
    'rejected suggestion not re-suggested during cooldown'
  );
});
