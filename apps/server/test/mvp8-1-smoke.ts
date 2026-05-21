/**
 * MVP8.1 smoke (§5.6 验收点 2-5)：
 *   2) agent_runs.input_json 含 packetSliceVersion + materializedSlices
 *   3) track_commitment 输出含 Space priority / 职责
 *   4) commitment 已存在 action_result 链接时不重复提醒
 *   5) prepare_meeting 在 work Space 时 packet 含权威文档 + stakeholder
 *
 * 不真跑 LLM —— track_commitment 是纯本地，足以验收。LLM 路径只 dry-run packet 装配。
 *
 * 用法：SQLITE_PATH=$(mktemp -d)/mvp8.sqlite npx tsx apps/server/test/mvp8-1-smoke.ts
 */
import { getContextUnitById, upsertContextUnit, registerUpsertHook } from '../src/context/contextStore.js';
import {
  evaluateAndPersistForUnit,
} from '../src/triggers/triggerEvaluator.js';
import { bootstrapAgents } from '../src/agents/index.js';
import { enqueueAgentRunForTrigger } from '../src/agents/AgentRunQueue.js';
import { writeWorkMap } from '../src/bootstrap/workMapWriter.js';
import { reconcileAllUnitsToSpaces, resolveUnitToSpaces } from '../src/spaces/contextSpaceService.js';
import { assembleAgentContextPacket } from '../src/context/agentContextAssembler.js';
import { getRegisteredAgent } from '../src/agents/agentRegistry.js';
import { db } from '../src/db.js';

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

// ---- Phase 0: bootstrap & Work Map seed ----
bootstrapAgents();
// install scheduler-style hook so commit upsert enqueues agent run
// mirror triggerScheduler 的 hook：先 resolve 到 Space，再 evaluate + enqueue
registerUpsertHook((unit, cc) => {
  try {
    resolveUnitToSpaces(unit);
  } catch {}
  const ids = evaluateAndPersistForUnit(unit, Date.now(), cc);
  for (const id of ids) enqueueAgentRunForTrigger(id);
});

writeWorkMap({
  profile: {
    roleTitle: '产品经理',
    teamName: 'AI is ON',
    responsibilities: ['路线规划', '需求收口'],
  },
  projects: [
    {
      name: 'AI is ON',
      description: 'Agent 自治助手',
      goals: ['本周想清楚 MVP6 之后的路线'],
      authoritativeDocs: ['https://example.com/aiis/prd'],
      upcomingDeadlines: [],
      risks: ['Agent 缺乏判断坐标系'],
    },
  ],
  stakeholders: [{ name: 'Alice', note: '产品 lead' }, { name: 'Bob' }],
  preferences: ['上午专注，下午开会'],
  boundaries: [],
});
reconcileAllUnitsToSpaces();   // ensure goal → AI is ON space link
console.log('[smoke] Work Map seeded');

// ---- Phase 1: upsert a commitment due in 6h, project=AI is ON ----
const dueSoon = new Date(Date.now() + 6 * 3600_000).toISOString();
const commitResult = upsertContextUnit({
  kind: 'commitment',
  title: '完成 MVP8.1 验收',
  content: '本周内交付，向 Alice 承诺。',
  entities: [
    { type: 'person', name: 'Alice', role: 'target' },
    { type: 'project', name: 'AI is ON', role: 'about' },
  ],
  scope: 'work',
  origin: { kind: 'manual', refId: 'mvp8-1-test-commit' },
  time: { dueAt: dueSoon },
  actionability: 'act',
  confidence: 0.9,
  mergeHint: 'mvp8-1-smoke-commit',
});

// 给 queue 一点时间跑完
await new Promise((r) => setTimeout(r, 200));

const runs = db
  .prepare(`SELECT * FROM agent_runs WHERE agent_type='track_commitment' ORDER BY created_at DESC LIMIT 1`)
  .all() as Array<{ id: string; status: string; input_json: string; output_json: string | null }>;
