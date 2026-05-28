/**
 * MVP19 §M4 — /api/projects/proposals 路由集成测试。
 *
 * 自带 express 实例 + 真 listen 端口；通过 fetch 调用，避免引入 supertest 依赖。
 *
 * 运行：npx tsx --test apps/server/test/mvp19-proposals-route.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp19-route-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbMod = await import('../src/db.js');
const { projectsRouter } = await import('../src/routes/projects.js');

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function nowIso() {
  return new Date().toISOString();
}

function resetDb() {
  dbMod.db.exec(`
    DELETE FROM org_project_taxonomy;
    DELETE FROM project_canonical_proposals;
  `);
}

async function get(p: string) {
  const r = await fetch(`${baseUrl}${p}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function post(p: string, body: unknown) {
  const r = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ============================================================================
// T1: GET /projects/proposals 列 pending
// ============================================================================

test('M19.GET /projects/proposals 列出 pending 行（按 last_seen_at 倒序）', async () => {
  resetDb();
  dbMod.upsertProjectCanonicalProposal({
    proposedName: 'Old',
    sourceUnitIds: ['u1'],
    sourceEventId: 'e1',
  });
  // 用稍晚时间戳保证排序
  await new Promise((r) => setTimeout(r, 10));
  dbMod.upsertProjectCanonicalProposal({
    proposedName: 'Newer',
    sourceUnitIds: ['u2'],
    sourceEventId: 'e2',
  });

  const r = await get('/projects/proposals');
  assert.equal(r.status, 200);
  const items = (r.json as { items: Array<{ proposedName: string }> }).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].proposedName, 'Newer');
  assert.equal(items[1].proposedName, 'Old');
});

// ============================================================================
// T2: POST .../:id/resolve action='approve_new'
// ============================================================================

test('M19.approve_new：创建新 canonical + 设 status', async () => {
  resetDb();
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'BrandNew',
    sourceUnitIds: ['u1'],
    sourceEventId: 'e1',
  });
  const r = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'approve_new',
  });
  assert.equal(r.status, 200);
  assert.equal((r.json as { ok: boolean }).ok, true);

  // 验证 canonical 已写
  const tax = dbMod.db
    .prepare(`SELECT * FROM org_project_taxonomy WHERE canonical_name='BrandNew'`)
    .get() as { parsed_by: string } | undefined;
  assert.ok(tax);
  assert.equal(tax!.parsed_by, 'user');

  // 验证 proposal 状态
  const after = dbMod.getProjectProposal(created.id);
  assert.equal(after!.status, 'approved_new');
  assert.equal(after!.resolved_canonical_name, 'BrandNew');
});

test('M19.approve_new with parent：parent 必须存在', async () => {
  resetDb();
  const now = nowIso();
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'ParentOK',
    aliases_json: '["ParentOK"]',
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'Child',
    sourceUnitIds: [],
    sourceEventId: null,
  });
  // parent 不存在 → 400
  const bad = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'approve_new',
    parentCanonical: 'DoesNotExist',
  });
  assert.equal(bad.status, 400);

  // parent 存在 → 200，且新 canonical 行 parent 字段正确
  const ok = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'approve_new',
    parentCanonical: 'ParentOK',
  });
  assert.equal(ok.status, 200);
  const row = dbMod.db
    .prepare(`SELECT parent_canonical_name FROM org_project_taxonomy WHERE canonical_name='Child'`)
    .get() as { parent_canonical_name: string | null };
  assert.equal(row.parent_canonical_name, 'ParentOK');
});

// ============================================================================
// T3: POST approve_alias
// ============================================================================

test('M19.approve_alias：proposed_name 加到 target.aliases_json', async () => {
  resetDb();
  const now = nowIso();
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'Target',
    aliases_json: JSON.stringify(['Target', 'TargetAlias']),
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'NewSynonym',
    sourceUnitIds: ['u1'],
    sourceEventId: null,
  });
  const r = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'approve_alias',
    target: 'Target',
  });
  assert.equal(r.status, 200);

  // 验证 aliases_json 含 NewSynonym
  const row = dbMod.db
    .prepare(`SELECT aliases_json FROM org_project_taxonomy WHERE canonical_name='Target'`)
    .get() as { aliases_json: string };
  const aliases = JSON.parse(row.aliases_json) as string[];
  assert.ok(aliases.includes('NewSynonym'));
  assert.ok(aliases.includes('TargetAlias'), '原 alias 应保留（并集合并）');

  // resolveProjectCanonical 现在应能命中
  assert.equal(dbMod.resolveProjectCanonical('NewSynonym'), 'Target');
});

test('M19.approve_alias：target 不存在返回 400', async () => {
  resetDb();
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'X',
    sourceUnitIds: [],
    sourceEventId: null,
  });
  const r = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'approve_alias',
    target: 'GhostCanonical',
  });
  assert.equal(r.status, 400);
});

test('M19.approve_alias：alias 跨行冲突返回 409', async () => {
  resetDb();
  const now = nowIso();
  // 两个独立 canonical
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'A',
    aliases_json: JSON.stringify(['A', 'sharedX']),
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  dbMod.upsertProjectTaxonomy({
    canonical_name: 'B',
    aliases_json: JSON.stringify(['B']),
    summary: null,
    parsed_by: 'manual',
    parsed_at: now,
  });
  // proposed_name='sharedX' 已属于 A；试图合并到 B 应被 alias 跨行唯一性挡掉
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'sharedX',
    sourceUnitIds: [],
    sourceEventId: null,
  });
  const r = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'approve_alias',
    target: 'B',
  });
  assert.equal(r.status, 409);
  assert.equal((r.json as { error: string }).error, 'alias_conflict');
});

// ============================================================================
// T4: POST rejected
// ============================================================================

test('M19.rejected：只置 status，taxonomy 不动', async () => {
  resetDb();
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'WontBe',
    sourceUnitIds: [],
    sourceEventId: null,
  });
  const r = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'rejected',
  });
  assert.equal(r.status, 200);
  const after = dbMod.getProjectProposal(created.id);
  assert.equal(after!.status, 'rejected');
  // taxonomy 不应有 WontBe 行
  const tax = dbMod.db
    .prepare(`SELECT 1 AS x FROM org_project_taxonomy WHERE canonical_name='WontBe'`)
    .get();
  assert.equal(tax, undefined);
});

// ============================================================================
// T5: 不存在或已 resolved → 404
// ============================================================================

test('M19.proposal 不存在返回 404', async () => {
  const r = await post(`/projects/proposals/no-such-id/resolve`, {
    action: 'rejected',
  });
  assert.equal(r.status, 404);
});

test('M19.proposal 已 resolved 后再操作返回 404', async () => {
  resetDb();
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'OneShot',
    sourceUnitIds: [],
    sourceEventId: null,
  });
  await post(`/projects/proposals/${created.id}/resolve`, { action: 'rejected' });
  const r = await post(`/projects/proposals/${created.id}/resolve`, { action: 'rejected' });
  assert.equal(r.status, 404);
});

// ============================================================================
// T6: 未知 action → 400
// ============================================================================

test('M19.未知 action 返回 400', async () => {
  resetDb();
  const created = dbMod.upsertProjectCanonicalProposal({
    proposedName: 'WhatEver',
    sourceUnitIds: [],
    sourceEventId: null,
  });
  const r = await post(`/projects/proposals/${created.id}/resolve`, {
    action: 'something_else',
  });
  assert.equal(r.status, 400);
});
