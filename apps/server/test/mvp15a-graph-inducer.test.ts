/**
 * MVP15A §8.1 — graph inducer 集成测试。
 *
 * 覆盖：personProject / personPerson / workItem follows / SelfCollaboratorRanking /
 * purgeStaleEdges / throttle / force / 空态 / alias dedup / role 频次门槛.
 *
 * 注：projectTaxonomy LLM 部分用 skipTaxonomy=true 绕过；taxonomy 自身测试在
 *     mvp15a-project-taxonomy.test.ts。
 *
 * 运行：npx tsx --test apps/server/test/mvp15a-graph-inducer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15a-graph-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { runGraphInducer, resetThrottle } = await import(
  '../src/context/graphInducer.js'
);
const { inducePersonProjectEdges, inferRole } = await import(
  '../src/context/personProjectInducer.js'
);
const { inducePersonPersonEdges, computeBusinessRelation } = await import(
  '../src/context/personPersonInducer.js'
);
const { induceWorkItemFollowsEdges, purgeStaleEdges } = await import(
  '../src/context/workItemInducer.js'
);
const { buildSelfCollaboratorRanking, __internal: scrInternal } = await import(
  '../src/context/selfCollaboratorRanking.js'
);

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------
function resetDb() {
  db.db.exec(`
    DELETE FROM entity_edges;
    DELETE FROM work_item_edges;
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM context_links;
    DELETE FROM settings WHERE key='self_person_entity_id';
    DELETE FROM org_project_taxonomy;
  `);
  resetThrottle();
  scrInternal.resetCache();
}

function mkEntity(opts: {
  type: string;
  name: string;
  attrs?: Record<string, unknown>;
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insertContextEntity({
    id,
    type: opts.type,
    name: opts.name,
    aliases_json: null,
    source: null,
    confidence: 0.8,
    created_at: now,
    updated_at: now,
    attributes_json: opts.attrs ? JSON.stringify(opts.attrs) : null,
  });
  return id;
}

function mkUnit(opts: {
  kind: string;
  title: string;
  entities: Array<{ entityId: string; role: string }>;
  updatedAt?: string;
}): string {
  const id = randomUUID();
  const now = opts.updatedAt ?? new Date().toISOString();
  db.db
    .prepare(
      `INSERT INTO context_units
       (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
        actionability, confidence, version, status, created_at, updated_at)
       VALUES (?, 'me', 'work', 'manual', 'test', ?, ?, '', 'record', 0.9, 1,
               'active', ?, ?)`
    )
    .run(id, opts.kind, opts.title, now, now);
  for (const e of opts.entities) {
    db.db
      .prepare(
        `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence)
         VALUES (?, ?, ?, 1.0)`
      )
      .run(id, e.entityId, e.role);
  }
  return id;
}

const NOW = Date.parse('2026-05-27T10:00:00Z');

// ----------------------------------------------------------------------------
// T1: PersonPerson inducer
// ----------------------------------------------------------------------------
test('T1 PersonPerson: 共现入边 + weight + businessRelation', () => {
  resetDb();
  const alice = mkEntity({
    type: 'person',
    name: 'Alice',
    attrs: { larkDepartmentName: 'Lark Base Automation', larkDeptBusiness: 'Lark Base', larkSyncedAt: '2026-05-27T08:00:00Z' },
  });
  const bob = mkEntity({
    type: 'person',
    name: 'Bob',
    attrs: { larkDepartmentName: 'Lark Base Automation', larkDeptBusiness: 'Lark Base', larkSyncedAt: '2026-05-27T08:00:00Z' },
  });
  const carol = mkEntity({
    type: 'person',
    name: 'Carol',
    attrs: { larkDeptBusiness: 'TikTok', larkSyncedAt: '2026-05-27T08:00:00Z' },
  });
  // Alice & Bob 共现 3 次（不同 unit）
  for (let i = 0; i < 3; i++) {
    mkUnit({
      kind: 'event',
      title: `evt-${i}`,
      entities: [
        { entityId: alice, role: 'actor' },
        { entityId: bob, role: 'about' },
      ],
      updatedAt: new Date(NOW - i * 86400_000).toISOString(),
    });
  }
  // Alice & Carol 共现 1 次（cross_business）
  mkUnit({
    kind: 'event',
    title: 'evt-x',
    entities: [
      { entityId: alice, role: 'actor' },
      { entityId: carol, role: 'about' },
    ],
    updatedAt: new Date(NOW).toISOString(),
  });

  const r = inducePersonPersonEdges({ now: NOW });
  assert.ok(r.written >= 2, `expected ≥2 edges, got ${r.written}`);
  const edges = db.listEntityEdges({ kind: 'person_person', limit: 10 });
  const ab = edges.find((e) => [e.from_id, e.to_id].sort().join('|') === [alice, bob].sort().join('|'));
  const ac = edges.find((e) => [e.from_id, e.to_id].sort().join('|') === [alice, carol].sort().join('|'));
  assert.ok(ab, 'Alice-Bob edge present');
  assert.ok(ac, 'Alice-Carol edge present');
  assert.equal(ab!.business_relation, 'same_business');
  assert.equal(ac!.business_relation, 'cross_business');
  // 3 cooccur 应该比 1 cooccur weight 高
  assert.ok(ab!.weight > ac!.weight);
});

// ----------------------------------------------------------------------------
// T2: PersonProject role 频次门槛
// ----------------------------------------------------------------------------
test('T2 PersonProject role: 2×commitment.actor → owner', () => {
  resetDb();
  const alice = mkEntity({ type: 'person', name: 'Alice' });
  const prj = mkEntity({ type: 'project', name: 'AtlasOne' });
  for (let i = 0; i < 2; i++) {
    mkUnit({
      kind: 'commitment',
      title: `c-${i}`,
      entities: [
        { entityId: alice, role: 'actor' },
        { entityId: prj, role: 'about' },
      ],
      updatedAt: new Date(NOW - i * 86400_000).toISOString(),
    });
  }
  inducePersonProjectEdges({ now: NOW });
  const edges = db.listEntityEdges({ kind: 'person_project', limit: 10 });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].role_or_type, 'owner');
});

test('T2.bis PersonProject role: 单次 commitment.actor → contributor', () => {
  resetDb();
  const alice = mkEntity({ type: 'person', name: 'Alice' });
  const prj = mkEntity({ type: 'project', name: 'AtlasOne' });
  // 单次 commitment.actor + 多次 event.about（凑 cooccur≥2）
  mkUnit({
    kind: 'commitment',
    title: 'c1',
    entities: [
      { entityId: alice, role: 'actor' },
      { entityId: prj, role: 'about' },
    ],
    updatedAt: new Date(NOW).toISOString(),
  });
  mkUnit({
    kind: 'event',
    title: 'e1',
    entities: [
      { entityId: alice, role: 'about' },
      { entityId: prj, role: 'about' },
    ],
    updatedAt: new Date(NOW - 86400_000).toISOString(),
  });
  inducePersonProjectEdges({ now: NOW });
  const edges = db.listEntityEdges({ kind: 'person_project', limit: 10 });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].role_or_type, 'contributor');
});

test('T2.inferRole unit: 多 hint 时优先级正确', () => {
  assert.equal(inferRole(['commitment:actor', 'commitment:actor']), 'owner');
  assert.equal(inferRole(['goal:actor', 'goal:actor']), 'driver');
  assert.equal(inferRole(['decision:actor']), 'reviewer');
  assert.equal(inferRole(['commitment:actor', 'commitment:about']), 'contributor');
  assert.equal(
    inferRole(['event:about', 'event:about', 'event:about', 'event:about']),
    'stakeholder'
  );
});

// ----------------------------------------------------------------------------
// T3: PersonProject taxonomy canonical merge
// ----------------------------------------------------------------------------
test('T3 PersonProject canonical merge：3 个 entity 名 → 1 canonical 边', () => {
  resetDb();
  const alice = mkEntity({ type: 'person', name: 'Alice' });
  const p1 = mkEntity({ type: 'project', name: 'chatbot agent 建设' });
  const p2 = mkEntity({ type: 'project', name: 'Chatbot 产研协同' });
  const p3 = mkEntity({ type: 'project', name: 'chatbot 评测' });
  // taxonomy 把三者合并到 canonical 'Chatbot 产研协同'
  db.upsertProjectTaxonomy({
    canonical_name: 'Chatbot 产研协同',
    aliases_json: JSON.stringify([
      'chatbot agent 建设',
      'Chatbot 产研协同',
      'chatbot 评测',
    ]),
    summary: 'Chatbot 项目总线',
    parsed_by: 'llm',
    parsed_at: new Date(NOW).toISOString(),
  });
  // Alice 在 3 个不同 entity 上各出现 1 次（同 unit 各 1 个 cooccur）
  // group by canonical name 后变成 3 次共现到 'Chatbot 产研协同'，过 cooccur≥2
  for (const pid of [p1, p2, p3]) {
    mkUnit({
      kind: 'commitment',
      title: `c-${pid}`,
      entities: [
        { entityId: alice, role: 'actor' },
        { entityId: pid, role: 'about' },
      ],
      updatedAt: new Date(NOW).toISOString(),
    });
  }
  inducePersonProjectEdges({ now: NOW });
  const edges = db.listEntityEdges({ kind: 'person_project', limit: 10 });
  assert.equal(edges.length, 1, 'taxonomy merge 后只剩 1 条 canonical 边');
  assert.equal(edges[0].to_id, 'Chatbot 产研协同');
});

// ----------------------------------------------------------------------------
// T4: WorkItem follows from context_links
// ----------------------------------------------------------------------------
test('T4 WorkItem follows: updates link → follows 方向正确 + self-loop 跳过', () => {
  resetDb();
  const alice = mkEntity({ type: 'person', name: 'Alice' });
  const ua = mkUnit({ kind: 'commitment', title: 'A', entities: [{ entityId: alice, role: 'actor' }] });
  const ub = mkUnit({ kind: 'commitment', title: 'B', entities: [{ entityId: alice, role: 'actor' }] });
  // context_links: B updates A
  db.db
    .prepare(
      `INSERT INTO context_links (id, from_context_id, to_context_id, link_type, confidence, created_at)
       VALUES (?, ?, ?, 'updates', 0.9, ?)`
    )
    .run(randomUUID(), ub, ua, new Date(NOW).toISOString());
  // self-loop link
  db.db
    .prepare(
      `INSERT INTO context_links (id, from_context_id, to_context_id, link_type, confidence, created_at)
       VALUES (?, ?, ?, 'updates', 0.9, ?)`
    )
    .run(randomUUID(), ua, ua, new Date(NOW).toISOString());

  const r = induceWorkItemFollowsEdges();
  assert.equal(r.written, 1, '只 1 条边写入（self-loop 跳过）');
  assert.equal(r.skippedSelfLoop, 1);
  const edges = db.listWorkItemEdges({});
  // 方向：A follows B（A 跟随 B 的 updates）
  assert.equal(edges[0].from_unit_id, ua);
  assert.equal(edges[0].to_unit_id, ub);
  assert.equal(edges[0].type, 'follows');
  assert.equal(edges[0].status, 'active');
});

// ----------------------------------------------------------------------------
// T5: SelfCollaboratorRanking
// ----------------------------------------------------------------------------
test('T5 SCR: top-N by weight + sharedProjects 交集 + 空 self 不抛', () => {
  resetDb();
  // 空 self
  assert.deepEqual(buildSelfCollaboratorRanking({ limit: 10 }), []);

  // 设 self（注意：name 不能用 'me'/'Me'/'我'，会被 inducer SQL filter 过滤）
  const self = mkEntity({
    type: 'person',
    name: '刘昕明',
    attrs: { larkDepartmentName: 'Lark Base Automation', larkDeptBusiness: 'Lark Base', larkSyncedAt: '2026-05-27T08:00:00Z' },
  });
  db.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('self_person_entity_id', ?, ?)`).run(self, new Date(NOW).toISOString());

  const bob = mkEntity({
    type: 'person',
    name: 'Bob',
    attrs: { larkDepartmentName: 'Lark Base Automation', larkDeptBusiness: 'Lark Base', larkSyncedAt: '2026-05-27T08:00:00Z' },
  });
  const prj = mkEntity({ type: 'project', name: 'AtlasOne' });

  // self ↔ bob 共现 3 次
  for (let i = 0; i < 3; i++) {
    mkUnit({
      kind: 'event',
      title: `e-${i}`,
      entities: [
        { entityId: self, role: 'actor' },
        { entityId: bob, role: 'about' },
      ],
      updatedAt: new Date(NOW - i * 86400_000).toISOString(),
    });
  }
  // self 在 AtlasOne 项目
  mkUnit({
    kind: 'commitment',
    title: 'c1',
    entities: [
      { entityId: self, role: 'actor' },
      { entityId: prj, role: 'about' },
    ],
    updatedAt: new Date(NOW).toISOString(),
  });
  mkUnit({
    kind: 'commitment',
    title: 'c2',
    entities: [
      { entityId: self, role: 'actor' },
      { entityId: prj, role: 'about' },
    ],
    updatedAt: new Date(NOW - 86400_000).toISOString(),
  });
  // bob 也在 AtlasOne
  mkUnit({
    kind: 'commitment',
    title: 'c3',
    entities: [
      { entityId: bob, role: 'actor' },
      { entityId: prj, role: 'about' },
    ],
    updatedAt: new Date(NOW).toISOString(),
  });
  mkUnit({
    kind: 'commitment',
    title: 'c4',
    entities: [
      { entityId: bob, role: 'actor' },
      { entityId: prj, role: 'about' },
    ],
    updatedAt: new Date(NOW - 86400_000).toISOString(),
  });

  inducePersonProjectEdges({ now: NOW });
  inducePersonPersonEdges({ now: NOW });
  scrInternal.resetCache();
  const entries = buildSelfCollaboratorRanking({ limit: 10 });
  assert.equal(entries.length, 1, 'self 协作圈包含 Bob');
  assert.equal(entries[0].name, 'Bob');
  assert.equal(entries[0].orgRole, 'peer_same_dept');
  assert.deepEqual(entries[0].sharedProjectCanonicalNames, ['AtlasOne']);
});

// ----------------------------------------------------------------------------
// T6: businessRelation 派生
// ----------------------------------------------------------------------------
test('T6 computeBusinessRelation: external > same_business > cross_business > unknown', () => {
  const a = { larkDeptBusiness: 'Lark Base', larkSyncedAt: 's' };
  const b = { larkDeptBusiness: 'Lark Base', larkSyncedAt: 's' };
  const c = { larkDeptBusiness: 'TikTok', larkSyncedAt: 's' };
  const x = { larkIsCrossTenant: true };

  assert.equal(computeBusinessRelation(a, b), 'same_business');
  assert.equal(computeBusinessRelation(a, c), 'cross_business');
  assert.equal(computeBusinessRelation(a, x), 'external');
  assert.equal(computeBusinessRelation(a, null), 'unknown');
  assert.equal(computeBusinessRelation({} as never, b), 'unknown');
});

// ----------------------------------------------------------------------------
// T7-T8: throttle + force
// ----------------------------------------------------------------------------
test('T7 runGraphInducer 5min throttle', async () => {
  resetDb();
  const r1 = await runGraphInducer({ skipTaxonomy: true });
  const r2 = await runGraphInducer({ skipTaxonomy: true }); // 立刻第二次
  assert.equal(r1.ranAt, r2.ranAt, 'throttle 命中：第二次返回相同 ranAt');
});

test('T8 runGraphInducer force=true 跳过 throttle', async () => {
  resetDb();
  const r1 = await runGraphInducer({ skipTaxonomy: true });
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await runGraphInducer({ skipTaxonomy: true, force: true });
  assert.notEqual(r1.ranAt, r2.ranAt, 'force 跳过 throttle，得新 ranAt');
});

// ----------------------------------------------------------------------------
// T8.5/8.6/8.7: 空态 + purge self-guard
// ----------------------------------------------------------------------------
test('T8.5 空 self → SCR 返回 [] 不抛', () => {
  resetDb();
  const entries = buildSelfCollaboratorRanking({});
  assert.deepEqual(entries, []);
});

test('T8.6 空图 → 所有 inducer 0 written，不抛', () => {
  resetDb();
  const ppj = inducePersonProjectEdges({ now: NOW });
  const pp = inducePersonPersonEdges({ now: NOW });
  const wi = induceWorkItemFollowsEdges();
  assert.equal(ppj.written, 0);
  assert.equal(pp.written, 0);
  assert.equal(wi.written, 0);
});

test('T8.7 purgeStaleEdges self-guard: self 边保留，其它过期边删除', () => {
  resetDb();
  const self = mkEntity({ type: 'person', name: 'Me' });
  const other = mkEntity({ type: 'person', name: 'Other' });
  const stranger = mkEntity({ type: 'person', name: 'Stranger' });
  db.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('self_person_entity_id', ?, ?)`).run(self, new Date(NOW).toISOString());
  const oldIso = new Date(NOW - 100 * 86400_000).toISOString();
  // self↔other 100 天前
  db.upsertEntityEdge({
    id: randomUUID(),
    edge_kind: 'person_person',
    from_id: self < other ? self : other,
    to_id: self < other ? other : self,
    role_or_type: null,
    weight: 1,
    business_relation: null,
    shared_ids_json: null,
    evidence_unit_ids_json: '[]',
    detected_at: oldIso,
    last_seen_at: oldIso,
    updated_at: oldIso,
  });
  // stranger↔other 100 天前（无 self）
  db.upsertEntityEdge({
    id: randomUUID(),
    edge_kind: 'person_person',
    from_id: stranger < other ? stranger : other,
    to_id: stranger < other ? other : stranger,
    role_or_type: null,
    weight: 1,
    business_relation: null,
    shared_ids_json: null,
    evidence_unit_ids_json: '[]',
    detected_at: oldIso,
    last_seen_at: oldIso,
    updated_at: oldIso,
  });
  // dryRun first
  const dry = purgeStaleEdges({ now: NOW, dryRun: true, cutoffDays: 90 });
  assert.equal(dry.entityEdgesMatched, 1, 'dryRun matches 1 (self 边排除)');
  assert.equal(dry.entityEdgesDeleted, 0);
  // real purge
  const real = purgeStaleEdges({ now: NOW, dryRun: false, cutoffDays: 90 });
  assert.equal(real.entityEdgesDeleted, 1);
  const remaining = db.listEntityEdges({ kind: 'person_person' });
  assert.equal(remaining.length, 1, '只剩 self 边');
});

// ----------------------------------------------------------------------------
// T9: alias dedup（同人不同 alias → canonical 一致）
// ----------------------------------------------------------------------------
test('T9 PersonPerson alias dedup: 2 个 alias 指向同人 → 1 canonical 节点', () => {
  resetDb();
  const aliceMain = mkEntity({ type: 'person', name: 'Alice' });
  const aliceAlt = mkEntity({ type: 'person', name: 'Alicia' });
  // alias aliceAlt → aliceMain
  db.db
    .prepare(
      `INSERT INTO entity_aliases (id, alias_of, created_at) VALUES (?, ?, ?)`
    )
    .run(aliceAlt, aliceMain, new Date(NOW).toISOString());
  const bob = mkEntity({ type: 'person', name: 'Bob' });
  // (aliceMain, Bob) 共现 2 次
  for (let i = 0; i < 2; i++) {
    mkUnit({
      kind: 'event',
      title: `e-${i}`,
      entities: [
        { entityId: aliceMain, role: 'actor' },
        { entityId: bob, role: 'about' },
      ],
      updatedAt: new Date(NOW - i * 86400_000).toISOString(),
    });
  }
  // (aliceAlt, Bob) 共现 1 次（应该 alias 化合并到 aliceMain）
  mkUnit({
    kind: 'event',
    title: 'e-2',
    entities: [
      { entityId: aliceAlt, role: 'actor' },
      { entityId: bob, role: 'about' },
    ],
    updatedAt: new Date(NOW).toISOString(),
  });

  inducePersonPersonEdges({ now: NOW });
  const edges = db.listEntityEdges({ kind: 'person_person' });
  assert.equal(edges.length, 1, 'alias 化后只 1 条 canonical 边');
  // canonical id 是 aliceMain（按 < 排序，可能在 from 或 to）
  const ids = [edges[0].from_id, edges[0].to_id];
  assert.ok(ids.includes(aliceMain));
  assert.ok(ids.includes(bob));
  assert.ok(!ids.includes(aliceAlt), 'aliasAlt 没出现在边里');
});
