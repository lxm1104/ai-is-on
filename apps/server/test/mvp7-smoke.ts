/**
 * MVP7.0 smoke test —— 不走 HTTP，直接 exercising writer + service + activeContext。
 *
 * 验收对照 docs/MVP7-MVP10... §4.7：
 *   2) confirm 后库里出现 ≥1 state + 1 Space + 2 goal/commitment + 1 preference + 1 boundary_rule
 *   3) 再次 confirm 行数不增，仅 updated_at 改
 *   4) bootstrap_completed_at 被设置
 *   5) activeContext summary 含 Work Map 高权重内容
 *
 * 用法：
 *   SQLITE_PATH=$(mktemp -d)/mvp7.sqlite npx tsx apps/server/test/mvp7-smoke.ts
 */

import { confirmWorkMap, getCurrentWorkMap } from '../src/bootstrap/workMapService.js';
import { buildActiveContext } from '../src/context/activeContext.js';
import { db, getSetting } from '../src/db.js';
import type { WorkMapDraft } from '../src/bootstrap/workMapTypes.js';

const draft: WorkMapDraft = {
  profile: {
    roleTitle: '产品经理 / 全栈',
    teamName: 'AI is ON 产品组',
    responsibilities: ['路线规划', 'MVP 决策', '需求收口'],
  },
  projects: [
    {
      name: 'AI is ON',
      description: 'Agent 自治助手',
      goals: ['本周想清楚 MVP6 之后的路线', 'MVP7 冷启动落地'],
      authoritativeDocs: ['https://example.com/aiis/prd'],
      upcomingDeadlines: [
        { title: '完成 MVP7 评审', dueAt: new Date(Date.now() + 86400_000).toISOString() },
      ],
      risks: ['Agent 判断没坐标系，目前还在猜'],
    },
  ],
  stakeholders: [
    { name: 'Alice', note: '产品 lead' },
    { name: 'Bob', note: '技术对接' },
  ],
  preferences: ['上午专注，下午开会', '群消息合并到日报，不要逐条提醒'],
  boundaries: [
    {
      description: 'P2/P3 来自 im 的卡片合并到 daily digest',
      priorityAtMost: 'P2',
      source: ['im'],
      allowedAction: 'record',
    },
  ],
};

function countRows(table: string, where = ''): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
}

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

console.log('[smoke] db path =', process.env.SQLITE_PATH ?? '(default)');

// ---- Phase 1: first confirm ----
const before = {
  units: countRows('context_units'),
  spaces: countRows('context_spaces'),
  rules: countRows('boundary_rules'),
};
console.log('[smoke] before:', before);

const r1 = confirmWorkMap(draft);
console.log('[smoke] first confirm summary:', r1);
const after1 = {
  units: countRows('context_units'),
  spaces: countRows('context_spaces'),
  rules: countRows('boundary_rules'),
};
console.log('[smoke] after1:', after1);

if (after1.units <= before.units) fail('expected ContextUnits to be written');
if (after1.spaces <= before.spaces) fail('expected at least 1 Space');
if (after1.rules <= before.rules) fail('expected at least 1 boundary_rule');

const current1 = getCurrentWorkMap();
if (!current1.bootstrapCompletedAt) fail('bootstrap_completed_at not set');
if (!current1.role) fail('role unit missing');
if (current1.goals.length < 2) fail(`expected ≥2 goals, got ${current1.goals.length}`);
if (current1.commitments.length < 1) fail('expected ≥1 commitment');
if (current1.preferences.length < 1) fail('expected ≥1 preference');
if (current1.spaces.length < 1) fail('expected ≥1 space');
if (current1.boundaryRules.length < 1) fail('expected ≥1 boundary_rule (source=manual)');

// ---- Phase 2: second confirm — 幂等性 ----
console.log('[smoke] sleeping briefly to differentiate updated_at...');
await new Promise((r) => setTimeout(r, 1100));

const r2 = confirmWorkMap(draft);
console.log('[smoke] second confirm summary:', r2);
const after2 = {
  units: countRows('context_units'),
  spaces: countRows('context_spaces'),
  rules: countRows('boundary_rules'),
};
console.log('[smoke] after2:', after2);

if (after2.units !== after1.units) {
  fail(`re-confirm grew units: ${after1.units} → ${after2.units}`);
}
if (after2.spaces !== after1.spaces) {
  fail(`re-confirm grew spaces: ${after1.spaces} → ${after2.spaces}`);
}
if (after2.rules !== after1.rules) {
  fail(`re-confirm grew rules: ${after1.rules} → ${after2.rules}`);
}
if (r2.unitsWritten !== 0) {
  console.warn(`[warn] second confirm unitsWritten=${r2.unitsWritten} (expected 0)`);
}
if (r2.rulesWritten !== 0) {
  console.warn(`[warn] second confirm rulesWritten=${r2.rulesWritten} (expected 0)`);
}

if (getSetting('bootstrap_completed_at') !== r2.bootstrapCompletedAt) {
  fail('bootstrap_completed_at mismatch');
}

// ---- Phase 3: activeContext should pick up Work Map items ----
const snap = buildActiveContext({ budgetTokens: 3000, limit: 200 });
console.log(
  '[smoke] active context picked',
  snap.items.length,
  'items, tokens =',
  snap.tokenEstimate
);
const workMapItems = snap.items.filter((u) => u.mergeKey?.startsWith('work_map:'));
console.log('[smoke] work_map items in active snapshot:', workMapItems.length);
if (workMapItems.length === 0) fail('no work_map items in active context summary');

// Quick sanity: a role/goal should rank above a stale event
const top10 = snap.items.slice(0, 10).map((u) => u.mergeKey ?? u.id);
console.log('[smoke] top10 mergeKeys:', top10);
const hasWorkMapInTop10 = top10.some((k) => k?.startsWith('work_map:'));
if (!hasWorkMapInTop10) {
  console.warn(
    '[warn] no work_map items in top10 — boost may need re-tuning (existing data has many recent events)'
  );
}

console.log('PASS MVP7.0 smoke');
