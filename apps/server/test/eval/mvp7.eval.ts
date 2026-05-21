/**
 * MVP7 eval runner (§4.7 + §8).
 *
 * 跑两个 case：
 *   1) idempotency —— 同样的 manual draft 跑 confirm × 2，行数不增
 *   2) LLM draft (MVP7.1) —— 真调 runOneShot，验 token ≤ 8k & JSON 结构覆盖
 *
 * 用法：
 *   SQLITE_PATH=$(mktemp -d)/mvp7.sqlite npx tsx apps/server/test/eval/mvp7.eval.ts
 *
 * 复现性约定（doc §8.2）：
 *   - judgeModel: 不写死，运行时由 runOneShot 返回的 raw json 里的 model 字段回填到 fixture header
 *   - seed: runOneShot 不支持 seed → 永远 null
 *   - evalVersion: 改 prompt / 阈值 / sanitize 任一项必须 bump
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  confirmWorkMap,
  generateWorkMapDraft,
} from '../../src/bootstrap/workMapService.js';
import { upsertContextUnit } from '../../src/context/contextStore.js';
import { db } from '../../src/db.js';
import type { WorkMapDraft } from '../../src/bootstrap/workMapTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.resolve(__dirname, '../fixtures/mvp7');

type ExpectedSpec = {
  _meta: { evalVersion: number; judgeModel: string | null; seed: null };
  tokenEstimateAtMost: number;
  expect: Record<string, unknown>;
};

type RawFixture = {
  seedText: string;
  units: Array<{
    kind: string;
    title: string;
    content: string;
    entities?: Array<{ type: string; name: string; role?: string }>;
    time?: Record<string, string>;
    actionability?: string;
    confidence?: number;
  }>;
};

const raw = JSON.parse(
  readFileSync(path.join(FIX_DIR, 'work_map_raw_context.json'), 'utf-8')
) as RawFixture;
const expected = JSON.parse(
  readFileSync(path.join(FIX_DIR, 'expected_work_map.json'), 'utf-8')
) as ExpectedSpec;

const expPath = path.join(FIX_DIR, 'expected_work_map.json');

let failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) console.log('  ✔', msg);
  else {
    console.log('  ✘', msg);
    failures.push(msg);
  }
}

console.log('[eval mvp7] db =', process.env.SQLITE_PATH ?? '(default)');
console.log('[eval mvp7] evalVersion =', expected._meta.evalVersion);

// ---------- Case 1: idempotency ----------
console.log('\n== Case 1: manual confirm idempotency ==');
const manualDraft: WorkMapDraft = {
  profile: {
    roleTitle: '产品经理',
    teamName: 'AI is ON',
    responsibilities: ['路线规划'],
  },
  projects: [
    {
      name: 'AI is ON',
      goals: ['本周想清楚 MVP6 之后的路线'],
      authoritativeDocs: ['https://example.com/aiis/prd'],
      upcomingDeadlines: [],
      risks: ['Agent 缺乏判断坐标系'],
    },
  ],
  stakeholders: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
  preferences: ['群消息合并到日报'],
  boundaries: [
    {
      description: 'P2/P3 im 消息合并到 daily digest',
      priorityAtMost: 'P2',
      source: ['im'],
      allowedAction: 'record',
    },
  ],
};

const countRows = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const sum1 = confirmWorkMap(manualDraft);
const after1 = {
  units: countRows('context_units'),
  spaces: countRows('context_spaces'),
  rules: countRows('boundary_rules'),
};
console.log('first confirm:', sum1, after1);
check(sum1.unitsWritten > 0, 'first confirm writes units');
check(sum1.spacesWritten > 0, 'first confirm writes ≥1 space');
check(sum1.rulesWritten > 0, 'first confirm writes ≥1 rule');

// sleep so updatedAt differs
await new Promise((r) => setTimeout(r, 1100));
const sum2 = confirmWorkMap(manualDraft);
const after2 = {
  units: countRows('context_units'),
  spaces: countRows('context_spaces'),
  rules: countRows('boundary_rules'),
};
console.log('second confirm:', sum2, after2);
check(after2.units === after1.units, 'units count unchanged on re-confirm');
check(after2.spaces === after1.spaces, 'spaces count unchanged on re-confirm');
check(after2.rules === after1.rules, 'rules count unchanged on re-confirm');
check(sum2.unitsWritten === 0, 'second confirm writes 0 new units');
check(sum2.rulesWritten === 0, 'second confirm writes 0 new rules');

// ---------- Case 2: LLM draft on seeded raw context ----------
console.log('\n== Case 2: LLM draft structural coverage ==');
// 把 raw_context fixture 里的 units 灌入 db（与 Work Map 写入区分开 —— 这些是 simulated 近期 context）
for (const u of raw.units) {
  upsertContextUnit({
    kind: u.kind as never,
    title: u.title,
    content: u.content,
    entities: u.entities ?? [],
    scope: 'work',
    origin: { kind: 'manual', refId: `eval-${u.title.slice(0, 20)}` },
    time: u.time as never,
    actionability: (u.actionability as never) ?? 'record',
    confidence: u.confidence ?? 0.7,
  });
}

let draftRes;
let judgeModel: string | null = null;
try {
  draftRes = await generateWorkMapDraft({
    seedText: raw.seedText,
    mode: 'full',
  });
  judgeModel = draftRes.modelId;
} catch (err) {
  console.error('  ✘ LLM call failed:', err instanceof Error ? err.message : String(err));
  failures.push('LLM call failed');
  process.exit(1);
}

console.log('tokenEstimate=', draftRes.tokenEstimate, 'considered=', draftRes.itemsConsidered, 'truncated=', draftRes.itemsTruncated);

check(draftRes.tokenEstimate <= expected.tokenEstimateAtMost, `tokenEstimate ≤ ${expected.tokenEstimateAtMost}`);

const d = draftRes.draft;
check(typeof d === 'object' && d !== null, 'draft is a JSON object');
check(!!d.profile?.roleTitle && d.profile.roleTitle.trim().length > 0, 'profile.roleTitle non-empty');
check(d.profile.responsibilities.length >= 1, 'profile.responsibilities ≥ 1');
check(d.projects.length >= 1, 'projects ≥ 1');
const projectNames = d.projects.map((p) => p.name);
check(projectNames.some((n) => n.includes('AI is ON')), 'projects contains "AI is ON"');
check(d.projects.every((p) => p.goals.length >= 0), 'projects[*].goals is array');
check(
  d.projects.some((p) => p.goals.length >= 1),
  'at least one project has ≥1 goal'
);
const stakeNames = d.stakeholders.map((s) => s.name);
for (const want of ['Alice', 'Bob', 'Carol']) {
  check(stakeNames.includes(want), `stakeholders contains ${want}`);
}
check(d.preferences.length >= 1, 'preferences ≥ 1');
check(d.boundaries.length >= 1, 'boundaries ≥ 1');
check(
  d.boundaries.some((b) => b.triggerType || b.priorityAtMost || (b.source && b.source.length)),
  'at least one boundary has structured field'
);

// ---------- 回填 judgeModel ----------
expected._meta.judgeModel = judgeModel;
writeFileSync(expPath, JSON.stringify(expected, null, 2) + '\n', 'utf-8');
console.log('\n[eval] wrote judgeModel back to fixture:', judgeModel ?? '(unknown)');

console.log('\n--- Summary ---');
console.log(failures.length === 0 ? 'PASS MVP7 eval' : `FAIL ${failures.length} check(s)`);
if (failures.length > 0) {
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
