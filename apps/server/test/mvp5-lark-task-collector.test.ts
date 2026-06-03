/**
 * MVP5 飞书任务 collector 测试。
 * 运行：npx tsx --test apps/server/test/mvp5-lark-task-collector.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp5-task-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const db = await import('../src/db.js');
const { runLarkTaskSync, normalizeLarkTime } = await import(
  '../src/collectors/larkTaskCollector.js'
);
const { upsertContextUnit } = await import('../src/context/contextStore.js');
const { assembleGlobalContextPacket } = await import(
  '../src/context/agentContextAssembler.js'
);

type Item = {
  guid?: string;
  summary?: string;
  url?: string;
  created_at?: string;
  due_at?: string;
};

function resetDb() {
  db.db.exec(`
    DELETE FROM context_units;
    DELETE FROM context_unit_entities;
    DELETE FROM context_entities;
    DELETE FROM entity_aliases;
  `);
}

function mockCli(opts: { my?: Item[]; related?: Item[]; failMy?: boolean; failRelated?: boolean }) {
  return async <T = unknown>(args: string[]): Promise<T> => {
    if (args.includes('+get-my-tasks')) {
      if (opts.failMy) return { ok: false } as T;
      return { ok: true, data: { items: opts.my ?? [] } } as T;
    }
    if (args.includes('+get-related-tasks')) {
      if (opts.failRelated) return { ok: false } as T;
      return { ok: true, data: { items: opts.related ?? [] } } as T;
    }
    throw new Error('unexpected cli args: ' + args.join(' '));
  };
}

function activeTaskCommitments() {
  return db.listActiveLarkTaskCommitmentRows();
}

// ============================================================================

test('归一：无时区串按 +08:00，带时区 ISO 原样解析', () => {
  // 2026-06-03 08:00:00 +08:00 == 2026-06-03T00:00:00Z
  assert.equal(normalizeLarkTime('2026-06-03 08:00:00'), '2026-06-03T00:00:00.000Z');
  assert.equal(
    normalizeLarkTime('2026-06-03T08:00:00+08:00'),
    '2026-06-03T00:00:00.000Z'
  );
  assert.equal(normalizeLarkTime(''), undefined);
  assert.equal(normalizeLarkTime(undefined), undefined);
});

test('任务落成 commitment，进 tasks slice 而非 commitments 桶', async () => {
  resetDb();
  await runLarkTaskSync({
    runLarkCliJson: mockCli({
      my: [{ guid: 'g1', summary: '找客户', url: 'https://x/g1' }],
      related: [],
    }),
  });

  const packet = assembleGlobalContextPacket({ now: Date.now() });
  assert.equal(packet.tasks.length, 1, '1 条进 tasks');
  assert.equal(packet.tasks[0].title, '找客户');
  assert.equal(packet.tasks[0].kind, 'commitment');
  assert.ok(
    packet.tasks[0].entities.some((e) => e.type === 'task' && e.name === 'lark_task:g1'),
    '挂 lark_task: entity'
  );
  assert.equal(
    packet.commitments.find((c) => c.title === '找客户'),
    undefined,
    '不在 commitments 桶'
  );
});

test('两路按 guid 去重；due 归一', async () => {
  resetDb();
  await runLarkTaskSync({
    runLarkCliJson: mockCli({
      my: [{ guid: 'dup', summary: '同一个任务', due_at: '2026-06-03T08:00:00+08:00' }],
      related: [{ guid: 'dup', summary: '同一个任务（related 版本）', created_at: '2026-05-29 06:03:02' }],
    }),
  });
  const rows = activeTaskCommitments();
  assert.equal(rows.length, 1, 'guid 去重后只 1 条');
  const tj = rows[0].time_json ? JSON.parse(rows[0].time_json) : null;
  assert.equal(tj?.dueAt, '2026-06-03T00:00:00.000Z', 'dueAt 归一成 UTC ISO');
});

test('与卡片路径同 mergeHint → 合并为一条，不重复', async () => {
  resetDb();
  // 模拟卡片路径先建：origin=card_action，同 entity + mergeHint
  upsertContextUnit({
    kind: 'commitment',
    title: '卡片建的任务',
    content: '卡片',
    entities: [{ type: 'task', name: 'lark_task:gc', role: 'target', confidence: 1.0 }],
    scope: 'work',
    origin: { kind: 'card_action', refId: 'card-1' },
    actionability: 'act',
    confidence: 0.9,
    mergeHint: 'lark_task:gc',
  });
  assert.equal(activeTaskCommitments().length, 1);

  await runLarkTaskSync({
    runLarkCliJson: mockCli({ my: [{ guid: 'gc', summary: '飞书侧标题' }], related: [] }),
  });
  const rows = activeTaskCommitments();
  assert.equal(rows.length, 1, 'mergeHint 命中 → 原地 update，不新增');
  assert.equal(rows[0].title, '飞书侧标题', 'collector 覆盖了 title');
});

test('集合差对账：本地有、未完成全集没有 → superseded', async () => {
  resetDb();
  // 第一轮：a、b 都在
  await runLarkTaskSync({
    runLarkCliJson: mockCli({
      my: [
        { guid: 'a', summary: '任务A' },
        { guid: 'b', summary: '任务B' },
      ],
      related: [],
    }),
  });
  assert.equal(activeTaskCommitments().length, 2);

  // 第二轮：只剩 a（b 被标完成/删除）
  const res = await runLarkTaskSync({
    runLarkCliJson: mockCli({ my: [{ guid: 'a', summary: '任务A' }], related: [] }),
  });
  assert.equal(res.superseded, 1, 'b 被对账标掉');
  const live = activeTaskCommitments();
  assert.equal(live.length, 1);
  assert.ok(
    live[0].id && db.getActiveContextUnitByMergeKey(live[0].merge_key!)?.title === '任务A'
  );
});

test('噪声过滤：纯 [图片] / 空标题不落库，但仍计入 liveGuids（不被误标完成）', async () => {
  resetDb();
  // 先正常建一条 g-noise
  await runLarkTaskSync({
    runLarkCliJson: mockCli({ my: [{ guid: 'g-noise', summary: '真实标题' }], related: [] }),
  });
  assert.equal(activeTaskCommitments().length, 1);

  // 第二轮该任务 summary 变成纯图片占位（仍在未完成集合里）
  const res = await runLarkTaskSync({
    runLarkCliJson: mockCli({ my: [{ guid: 'g-noise', summary: '[图片][图片]' }], related: [] }),
  });
  assert.equal(res.upserted, 0, '纯图片不 upsert');
  assert.equal(res.superseded, 0, '但 guid 在 liveGuids 里，不被对账标掉');
  assert.equal(activeTaskCommitments().length, 1, '原 commitment 仍 active');
});

test('fetch 失败 → 抛错且不对账（不会把本地任务误标完成）', async () => {
  resetDb();
  await runLarkTaskSync({
    runLarkCliJson: mockCli({ my: [{ guid: 'keep', summary: '别动我' }], related: [] }),
  });
  assert.equal(activeTaskCommitments().length, 1);

  await assert.rejects(
    runLarkTaskSync({ runLarkCliJson: mockCli({ failMy: true }) }),
    /get-my-tasks/,
    '应抛错'
  );
  assert.equal(activeTaskCommitments().length, 1, '抛错前未对账，本地任务保留');
});
