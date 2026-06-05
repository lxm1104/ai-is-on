/**
 * MVP29A — Matter 级用户动作 + triage MatterObservation 管道。
 *
 * Run: npx tsx --test apps/server/test/mvp29-matter-actions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp29-actions-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const cs = await import('../src/context/contextStore.js');
const ms = await import('../src/matter/matterStore.js');
const ma = await import('../src/matter/matterActions.js');
const pt = await import('../src/triage/parseTriage.js');

const NOW_ISO = new Date('2026-06-04T09:00:00Z').toISOString();

function resetDb() {
  db.db.exec(`
    DELETE FROM matters; DELETE FROM matter_entities;
    DELETE FROM matter_context_links; DELETE FROM matter_transitions;
    DELETE FROM matter_observations;
    DELETE FROM context_units; DELETE FROM context_entities; DELETE FROM context_unit_entities;
  `);
}

let n = 0;
function mkMatter(createdFrom: string, entities?: Array<{ entityId: string; role: 'participant' }>) {
  n += 1;
  return ms.createMatter({
    scope: 'work',
    type: 'discussion',
    title: `事项${n}`,
    canonicalKey: `k-${n}`,
    createdFromContextUnitId: createdFrom,
    status: 'open',
    priority: 'P2',
    entities,
    now: NOW_ISO,
  });
}

test('T1 userResolveMatter → resolved + transition(user_action)', () => {
  resetDb();
  const m = mkMatter('u1');
  const out = ma.userResolveMatter(m.id, undefined, NOW_ISO);
  assert.ok(out);
  assert.equal(out!.status, 'resolved');
  assert.ok(out!.resolvedAt);
  const tr = ms.listMatterTransitions(m.id);
  assert.ok(tr.some((t) => t.toStatus === 'resolved' && t.triggerContextUnitId === 'user_action'));
});

test('T2 userDropMatter → dropped', () => {
  resetDb();
  const m = mkMatter('u1');
  const out = ma.userDropMatter(m.id, undefined, NOW_ISO);
  assert.equal(out!.status, 'dropped');
  assert.ok(out!.droppedAt);
});

test('T3 userReopenMatter：dropped 也可手动重开（reopenedCount+1）', () => {
  resetDb();
  const m = mkMatter('u1');
  ma.userDropMatter(m.id, undefined, NOW_ISO);
  const out = ma.userReopenMatter(m.id, undefined, NOW_ISO);
  assert.equal(out!.status, 'in_progress');
  assert.equal(out!.reopenedCount, 1);
  assert.equal(out!.resolvedAt, null);
});

test('T4 mergeMatters：证据+实体并入 target，source 置 dropped', () => {
  resetDb();
  const src = mkMatter('su', [{ entityId: 'e-yufan', role: 'participant' }]);
  ms.attachMatterContextLink({ matterId: src.id, contextUnitId: 'ev1', relation: 'progressed_by', effect: 'progress', reason: 'r', now: NOW_ISO });
  const tgt = mkMatter('tu');

  const result = ma.mergeMatters(src.id, tgt.id, NOW_ISO);
  assert.ok(result);
  assert.equal(ms.getMatterById(src.id)!.status, 'dropped');
  const tgtLinks = ms.listMatterContextLinks(tgt.id).map((l) => l.contextUnitId);
  assert.ok(tgtLinks.includes('ev1'), 'target 应吸收 source 的 evidence');
  assert.ok(tgtLinks.includes('su'), 'source 的 created_by 也并入（转 evidence）');
  assert.ok(ms.listMatterEntities(tgt.id).some((e) => e.entityId === 'e-yufan'));
});

test('T5 splitEvidence：拆出新 Matter，原 link 标 dismissed_by', () => {
  resetDb();
  const u = cs.upsertContextUnit({
    kind: 'commitment', title: '子事项 X', content: '独立的一件事',
    scope: 'work', origin: { kind: 'manual', refId: 'sp1' }, entities: [],
  }).unit;
  const m = mkMatter('parent');
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: u.id, relation: 'evidence', effect: 'no_change', reason: 'r', now: NOW_ISO });

  const created = ma.splitEvidence(m.id, u.id, '独立事项', NOW_ISO);
  assert.ok(created);
  assert.equal(created!.createdFromContextUnitId, u.id);
  assert.equal(created!.title, '独立事项');
  const link = ms.listMatterContextLinks(m.id).find((l) => l.contextUnitId === u.id);
  assert.ok(link && link.relation === 'dismissed_by', '原 Matter 上该 evidence 应标 dismissed_by');
});

test('T6 markWrongEvidence：relabel 为 dismissed_by，不堆重复 link', () => {
  resetDb();
  const m = mkMatter('parent');
  ms.attachMatterContextLink({ matterId: m.id, contextUnitId: 'evX', relation: 'progressed_by', effect: 'progress', reason: 'r', now: NOW_ISO });
  const ok = ma.markWrongEvidence(m.id, 'evX', undefined, NOW_ISO);
  assert.equal(ok, true);
  const links = ms.listMatterContextLinks(m.id).filter((l) => l.contextUnitId === 'evX');
  assert.equal(links.length, 1, '旧关系被删，只剩 dismissed_by 一条');
  assert.equal(links[0].relation, 'dismissed_by');
});

test('T7 triage matterObservations：coerce + store 往返；非法 type 丢弃', () => {
  resetDb();
  const parsed = pt.parseTriageResult(
    JSON.stringify({
      items: [
        {
          sourceEventId: 'ev1',
          matterObservations: [
            { observationType: 'resolution', matterType: 'discussion', title: '安排与 yufan 讨论', lifecycleEffect: 'resolve', evidence: '已拉群讨论', confidence: 0.8 },
          ],
        },
      ],
    })
  );
  assert.equal(parsed.items[0].matterObservations.length, 1);
  const obs = parsed.items[0].matterObservations[0];
  assert.equal(obs.observationType, 'resolution');
  assert.equal(obs.lifecycleEffect, 'resolve');

  ms.recordMatterObservation({
    sourceEventId: 'ev1',
    contextUnitIds: ['u1'],
    observationType: obs.observationType,
    matterType: obs.matterType,
    title: obs.title,
    lifecycleEffect: obs.lifecycleEffect,
    evidence: obs.evidence,
    confidence: obs.confidence,
    now: NOW_ISO,
  });
  const rows = ms.listMatterObservationsForEvent('ev1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observation_type, 'resolution');
  assert.deepEqual(JSON.parse(rows[0].context_unit_ids_json), ['u1']);

  // 非法 observationType / 无 title → 丢弃
  const bad = pt.parseTriageResult(
    JSON.stringify({ items: [{ sourceEventId: 'e', matterObservations: [{ observationType: 'nonsense', title: 'x' }, { observationType: 'progress' }] }] })
  );
  assert.equal(bad.items[0].matterObservations.length, 0);
});