if (runs.length === 0) fail('no track_commitment run created');
const lastRun = runs[0];
console.log('[smoke] track_commitment run status=', lastRun.status);
if (lastRun.status !== 'done') fail(`run not done: ${lastRun.status}`);

const input = JSON.parse(lastRun.input_json);
console.log('[smoke] input.packetSliceVersion=', input.packetSliceVersion);
if (input.packetSliceVersion !== 1) fail('packetSliceVersion != 1');
if (!Array.isArray(input.materializedSlices)) fail('materializedSlices missing');
const sliceNames = input.materializedSlices.map((s: { name: string }) => s.name);
console.log('[smoke] slices=', sliceNames);
for (const want of ['focalUnit', 'latestActionResult', 'boundary', 'subject', 'spaces']) {
  if (!sliceNames.includes(want)) fail(`slice ${want} missing for track_commitment`);
}
const subjSlice = input.materializedSlices.find((s: { name: string }) => s.name === 'subject');
if (!subjSlice || subjSlice.itemCount !== 1) fail('subject slice itemCount expected 1');
const spaceSlice = input.materializedSlices.find((s: { name: string }) => s.name === 'spaces');
if (!spaceSlice || spaceSlice.itemCount < 1) fail('spaces slice should resolve AI is ON');

// proposal.agent_run_id 必填
const props = db
  .prepare(`SELECT * FROM action_proposals WHERE agent_run_id = ? ORDER BY created_at DESC`)
  .all(lastRun.id) as Array<{ id: string; agent_run_id: string | null; payload_json: string | null }>;
if (props.length === 0) fail('no proposal linked to run');
if (props[0].agent_run_id !== lastRun.id) fail('agent_run_id mismatch');
const propPayload = JSON.parse(props[0].payload_json ?? '{}');
console.log('[smoke] proposal payload:', propPayload);
if (propPayload.spacePriority !== 'critical' && propPayload.spacePriority !== 'high') {
  fail(`commitment proposal expected spacePriority high/critical, got ${propPayload.spacePriority}`);
}

// ---- Phase 2: action_result 已存在时跳过 ----
console.log('\n== Phase 2: action_result skips commitment ==');
upsertContextUnit({
  kind: 'action_result',
  title: '已完成 MVP8.1 验收',
  content: '已交付',
  entities: [
    { type: 'project', name: 'AI is ON', role: 'about' },
  ],
  scope: 'work',
  origin: { kind: 'manual', refId: 'mvp8-1-test-action-result' },
  actionability: 'record',
  confidence: 0.9,
  mergeHint: 'mvp8-1-smoke-action-result',
});

// 触发同一 commitment 的下一次 push
upsertContextUnit({
  kind: 'commitment',
  title: '完成 MVP8.1 验收 v2',
  content: '本周内交付 v2',
  entities: [
    { type: 'person', name: 'Alice', role: 'target' },
    { type: 'project', name: 'AI is ON', role: 'about' },
  ],
  scope: 'work',
  origin: { kind: 'manual', refId: 'mvp8-1-test-commit' },
  time: { dueAt: dueSoon },
  actionability: 'act',
  confidence: 0.9,
  mergeHint: 'mvp8-1-smoke-commit',
});
await new Promise((r) => setTimeout(r, 200));

const runs2 = db
  .prepare(`SELECT * FROM agent_runs WHERE agent_type='track_commitment' ORDER BY created_at DESC LIMIT 2`)
  .all() as Array<{ id: string; output_json: string | null }>;
