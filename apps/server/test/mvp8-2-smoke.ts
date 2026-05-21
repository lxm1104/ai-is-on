/**
 * MVP8.2 smoke (doc §9 验收点: 所有 internal agent run 都带 sliceVersion 摘要)。
 *
 * - daily_digest 跑通：agent_run_id 必填、input_json 含 packetSliceVersion + materializedSlices
 * - caring：跳过 LLM 路径（runOneShot 会失败也无妨），只验 run row 装配阶段写入了 sliceVersion
 *   通过直接走 AgentRunQueue → enqueueAgentRunForTrigger 触发。
 *
 * 用法：SQLITE_PATH=$(mktemp -d)/mvp8-2.sqlite npx tsx apps/server/test/mvp8-2-smoke.ts
 */
import { bootstrapAgents } from '../src/agents/index.js';
import { enqueueAgentRunForTrigger } from '../src/agents/AgentRunQueue.js';
import { persistTrigger } from '../src/triggers/triggerEvaluator.js';
import { db, insertCard } from '../src/db.js';
import { randomUUID } from 'node:crypto';

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

bootstrapAgents();

// ---- Phase 1: daily_digest ----
console.log('== Phase 1: daily_digest ==');
// 灌 3 张 P3 batched card 让 digest 有东西聚合
const now = new Date().toISOString();
for (let i = 0; i < 3; i++) {
  insertCard({
    id: randomUUID(),
    triage_id: null,
    priority: 'P3',
    source: 'im',
    title: `测试卡 ${i}`,
    summary: 'noise',
    reason: 'mvp8-2 smoke',
    suggested_action: null,
    draft_reply: null,
    status: 'batched',
    actions_json: '[]',
    raw_event_id: null,
    source_url: null,
    source_kind: 'triage',
    source_ref_id: null,
    created_at: now,
    updated_at: now,
  });
}

const digestTriggerId = persistTrigger({
  triggerType: 'daily_digest_due',
  contextUnitId: 'system',
  dueAt: now,
  dueAtBucket: now.slice(0, 10),
  reasoning: 'mvp8-2 smoke daily_digest',
  payload: { hourLocal: 19 },
});
if (!digestTriggerId) fail('daily_digest trigger not persisted');
enqueueAgentRunForTrigger(digestTriggerId);
await new Promise((r) => setTimeout(r, 200));

const digestRun = db
  .prepare(`SELECT * FROM agent_runs WHERE agent_type='daily_digest' ORDER BY created_at DESC LIMIT 1`)
  .get() as { id: string; status: string; input_json: string } | undefined;
if (!digestRun) fail('no daily_digest run');
console.log('[smoke] digest run status=', digestRun.status);
if (digestRun.status !== 'done') fail('digest run not done');

const din = JSON.parse(digestRun.input_json);
console.log('[smoke] digest input.packetSliceVersion=', din.packetSliceVersion);
if (din.packetSliceVersion !== 1) fail('digest: packetSliceVersion expected 1');
if (!Array.isArray(din.materializedSlices)) fail('digest: materializedSlices missing');
if (!din.materializedSlices.find((s: { name: string }) => s.name === 'boundary')) {
  fail('digest: boundary slice missing');
}
const digestProp = db
  .prepare(`SELECT agent_run_id FROM action_proposals WHERE agent_run_id = ?`)
  .get(digestRun.id) as { agent_run_id: string } | undefined;
if (!digestProp) fail('digest proposal missing or agent_run_id not filled');
console.log('[smoke] digest proposal.agent_run_id linked OK');

// ---- Phase 2: caring（不跑 LLM，只验装配；用一个 paused-then-resume trick） ----
console.log('\n== Phase 2: caring (input_json sliceVersion) ==');
// 灌一条 personal context 让 caring 不会因为 "no personal context" 早返
import('../src/context/contextStore.js').then(async ({ upsertContextUnit }) => {
  upsertContextUnit({
    kind: 'state',
    title: '我有点累',
    content: '本周连续开会，状态一般',
    entities: [],
    scope: 'personal',
    origin: { kind: 'manual', refId: 'mvp8-2-personal' },
    actionability: 'record',
    confidence: 0.7,
    mergeHint: 'mvp8-2-personal-state',
  });

  const caringTriggerId = persistTrigger({
    triggerType: 'check_in_due',
    contextUnitId: 'system',
    dueAt: now,
    dueAtBucket: now.slice(0, 10) + '-caring',
    reasoning: 'mvp8-2 smoke caring',
    payload: { personalUnitCount: 1, hourLocal: 13 },
  });
  if (!caringTriggerId) fail('caring trigger not persisted');
  enqueueAgentRunForTrigger(caringTriggerId);
  // caring 会真的调 LLM，长一点等
  await new Promise((r) => setTimeout(r, 500));

  const caringRun = db
    .prepare(`SELECT * FROM agent_runs WHERE agent_type='caring' ORDER BY created_at DESC LIMIT 1`)
    .get() as { id: string; status: string; input_json: string } | undefined;
  if (!caringRun) fail('no caring run');
  console.log('[smoke] caring run status=', caringRun.status, '(LLM may fail; input_json still must contain sliceVersion)');
  const cin = JSON.parse(caringRun.input_json);
  console.log('[smoke] caring input.packetSliceVersion=', cin.packetSliceVersion);
  if (cin.packetSliceVersion !== 1) fail('caring: packetSliceVersion expected 1');
  if (!Array.isArray(cin.materializedSlices)) fail('caring: materializedSlices missing');
  // caring slices=['boundary']
  if (!cin.materializedSlices.find((s: { name: string }) => s.name === 'boundary')) {
    fail('caring: boundary slice missing');
  }
  console.log('\nPASS MVP8.2 smoke');
});
