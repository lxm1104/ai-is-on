/**
 * MVP26 §12.1 — Matter store / projection / 纯函数单测。
 *
 * 覆盖：
 *  - createMatter 原子写 matter + created_by link + 初始 transition
 *  - listMatters status 过滤
 *  - getMatterByCreatedFromContextUnit 幂等查询
 *  - attach* 幂等（PK 冲突 upsert）
 *  - listMattersForContextUnit 反查
 *  - projection detail hydrate entity 名 / evidence kind+title / timeline
 *  - 纯函数 canonicalize / canonicalKey / classifyType / inferPriority(work_map_seed cap) / role map
 *
 * 运行：npx tsx --test apps/server/test/mvp26-matter-store.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp26-matter-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const ms = await import('../src/matter/matterStore.js');
const mp = await import('../src/matter/matterProjection.js');
const mt = await import('../src/matter/matterTypes.js');
const cs = await import('../src/context/contextStore.js');

const NOW_ISO = new Date('2026-06-01T09:00:00Z').toISOString();

function resetDb() {
  db.db.exec(`
    DELETE FROM matters;
    DELETE FROM matter_entities;
    DELETE FROM matter_context_links;
    DELETE FROM matter_transitions;
    DELETE FROM context_units;
    DELETE FROM context_entities;
    DELETE FROM context_unit_entities;
    DELETE FROM context_space_links;
    DELETE FROM context_spaces;
  `);
}

test('T1 createMatter 写 matter + created_by link + 初始 transition', () => {
  resetDb();
  const m = ms.createMatter({
    scope: 'work',
    type: 'discussion',
    title: '安排与 Yufan 讨论',
    canonicalKey: 'k-t1',
    createdFromContextUnitId: 'unit-t1',
    now: NOW_ISO,
  });

  const got = ms.getMatterById(m.id);
  assert.ok(got, 'getMatterById 应返回');
  assert.equal(got!.status, 'open');
  assert.equal(got!.priority, 'P2');
  assert.equal(got!.version, 1);
  assert.equal(got!.reopenedCount, 0);
  assert.equal(got!.lastEvidenceContextUnitId, 'unit-t1');

  const links = ms.listMatterContextLinks(m.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'created_by');
  assert.equal(links[0].effect, 'create');
  assert.equal(links[0].contextUnitId, 'unit-t1');

  const tr = ms.listMatterTransitions(m.id);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].fromStatus, null);
  assert.equal(tr[0].toStatus, 'open');
  assert.equal(tr[0].effect, 'create');
});

test('T2 listMatters 按 status 过滤', () => {
  resetDb();
  ms.createMatter({ scope: 'work', type: 'follow_up', title: 'A', canonicalKey: 'ka', createdFromContextUnitId: 'ua', status: 'open', now: NOW_ISO });
  ms.createMatter({ scope: 'work', type: 'follow_up', title: 'B', canonicalKey: 'kb', createdFromContextUnitId: 'ub', status: 'resolved', now: NOW_ISO });

  assert.equal(ms.listMatters({ statuses: ['open'] }).length, 1);
  assert.equal(ms.listMatters({ statuses: ['resolved'] }).length, 1);
  assert.equal(ms.listMatters({ statuses: ['open', 'resolved'] }).length, 2);
  assert.equal(ms.listMatters().length, 2);
});

test('T3 getMatterByCreatedFromContextUnit 幂等查询', () => {
  resetDb();
  const m = ms.createMatter({ scope: 'work', type: 'follow_up', title: 'C', canonicalKey: 'kc', createdFromContextUnitId: 'uc', now: NOW_ISO });
  const found = ms.getMatterByCreatedFromContextUnit('uc');
  assert.ok(found);
  assert.equal(found!.id, m.id);
  assert.equal(ms.getMatterByCreatedFromContextUnit('nope'), null);
});

test('T4 attach* 幂等（PK 冲突 upsert，不堆重复行）', () => {
  resetDb();
  const m = ms.createMatter({ scope: 'work', type: 'follow_up', title: 'D', canonicalKey: 'kd', createdFromContextUnitId: 'ud', now: NOW_ISO });

  // 同一 (matter, entity, role) 写两次 → 仍 1 行
  ms.attachMatterEntity({ matterId: m.id, entityId: 'e1', role: 'participant', confidence: 0.5, now: NOW_ISO });
  ms.attachMatterEntity({ matterId: m.id, entityId: 'e1', role: 'participant', confidence: 0.9, now: NOW_ISO });
  const ents = ms.listMatterEntities(m.id);
  assert.equal(ents.length, 1);
  assert.equal(ents[0].confidence, 0.9, 'confidence 应被 upsert 覆盖');

  // 同一 (matter, unit, relation) 写两次 → 仍 1 行，effect 被覆盖
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: 'ux', relation: 'evidence', effect: 'no_change', reason: 'r1', now: NOW_ISO });
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: 'ux', relation: 'evidence', effect: 'progress', reason: 'r2', now: NOW_ISO });
  const ev = ms.listMatterContextLinks(m.id).filter((l) => l.contextUnitId === 'ux');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].effect, 'progress');
  assert.equal(ev[0].reason, 'r2');
});

test('T5 listMattersForContextUnit 反查一条 unit 影响的 Matter', () => {
  resetDb();
  const m = ms.createMatter({ scope: 'work', type: 'follow_up', title: 'E', canonicalKey: 'ke', createdFromContextUnitId: 'ue', now: NOW_ISO });
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: 'shared-unit', relation: 'progressed_by', effect: 'progress', reason: 'r', now: NOW_ISO });

  const viaCreated = ms.listMattersForContextUnit('ue');
  assert.equal(viaCreated.length, 1);
  assert.equal(viaCreated[0].matter.id, m.id);
  assert.equal(viaCreated[0].link.relation, 'created_by');

  const viaProgress = ms.listMattersForContextUnit('shared-unit');
  assert.equal(viaProgress.length, 1);
  assert.equal(viaProgress[0].link.relation, 'progressed_by');
});

test('T6 projection detail hydrate entity 名 / evidence kind+title / timeline', () => {
  resetDb();
  // 用真实 context unit + entity，让 projection 能 hydrate
  const { unit } = cs.upsertContextUnit({
    kind: 'commitment',
    title: '安排与 Yufan 讨论记忆召回',
    content: '准备拉 Yufan 同步一下记忆召回设计',
    scope: 'work',
    origin: { kind: 'manual', refId: 't6' },
    entities: [{ type: 'person', name: 'Yufan', role: 'actor' }],
    actionability: 'act',
  });
  const ent = db.getContextEntityByTypeName('person', 'Yufan');
  assert.ok(ent, 'entity 应已创建');

  const m = ms.createMatter({
    scope: 'work',
    type: 'discussion',
    title: '安排与 Yufan 讨论',
    canonicalKey: 'k-t6',
    createdFromContextUnitId: unit.id,
    entities: [{ entityId: ent!.id, role: 'participant' }],
    now: NOW_ISO,
  });

  const detail = mp.projectMatterDetail(m.id);
  assert.ok(detail);
  assert.equal(detail!.entities.length, 1);
  assert.equal(detail!.entities[0].name, 'Yufan');
  assert.equal(detail!.entities[0].type, 'person');
  assert.equal(detail!.evidence.length, 1);
  assert.equal(detail!.evidence[0].kind, 'commitment');
  assert.equal(detail!.evidence[0].title, '安排与 Yufan 讨论记忆召回');
  assert.equal(detail!.timeline.length, 1);
  assert.equal(detail!.timeline[0].toStatus, 'open');
});

test('T7a canonicalizeMatterTitle 去事件化前缀/问号', () => {
  assert.equal(mt.canonicalizeMatterTitle('我直接拉 yufan 说一下？'), '拉 yufan 说一下');
  assert.equal(mt.canonicalizeMatterTitle('是否需要评审设计文档'), '需要评审设计文档');
  // 状态尾巴去掉
  assert.equal(mt.canonicalizeMatterTitle('发方案给 A，已完成'), '发方案给 A');
});

test('T7b computeMatterCanonicalKey 顺序无关 + 区分动作', () => {
  const k1 = mt.computeMatterCanonicalKey({ subjectId: 'me', primaryEntityIds: ['a', 'b'], actionPhrase: '讨论' });
  const k2 = mt.computeMatterCanonicalKey({ subjectId: 'me', primaryEntityIds: ['b', 'a'], actionPhrase: '讨论' });
  const k3 = mt.computeMatterCanonicalKey({ subjectId: 'me', primaryEntityIds: ['a', 'b'], actionPhrase: '排期' });
  assert.equal(k1, k2, '主对象顺序不应影响 key');
  assert.notEqual(k1, k3, '动作不同应得到不同 key');
});

test('T7c classifyMatterType 关键词分类', () => {
  assert.equal(mt.classifyMatterType({ title: '安排与 Yufan 讨论' }), 'discussion');
  assert.equal(mt.classifyMatterType({ title: '评审设计文档' }), 'review');
  assert.equal(mt.classifyMatterType({ title: '约个时间对一下排期' }), 'coordination');
  assert.equal(mt.classifyMatterType({ title: '随便记一笔' }), 'follow_up');
});

test('T7d inferMatterPriority work_map_seed 上限 P2', () => {
  const now = Date.parse('2026-06-01T09:00:00Z');
  const dueSoon = new Date(now + 3 * 3600_000).toISOString(); // 3h 后
  // 非 seed：临期 + act + executor → P0
  assert.equal(
    mt.inferMatterPriority({ dueAt: dueSoon, actionability: 'act', selfRole: 'executor', isWorkMapSeed: false, now }),
    'P0'
  );
  // seed：同样输入被 cap 到 P2
  assert.equal(
    mt.inferMatterPriority({ dueAt: dueSoon, actionability: 'act', selfRole: 'executor', isWorkMapSeed: true, now }),
    'P2'
  );
  // 无 due / record → 不高于 P2（observer 再降到 P3）
  assert.equal(
    mt.inferMatterPriority({ dueAt: null, actionability: 'record', selfRole: 'observer', isWorkMapSeed: false, now }),
    'P3'
  );
});

test('T7e mapContextRoleToMatterRole', () => {
  assert.equal(mt.mapContextRoleToMatterRole('person', 'actor'), 'executor');
  assert.equal(mt.mapContextRoleToMatterRole('person', 'reviewer'), 'reviewer');
  assert.equal(mt.mapContextRoleToMatterRole('person', 'requester'), 'requester');
  assert.equal(mt.mapContextRoleToMatterRole('person', 'mentioned'), 'participant');
  assert.equal(mt.mapContextRoleToMatterRole('chat'), 'container');
  assert.equal(mt.mapContextRoleToMatterRole('doc'), 'target');
  assert.equal(mt.mapContextRoleToMatterRole('project'), 'about');
});
