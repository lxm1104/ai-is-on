/**
 * MVP15B M5 — assembleGraphContext 测试。
 *
 * 覆盖：null focal / 无 project focal / decisionPath 排除 self /
 *       expectedButMissing 排除 self / activeBlockers follows 上溯 /
 *       projectPhase 加载 / cache 命中
 *
 * 运行：npx tsx --test apps/server/test/mvp15b-graph-context.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15b-gc-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { assembleGraphContext, __internal } = await import('../src/context/graphContextAssembler.js');

const NOW = Date.parse('2026-05-27T10:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();

function resetDb() {
  __internal.resetCache();
  db.db.exec(`
    DELETE FROM entity_edges;
    DELETE FROM work_item_edges;
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM org_project_phase;
    DELETE FROM org_project_taxonomy;
    DELETE FROM settings WHERE key='self_person_entity_id';
  `);
}

function mkEntity(type: string, name: string): string {
  const id = randomUUID();
  db.insertContextEntity({
    id, type, name,
    aliases_json: null, source: null, confidence: 0.9,
    created_at: NOW_ISO, updated_at: NOW_ISO,
    attributes_json: null,
  });
  return id;
}

function mkUnit(kind: string, title: string, entityRefs: Array<{ id: string; role: string }>): string {
  const id = randomUUID();
  db.db.prepare(
    `INSERT INTO context_units (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content, time_json, actionability, confidence, status, created_at, updated_at, merge_key)
     VALUES (?, 'me', 'work', 'manual', ?, ?, ?, ?, NULL, 'record', 0.9, 'active', ?, ?, ?)`
  ).run(id, id, kind, title, title, NOW_ISO, NOW_ISO, `m:${id}`);
  for (const ref of entityRefs) {
    db.db.prepare(
      `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence) VALUES (?, ?, ?, 0.9)`
    ).run(id, ref.id, ref.role);
  }
  return id;
}

function mkPpjEdge(personId: string, projectCanonical: string, weight: number, role = 'contributor', da: string | null = null): string {
  const id = randomUUID();
  db.upsertEntityEdge({
    id, edge_kind: 'person_project',
    from_id: personId, to_id: projectCanonical,
    role_or_type: role, weight,
    business_relation: null, shared_ids_json: null,
    evidence_unit_ids_json: '[]',
    detected_at: NOW_ISO, last_seen_at: NOW_ISO, updated_at: NOW_ISO,
    decision_authority: da, collab_type: null, llm_classified_at: da ? NOW_ISO : null, llm_why: null,
  });
  return id;
}

test('T1 null focal → 返回 null', () => {
  resetDb();
  const r = assembleGraphContext('does-not-exist');
  assert.equal(r, null);
});

test('T2 focal 没 project entity → projectCanonicalNames 空 + decisionPath 空', () => {
  resetDb();
  const personA = mkEntity('person', 'A');
  const focal = mkUnit('state', 'no project', [{ id: personA, role: 'actor' }]);
  const slice = assembleGraphContext(focal, { now: NOW });
  assert.ok(slice);
  assert.deepEqual(slice!.focal.projectCanonicalNames, []);
  assert.equal(slice!.decisionPath.length, 0);
  assert.equal(slice!.expectedButMissing.persons.length, 0);
});

test('T3 decisionPath 按 (DA priority * 10 + role priority) 排序', () => {
  resetDb();
  const p1 = mkEntity('person', 'high-DA-contrib');
  const p2 = mkEntity('person', 'no-DA-owner');
  const p3 = mkEntity('person', 'no-DA-reviewer');
  const proj = mkEntity('project', 'Proj');
  const focal = mkUnit('state', 'about Proj', [{ id: proj, role: 'about' }]);
  // contributor weight=1 + DA=high → composite = 30+3 = 33
  // owner weight=1 + no DA → composite = 0+6 = 6
  // reviewer weight=1 + no DA → composite = 0+4 = 4
  mkPpjEdge(p1, 'Proj', 1, 'contributor', 'high');
  mkPpjEdge(p2, 'Proj', 1, 'owner');
  mkPpjEdge(p3, 'Proj', 1, 'reviewer');

  const slice = assembleGraphContext(focal, { now: NOW });
  assert.ok(slice);
  // high-DA-contributor 应当排在最前（composite=33）
  assert.equal(slice!.decisionPath[0].name, 'high-DA-contrib');
  assert.equal(slice!.decisionPath[0].decisionAuthority, 'high');
  // 第二是 owner（composite=6）
  assert.equal(slice!.decisionPath[1].name, 'no-DA-owner');
});

test('T4 self 不进 decisionPath / expectedButMissing', () => {
  resetDb();
  const selfId = mkEntity('person', 'Me');
  db.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('self_person_entity_id', ?, ?)`).run(selfId, NOW_ISO);
  const other = mkEntity('person', 'Other');
  const proj = mkEntity('project', 'Proj');
  const focal = mkUnit('state', 'about Proj', [{ id: proj, role: 'about' }]);
  mkPpjEdge(selfId, 'Proj', 3.0, 'owner');
  mkPpjEdge(other, 'Proj', 2.0, 'contributor');

  const slice = assembleGraphContext(focal, { now: NOW });
  assert.ok(slice);
  // self 不应当出现在 decisionPath
  assert.equal(slice!.decisionPath.find((d) => d.name === 'Me'), undefined);
  // self 也不在 expectedButMissing
  assert.equal(slice!.expectedButMissing.persons.find((p) => p.name === 'Me'), undefined);
});

test('T5 expectedButMissing 排除 focal 已有的 person', () => {
  resetDb();
  const a = mkEntity('person', 'Alice');
  const b = mkEntity('person', 'Bob');
  const proj = mkEntity('project', 'Proj');
  const focal = mkUnit('commitment', 'with Alice', [
    { id: a, role: 'actor' },
    { id: proj, role: 'about' },
  ]);
  mkPpjEdge(a, 'Proj', 2.0);
  mkPpjEdge(b, 'Proj', 2.0);
  const slice = assembleGraphContext(focal, { now: NOW });
  assert.ok(slice);
  // Alice 在 focal 里 → 不出现在 missing
  assert.equal(slice!.expectedButMissing.persons.find((p) => p.name === 'Alice'), undefined);
  // Bob 不在 → 应当出现
  assert.equal(slice!.expectedButMissing.persons[0]?.name, 'Bob');
});

test('T6 activeBlockers：follows 边上溯', () => {
  resetDb();
  const blockerUnit = mkUnit('commitment', '基准环境模型切换', []);
  const owner = mkEntity('person', 'Wang');
  db.db.prepare(
    `INSERT INTO context_unit_entities (context_unit_id, entity_id, role, confidence) VALUES (?, ?, 'actor', 0.9)`
  ).run(blockerUnit, owner);
  const focal = mkUnit('event', '我的新 commit', []);
  // work_item_edge: from=blocker to=focal type=follows → focal follows blocker
  db.upsertWorkItemEdge({
    id: randomUUID(),
    from_unit_id: blockerUnit, to_unit_id: focal,
    type: 'follows', status: 'active', reason: 'updates link',
    evidence_unit_ids_json: '[]',
    detected_at: NOW_ISO, resolved_at: null, updated_at: NOW_ISO,
  });
  const slice = assembleGraphContext(focal, { now: NOW });
  assert.ok(slice);
  assert.equal(slice!.activeBlockers.length, 1);
  assert.equal(slice!.activeBlockers[0].blockerTitle, '基准环境模型切换');
  assert.equal(slice!.activeBlockers[0].blockerOwner, 'Wang');
});

test('T7 projectPhase: 单 project 加载，多 project 不加载', () => {
  resetDb();
  const proj = mkEntity('project', 'X');
  const focal = mkUnit('state', 'about X', [{ id: proj, role: 'about' }]);
  db.upsertProjectPhase({
    canonical_name: 'X',
    phase: 'execution', health: 'at_risk',
    health_evidence_unit_ids_json: '[]',
    summary: 'at risk',
    llm_classified_at: NOW_ISO,
    ttl_until: new Date(NOW + 30 * 86400_000).toISOString(),
  });
  const slice = assembleGraphContext(focal, { now: NOW });
  assert.ok(slice);
  assert.equal(slice!.projectPhase?.phase, 'execution');
  assert.equal(slice!.projectPhase?.health, 'at_risk');

  // focal 涉及 2 个 project → 不加载 projectPhase
  __internal.resetCache();
  const proj2 = mkEntity('project', 'Y');
  const focal2 = mkUnit('state', 'about X and Y', [
    { id: proj, role: 'about' },
    { id: proj2, role: 'about' },
  ]);
  const slice2 = assembleGraphContext(focal2, { now: NOW });
  assert.ok(slice2);
  assert.equal(slice2!.projectPhase, undefined);
});

test('T8 cache 命中：60s 内 2nd call 返回同一 slice', () => {
  resetDb();
  const proj = mkEntity('project', 'C');
  const focal = mkUnit('state', 'about C', [{ id: proj, role: 'about' }]);
  const r1 = assembleGraphContext(focal, { now: NOW });
  const sizeBefore = __internal.cacheSize();
  assert.equal(sizeBefore, 1);
  // 改 db（写新 ppj edge）但不 reset cache → 第二次 call 应该返回 cached（不包含新 edge）
  const p = mkEntity('person', 'NewPerson');
  mkPpjEdge(p, 'C', 5.0);
  const r2 = assembleGraphContext(focal, { now: NOW + 30_000 });
  // 还是 cached（decisionPath 不含 NewPerson）
  assert.equal(r2?.decisionPath.find((d) => d.name === 'NewPerson'), undefined);

  // bypassCache → 现算
  const r3 = assembleGraphContext(focal, { now: NOW + 30_000, bypassCache: true });
  assert.equal(r3?.decisionPath.find((d) => d.name === 'NewPerson')?.name, 'NewPerson');
});

test('T9 cache 过期：60s 之后自动重算', () => {
  resetDb();
  const proj = mkEntity('project', 'D');
  const focal = mkUnit('state', 'about D', [{ id: proj, role: 'about' }]);
  assembleGraphContext(focal, { now: NOW });
  const p = mkEntity('person', 'LateAdd');
  mkPpjEdge(p, 'D', 5.0);
  // 60s+1 后再 call → cache 过期，重新算
  const r = assembleGraphContext(focal, { now: NOW + 61_000 });
  assert.equal(r?.decisionPath.find((d) => d.name === 'LateAdd')?.name, 'LateAdd');
});
