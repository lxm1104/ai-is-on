/**
 * MVP13 §3 · DDL 迁移与 helpers 烟囱测试。
 *
 * 验收：
 *   - context_spaces 新增列存在并有默认值
 *   - context_space_suggestions 新增列存在
 *   - context_space_ranker_runs / context_space_suggestion_feedback 表存在
 *   - insertContextSpaceRankerRun / update / findRecentByInputHash 闭环
 *   - insertContextSpaceSuggestionFeedback + listSuggestionFeedbackExamples 闭环
 *
 * 运行：npx tsx --test apps/server/test/mvp13-db-schema.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-db-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const {
  db,
  insertContextSpace,
  getContextSpace,
  insertContextSpaceRankerRun,
  updateContextSpaceRankerRun,
  findRecentRankerRunByInputHash,
  deleteRankerRunsOlderThan,
  insertContextSpaceSuggestionFeedback,
  listSuggestionFeedbackExamples,
  listSuggestionFeedbackForCalibration,
} = await import('../src/db.js');

test('context_spaces 新增列存在且默认值正确', () => {
  const cols = db
    .prepare(`PRAGMA table_info(context_spaces)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  assert.ok(names.has('intent_json'));
  assert.ok(names.has('work_map_ref_json'));
  assert.ok(names.has('suggestion_policy'));

  const now = new Date().toISOString();
  insertContextSpace({
    id: 'sp_test_1',
    type: 'project',
    name: 'Test One',
    description: null,
    owner_subject_id: 'me',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  const row = getContextSpace('sp_test_1')!;
  assert.equal(row.intent_json, '{}');
  assert.equal(row.work_map_ref_json, null);
  assert.equal(row.suggestion_policy, 'manual_confirm');
});

test('context_space_suggestions 新增列存在', () => {
  const cols = db
    .prepare(`PRAGMA table_info(context_space_suggestions)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  for (const n of [
    'rule_score',
    'llm_score',
    'final_score',
    'llm_decision',
    'llm_confidence',
    'ranker_status',
    'ranker_version',
    'model_id',
    'decided_at',
    'decided_by',
  ]) {
    assert.ok(names.has(n), `missing column ${n}`);
  }
});

test('ranker run insert/update/cache/cleanup 闭环', () => {
  const now = new Date().toISOString();
  const id = randomUUID();
  insertContextSpaceRankerRun({
    id,
    worker_run_id: 'wr_1',
    ranker_version: 'mvp13.chat_affinity.v1',
    prompt_version: 'p1',
    model_id: null,
    status: 'running',
    candidate_count: 0,
    accepted_count: 0,
    rejected_count: 0,
    input_hash: 'hash-abc',
    input_summary_json: '{}',
    output_json: null,
    reused_from_run_id: null,
    error: null,
    started_at: now,
    completed_at: null,
  });

  updateContextSpaceRankerRun(id, {
    status: 'ok',
    candidate_count: 3,
    accepted_count: 2,
    rejected_count: 1,
    output_json: '{"results":[]}',
    completed_at: new Date().toISOString(),
    model_id: 'claude-opus',
  });

  const found = findRecentRankerRunByInputHash('hash-abc', 24);
  assert.ok(found);
  assert.equal(found!.status, 'ok');
  assert.equal(found!.accepted_count, 2);
  assert.equal(found!.model_id, 'claude-opus');

  // TTL 过期不命中（用负 ttlHours 让 cutoff 落在未来 1 小时）
  const expired = findRecentRankerRunByInputHash('hash-abc', -1);
  assert.equal(expired, null);

  // cleanup
  const n = deleteRankerRunsOlderThan(-1); // everything in future is older
  assert.ok(n >= 1);
  assert.equal(findRecentRankerRunByInputHash('hash-abc', 24), null);
});

test('feedback insert + examples 闭环', () => {
  const now = new Date().toISOString();
  // 一条 confirmed for space S1
  insertContextSpaceSuggestionFeedback({
    id: randomUUID(),
    suggestion_id: 'sg1',
    space_id: 'S1',
    target_type: 'entity',
    target_id: 'chat_a',
    suggestion_type: 'chat_affinity',
    action: 'confirmed',
    reason_code: 'exact_project_chat',
    comment: null,
    cooldown_until: null,
    snapshot_json: '{"score":0.8}',
    created_at: now,
  });
  // 一条 rejected for space S1
  insertContextSpaceSuggestionFeedback({
    id: randomUUID(),
    suggestion_id: 'sg2',
    space_id: 'S1',
    target_type: 'entity',
    target_id: 'chat_b',
    suggestion_type: 'chat_affinity',
    action: 'rejected',
    reason_code: 'chat_too_broad',
    comment: null,
    cooldown_until: new Date(Date.now() + 30 * 86400_000).toISOString(),
    snapshot_json: '{"score":0.2}',
    created_at: now,
  });

  const ex = listSuggestionFeedbackExamples({
    spaceId: 'S1',
    windowDays: 30,
    perAction: 5,
  });
  assert.equal(ex.length, 2);

  const cal = listSuggestionFeedbackForCalibration(30);
  assert.ok(cal.length >= 2);

  // 全局 fallback
  const exGlobal = listSuggestionFeedbackExamples({
    windowDays: 30,
    perAction: 5,
  });
  assert.ok(exGlobal.length >= 2);
});