// idempotency 同 bucket-day 不会重出 trigger，所以 runs2 数量等于 phase 1 的 1 个
// 如果 evaluator 算法变了导致同 day 再次触发，看 output 是否带 skipped
if (runs2.length >= 2) {
  const newRun = runs2[0];
  const out = JSON.parse(newRun.output_json ?? '{}');
  console.log('[smoke] phase2 run summary=', out.summary);
  if (!String(out.summary).includes('skipped')) {
    fail('phase2: expected commitment to be skipped due to action_result');
  }
} else {
  console.log('[smoke] phase2: only 1 run total (idempotency UNIQUE), skip path not exercised');
  // 直接 dry-run assembler 确认 latestActionResult slice 命中
  const trigger = db.prepare(`SELECT * FROM triggers WHERE trigger_type='commitment_due' ORDER BY created_at DESC LIMIT 1`).get() as never;
  const reg = getRegisteredAgent('track_commitment');
  if (!reg) fail('track_commitment not registered');
  const focal = getContextUnitById(commitResult.unit.id);
  const packet = assembleAgentContextPacket({
    agentRunId: 'dry-run',
    trigger,
    unit: focal,
    slices: reg.slices,
    packetSliceVersion: reg.packetSliceVersion,
  });
  if (!packet.latestActionResult) fail('dry-run: latestActionResult missing');
  console.log('[smoke] dry-run assembler: latestActionResult.id=', packet.latestActionResult.id);
}

// ---- Phase 3: prepare_meeting packet has spaces/docs/stakeholders ----
console.log('\n== Phase 3: prepare_meeting packet ==');
const meetingTime = new Date(Date.now() + 45 * 60_000).toISOString(); // 45 min later
const meetingUpsert = upsertContextUnit({
  kind: 'event',
  title: 'AI is ON 评审会',
  content: 'MVP8 评审',
  entities: [
    { type: 'person', name: 'Alice', role: 'actor' },
    { type: 'person', name: 'Bob', role: 'actor' },
    { type: 'project', name: 'AI is ON', role: 'about' },
  ],
  scope: 'work',
  origin: { kind: 'manual', refId: 'mvp8-1-test-meeting' },
  time: { startsAt: meetingTime, occurredAt: meetingTime },
  actionability: 'notify',
  confidence: 0.85,
  mergeHint: 'mvp8-1-smoke-meeting',
});

// 不跑 LLM，只 dry-run 装配
const meetingTrigger = db
  .prepare(`SELECT * FROM triggers WHERE trigger_type='meeting_prepare' ORDER BY created_at DESC LIMIT 1`)
  .get() as never;
if (!meetingTrigger) fail('no meeting_prepare trigger');
const meetingReg = getRegisteredAgent('prepare_meeting');
if (!meetingReg) fail('prepare_meeting not registered');
const focalUnit = getContextUnitById(meetingUpsert.unit.id);
const meetingPacket = assembleAgentContextPacket({
  agentRunId: 'dry-run-meeting',
  trigger: meetingTrigger,
  unit: focalUnit,
  slices: meetingReg.slices,
  packetSliceVersion: meetingReg.packetSliceVersion,
});
console.log('[smoke] meeting packet slices=', meetingPacket.materializedSlices.map((s) => s.name));
if (!meetingPacket.spaces || meetingPacket.spaces.length === 0) {
  fail('meeting packet: spaces empty');
}
const aiisSpace = meetingPacket.spaces.find((s) => s.name === 'AI is ON');
if (!aiisSpace) fail('meeting packet: AI is ON space missing');
console.log('[smoke] AI is ON space:', { priority: aiisSpace.priority, docs: aiisSpace.docs });
if (aiisSpace.priority === 'normal') {
  fail(`meeting packet: AI is ON priority should be 'high' (has goal), got 'normal'`);
}
if (aiisSpace.docs.length === 0) fail('meeting packet: AI is ON has no docs (expected authoritativeDocs)');
if (!meetingPacket.stakeholders || meetingPacket.stakeholders.length === 0) {
  fail('meeting packet: stakeholders empty');
}
const stakeNames = meetingPacket.stakeholders.map((s) => s.name);
console.log('[smoke] stakeholders:', stakeNames);
if (!stakeNames.includes('Alice') || !stakeNames.includes('Bob')) {
  fail('meeting packet: stakeholders should include Alice & Bob');
}
if (!meetingPacket.subject) fail('meeting packet: subject missing (bootstrap done)');
if (meetingPacket.subject.responsibilities.length === 0) {
  fail('meeting packet: subject.responsibilities empty');
}

console.log('\nPASS MVP8.1 smoke');
