/**
 * MVP15B M2 — projectPhaseClassifier 测试。
 *
 * 覆盖：LLM hook 注入 / cache 命中跳过 LLM / TTL 过期重判 /
 *       force=true 跳过缓存 / LLM 失败兜底不写表 / LLM 漏返某 canonical
 *
 * 运行：npx tsx --test apps/server/test/mvp15b-project-phase.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp15b-pp-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { refreshProjectPhasesIfNeeded } = await import(
  '../src/util/projectPhaseClassifier.js'
);

const NOW = Date.parse('2026-05-27T10:00:00Z');

function resetDb() {
  db.db.exec(`
    DELETE FROM org_project_phase;
    DELETE FROM org_project_taxonomy;
    DELETE FROM context_entities;
  `);
}

function seedTaxonomy(names: string[]): void {
  for (const name of names) {
    db.upsertProjectTaxonomy({
      canonical_name: name,
      aliases_json: JSON.stringify([name]),
      summary: null,
      parsed_by: 'manual',
      parsed_at: new Date(NOW).toISOString(),
    });
  }
}

test('T1 空 taxonomy → run=false', async () => {
  resetDb();
  const r = await refreshProjectPhasesIfNeeded({ now: NOW });
  assert.equal(r.run, false);
  assert.equal(r.refreshed, 0);
});

test('T2 happy path：LLM 给所有 canonical 打 phase + health', async () => {
  resetDb();
  seedTaxonomy(['Chatbot', 'AIME']);
  const mock = async () =>
    JSON.stringify({
      phases: [
        {
          canonicalName: 'Chatbot',
          phase: 'execution',
          health: 'at_risk',
          healthEvidenceUnitIds: [],
          summary: 'Chatbot 临期 review',
        },
        {
          canonicalName: 'AIME',
          phase: 'planning',
          health: 'unknown',
          healthEvidenceUnitIds: [],
          summary: '',
        },
      ],
    });
  const r = await refreshProjectPhasesIfNeeded({ now: NOW, llmHook: mock });
  assert.equal(r.refreshed, 2);
  assert.equal(r.failed, 0);
  const c = db.getProjectPhase('Chatbot');
  assert.equal(c?.phase, 'execution');
  assert.equal(c?.health, 'at_risk');
  const a = db.getProjectPhase('AIME');
  assert.equal(a?.phase, 'planning');
});

test('T3 cache 命中：ttl 未过期 → run=false 不调 LLM', async () => {
  // T2 残留的缓存还在；用同 NOW 跑应当跳过
  let called = 0;
  const mock = async () => {
    called++;
    return JSON.stringify({ phases: [] });
  };
  const r = await refreshProjectPhasesIfNeeded({ now: NOW + 1000, llmHook: mock });
  assert.equal(r.run, false);
  assert.equal(called, 0);
  assert.equal(r.skipped, 2);
});

test('T4 ttl 过期 → 自动重判', async () => {
  // NOW + 31 天 (TTL_MS = 30 天)
  const future = NOW + 31 * 86400_000;
  let called = 0;
  const mock = async () => {
    called++;
    return JSON.stringify({
      phases: [
        {
          canonicalName: 'Chatbot',
          phase: 'review',
          health: 'on_track',
          healthEvidenceUnitIds: [],
          summary: '',
        },
        {
          canonicalName: 'AIME',
          phase: 'execution',
          health: 'on_track',
          healthEvidenceUnitIds: [],
          summary: '',
        },
      ],
    });
  };
  const r = await refreshProjectPhasesIfNeeded({ now: future, llmHook: mock });
  assert.equal(r.run, true);
  assert.equal(called, 1);
  assert.equal(r.refreshed, 2);
  assert.equal(db.getProjectPhase('Chatbot')?.phase, 'review');
});

test('T5 force=true → 跳过 ttl', async () => {
  let called = 0;
  const mock = async () => {
    called++;
    return JSON.stringify({
      phases: [
        { canonicalName: 'Chatbot', phase: 'frozen', health: 'unknown', healthEvidenceUnitIds: [], summary: '' },
        { canonicalName: 'AIME', phase: 'execution', health: 'on_track', healthEvidenceUnitIds: [], summary: '' },
      ],
    });
  };
  // NOW + 1s (上一个 test 之后 ttl 仍很新)
  const r = await refreshProjectPhasesIfNeeded({
    now: NOW + 1000,
    llmHook: mock,
    force: true,
  });
  assert.equal(r.run, true);
  assert.equal(called, 1);
  assert.equal(r.refreshed, 2);
});

test('T6 LLM 抛错 → failed 计数，db 不污染', async () => {
  resetDb();
  seedTaxonomy(['Solo']);
  const errMock = async () => {
    throw new Error('boom');
  };
  const r = await refreshProjectPhasesIfNeeded({ now: NOW, llmHook: errMock });
  assert.equal(r.refreshed, 0);
  assert.equal(r.failed, 1);
  assert.equal(db.getProjectPhase('Solo'), null);
});

test('T7 LLM 漏返某 canonical → 漏者 failed，其它正常写', async () => {
  resetDb();
  seedTaxonomy(['Alpha', 'Beta']);
  const partialMock = async () =>
    JSON.stringify({
      phases: [
        { canonicalName: 'Alpha', phase: 'planning', health: 'unknown', healthEvidenceUnitIds: [], summary: '' },
        // Beta missing
      ],
    });
  const r = await refreshProjectPhasesIfNeeded({ now: NOW, llmHook: partialMock });
  assert.equal(r.refreshed, 1);
  assert.equal(r.failed, 1);
  assert.equal(db.getProjectPhase('Alpha')?.phase, 'planning');
  assert.equal(db.getProjectPhase('Beta'), null);
});

test('T8 LLM 返非法 phase 值 → 该条被 filter，记 failed', async () => {
  resetDb();
  seedTaxonomy(['X']);
  const badMock = async () =>
    JSON.stringify({
      phases: [
        { canonicalName: 'X', phase: 'INVALID', health: 'on_track', healthEvidenceUnitIds: [], summary: '' },
      ],
    });
  const r = await refreshProjectPhasesIfNeeded({ now: NOW, llmHook: badMock });
  assert.equal(r.refreshed, 0);
  assert.equal(r.failed, 1);
});

test('T9 LLM 返 JSON 解析失败 → 整批 failed', async () => {
  resetDb();
  seedTaxonomy(['Y']);
  const garbageMock = async () => '这不是 json';
  const r = await refreshProjectPhasesIfNeeded({ now: NOW, llmHook: garbageMock });
  assert.equal(r.refreshed, 0);
  assert.equal(r.failed, 1);
});
