/**
 * MVP21 S4 §7.5 — writeWorkMap 不再写 kind=commitment / uncertainty 的 work_map seed。
 *
 * 同时确保仍写 goal / state / relationship / preference + Space.intent_json 的
 * seedGoalTitles / seedConcernTitles 完整保留。
 *
 * 运行：npx tsx --test apps/server/test/mvp21-work-map-writer-s4.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp21-s4-writer-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbMod = await import('../src/db.js');
const { writeWorkMap } = await import('../src/bootstrap/workMapWriter.js');
const { getSpaceIntent } = await import('../src/spaces/contextSpaceService.js');

function countActiveUnitsByMergeKeyLike(pattern: string): number {
  const row = dbMod.db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_units
        WHERE status='active' AND merge_key LIKE ?`
    )
    .get(pattern) as { n: number };
  return row.n;
}

function resetDb() {
  dbMod.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM context_space_links;
    DELETE FROM context_spaces;
  `);
}

// ============================================================================

test('S4: writeWorkMap 不再产生 work_map:commitment:* unit', () => {
  resetDb();
  writeWorkMap({
    profile: { roleTitle: '产品经理', responsibilities: [] },
    projects: [
      {
        name: 'Base UX',
        description: '',
        goals: ['Q3 渗透率 40%'],
        authoritativeDocs: [],
        upcomingDeadlines: [
          { title: 'Image 文案修改 2 条', dueAt: '2026-05-28T23:59:00Z' },
        ],
        risks: [],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });

  assert.equal(
    countActiveUnitsByMergeKeyLike('work_map:commitment:%'),
    0,
    'S4 后不应该产生 work_map:commitment:* unit'
  );
});

test('S4: writeWorkMap 不再产生 work_map:risk:* unit', () => {
  resetDb();
  writeWorkMap({
    profile: { roleTitle: 'PM', responsibilities: [] },
    projects: [
      {
        name: 'Base UX',
        description: '',
        goals: ['完成 v2 上线'],
        authoritativeDocs: [],
        upcomingDeadlines: [],
        risks: ['Bandwidth 紧张', '依赖方未确认'],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });

  assert.equal(
    countActiveUnitsByMergeKeyLike('work_map:risk:%'),
    0,
    'S4 后不应该产生 work_map:risk:* unit'
  );
});

test('S4: writeWorkMap 仍然写 work_map:goal:* unit（保留）', () => {
  resetDb();
  writeWorkMap({
    profile: { roleTitle: 'PM', responsibilities: [] },
    projects: [
      {
        name: 'Chatbot',
        description: '',
        goals: ['降低 badcase 率', '完成 v2 上线'],
        authoritativeDocs: [],
        upcomingDeadlines: [],
        risks: [],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });

  assert.equal(
    countActiveUnitsByMergeKeyLike('work_map:goal:%'),
    2,
    'goal 写入路径保留'
  );
});

test('S4: writeWorkMap 仍然写 state / relationship / preference（身份层保留）', () => {
  resetDb();
  writeWorkMap({
    profile: {
      roleTitle: '产品经理',
      teamName: 'AI is ON',
      responsibilities: ['负责 MVP 路线规划', '主导 Chatbot 产研协同'],
    },
    projects: [],
    stakeholders: [{ name: '张三', note: 'TL' }, { name: '李四' }],
    preferences: ['上午专注，下午开会', '周末不接 IM'],
    boundaries: [],
  });

  // role + responsibilities 都是 kind=state
  assert.equal(
    countActiveUnitsByMergeKeyLike('work_map:role:%'),
    1,
    'role unit 保留'
  );
  assert.equal(
    countActiveUnitsByMergeKeyLike('work_map:responsibility:%'),
    2,
    'responsibility unit 保留'
  );
  assert.equal(
    countActiveUnitsByMergeKeyLike('work_map:relationship:%'),
    2,
    'relationship unit 保留'
  );
  assert.equal(
    countActiveUnitsByMergeKeyLike('work_map:preference:%'),
    2,
    'preference unit 保留'
  );
});

test('S4: Space.intent_json.seedConcernTitles 仍保留（risks 字段进 intent 种子，不进 ContextUnit）', () => {
  resetDb();
  writeWorkMap({
    profile: { roleTitle: 'PM', responsibilities: [] },
    projects: [
      {
        name: 'proj-X',
        description: '',
        goals: ['G1'],
        authoritativeDocs: [],
        upcomingDeadlines: [{ title: 'DL-1' }],
        risks: ['R1', 'R2'],
      },
    ],
    stakeholders: [],
    preferences: [],
    boundaries: [],
  });

  // 找到对应 Space
  const space = dbMod.db
    .prepare(`SELECT id FROM context_spaces WHERE type='project' AND name=?`)
    .get('proj-X') as { id: string } | undefined;
  assert.ok(space);
  const intent = getSpaceIntent(space!.id);
  assert.ok(intent);
  // risks 进 seedConcernTitles（PR2 已重命名），不进 ContextUnit
  assert.deepEqual(intent!.seedConcernTitles, ['R1', 'R2']);
  // commitment seeds → seedGoalTitles 已经被 goals 占用；deadlines 不进 intent
  // （只 goals 进 seedGoalTitles，这是 PR2 既定行为）
  assert.deepEqual(intent!.seedGoalTitles, ['G1']);
});

test('S4: 整体 unit count — 不再产生 commitment/uncertainty 行', () => {
  resetDb();
  writeWorkMap({
    profile: { roleTitle: 'PM', responsibilities: ['资任1'] },
    projects: [
      {
        name: 'P',
        description: '',
        goals: ['G1', 'G2'],
        authoritativeDocs: [],
        upcomingDeadlines: [{ title: 'D1' }, { title: 'D2' }],
        risks: ['R1', 'R2', 'R3'],
      },
    ],
    stakeholders: [{ name: 'A' }],
    preferences: ['P1'],
    boundaries: [],
  });

  const commitments = dbMod.db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_units
        WHERE status='active' AND kind='commitment' AND merge_key LIKE 'work_map:%'`
    )
    .get() as { n: number };
  const uncerts = dbMod.db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_units
        WHERE status='active' AND kind='uncertainty' AND merge_key LIKE 'work_map:%'`
    )
    .get() as { n: number };
  assert.equal(commitments.n, 0);
  assert.equal(uncerts.n, 0);
});
