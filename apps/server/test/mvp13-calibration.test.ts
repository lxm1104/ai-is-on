/**
 * MVP13 §6.5 / §S7 · admin calibration + ranker-runs cleanup。
 *
 * 验证：
 *   - confirmation/rejection 在窗口内统计正确
 *   - confusion 矩阵聚合
 *   - rejectReasonBreakdown
 *   - ranker-runs cleanup 命中
 *
 * 运行：npx tsx --test apps/server/test/mvp13-calibration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp13-cal-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';
process.env.MVP13_LLM_RANKER_ENABLED = 'false';

const { insertMinimalEventContextUnit } = await import(
  '../src/context/contextStore.js'
);
const {
  tryInsertEvent,
  db,
  getContextSpaceByTypeName,
  listSpaceSuggestions,
  insertContextSpaceRankerRun,
  deleteRankerRunsOlderThan,
} = await import('../src/db.js');
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { runSuggestionWorker } = await import('../src/spaces/suggestionWorker.js');
const {
  confirmChatAffinitySuggestion,
  rejectSuggestion,
} = await import('../src/spaces/contextSpaceService.js');
const { buildCalibrationReport } = await import(
  '../src/spaces/suggestionCalibration.js'
);

function newEvent(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  tryInsertEvent({
    id,
    source: 'im',
    source_id: 'test:' + id,
    kind: 'group_message',
    occurred_at: now,
    title: 't',
    text: 'b',
    actor: null,
    url: null,
    raw_json: '{}',
    content_hash: id,
    processed_at: null,
    created_at: now,
  });
  return id;
}

writeWorkMap({
  profile: { roleTitle: 'TL', responsibilities: [] },
  projects: [
    {
      name: 'Chatbot',
      description: '',
      goals: ['降低 Chatbot badcase 率'],
      authoritativeDocs: [],
      upcomingDeadlines: [],
      risks: [],
    },
  ],
  stakeholders: [],
  preferences: [],
  boundaries: [],
});
for (const c of ['oc_cal_a', 'oc_cal_b', 'oc_cal_c']) {
  for (let i = 0; i < 5; i++) {
    insertMinimalEventContextUnit({
      eventId: newEvent(),
      scope: 'work',
      title: `t${i}`,
      content: 'b',
      occurredAt: new Date().toISOString(),
      source: 'im',
      entities: [
        {
          type: 'chat',
          name: 'lark_chat:' + c,
          role: 'container',
          aliases: ['Chatbot ' + c],
        },
        { type: 'person', name: 'Zeke', role: 'actor' },
      ],
    });
  }
}

test('生成 calibration report：totals + confusion + reject reason', async () => {
  await runSuggestionWorker({ enableLlm: false });
  const space = getContextSpaceByTypeName('project', 'Chatbot')!;
  const items = listSpaceSuggestions(space.id, 'suggested');
  assert.ok(items.length >= 3);
  // confirm 1 个，reject 2 个（不同 reason）
  confirmChatAffinitySuggestion({
    spaceId: space.id,
    suggestionId: items[0].id,
    reasonCode: 'exact_project_chat',
  });
  rejectSuggestion({
    spaceId: space.id,
    suggestionId: items[1].id,
    reasonCode: 'wrong_space',
  });
  rejectSuggestion({
    spaceId: space.id,
    suggestionId: items[2].id,
    reasonCode: 'chat_too_broad',
  });

  // 制造 llm_decision 标签：手工写一些
  db.prepare(
    `UPDATE context_space_suggestions
     SET llm_decision='strong_accept', llm_score=0.9, rule_score=0.4 WHERE id=?`
  ).run(items[0].id);
  db.prepare(
    `UPDATE context_space_suggestions
     SET llm_decision='accept', llm_score=0.8, rule_score=0.5 WHERE id=?`
  ).run(items[1].id);
  db.prepare(
    `UPDATE context_space_suggestions
     SET llm_decision='maybe', llm_score=0.5, rule_score=0.5 WHERE id=?`
  ).run(items[2].id);

  const r = buildCalibrationReport(14);
  assert.ok(r.totals.suggestionsSurfaced >= 3);
  assert.ok(r.totals.confirmed >= 1);
  assert.ok(r.totals.rejected >= 2);
  // confusion：strong_accept → 1 confirmed；accept → 1 rejected；maybe → 1 rejected
  assert.equal(r.confusion.strong_accept.confirmed, 1);
  assert.equal(r.confusion.accept.rejected, 1);
  assert.equal(r.confusion.maybe.rejected, 1);
  // reject breakdown：2 不同 reason
  const codes = r.rejectReasonBreakdown.map((x) => x.reasonCode).sort();
  assert.deepEqual(codes, ['chat_too_broad', 'wrong_space']);
  // correlation：3 个点，应是数字
  assert.equal(typeof r.ruleVsLlm.correlation, 'number');
});

test('DELETE /api/admin/ranker-runs 清理老 run', () => {
  // 直接造 2 条 run，一条很老一条新
  const oldId = randomUUID();
  const newId = randomUUID();
  const oldAt = new Date(Date.now() - 100 * 86400_000).toISOString();
  const newAt = new Date().toISOString();
  insertContextSpaceRankerRun({
    id: oldId,
    worker_run_id: 'w1',
    ranker_version: 'v1',
    prompt_version: 'p1',
    model_id: null,
    status: 'ok',
    candidate_count: 1,
    accepted_count: 1,
    rejected_count: 0,
    input_hash: 'h-old',
    input_summary_json: '{}',
    output_json: '{}',
    reused_from_run_id: null,
    error: null,
    started_at: oldAt,
    completed_at: oldAt,
  });
  insertContextSpaceRankerRun({
    id: newId,
    worker_run_id: 'w2',
    ranker_version: 'v1',
    prompt_version: 'p1',
    model_id: null,
    status: 'ok',
    candidate_count: 1,
    accepted_count: 1,
    rejected_count: 0,
    input_hash: 'h-new',
    input_summary_json: '{}',
    output_json: '{}',
    reused_from_run_id: null,
    error: null,
    started_at: newAt,
    completed_at: newAt,
  });
  const deleted = deleteRankerRunsOlderThan(30);
  assert.ok(deleted >= 1);
  const remaining = db
    .prepare(`SELECT id FROM context_space_ranker_runs WHERE id IN (?, ?)`)
    .all(oldId, newId) as Array<{ id: string }>;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, newId);
});
