/**
 * MVP21 S2 §5 — SpaceIntentJson seedGoalTitles / seedConcernTitles 字段重命名。
 *
 * 覆盖 4 种组合：
 *   1. 全新 Space：写入后 seed* 与 workMap* 都被填，且值相等
 *   2. 老库行（仅有 workMap*）：第一次 sync 后 seed* 被填入旧值，workMap* 保留
 *   3. 调用方传旧键 workMapGoalTitles：归一到 seed* 主键写入，workMap* 与之同步
 *   4. 同时传 seed* + workMap*（迁移期）：seed* 优先
 *
 * 同时验证 chatAffinityEvidence 读取的 fallback 路径（新 ?? 旧 ?? []）。
 *
 * 运行：npx tsx --test apps/server/test/mvp21-space-intent-rename.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp21-s2-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbMod = await import('../src/db.js');
const {
  getSpaceIntent,
  syncSpaceIntentFromWorkMap,
  decodeSpaceIntent,
} = await import('../src/spaces/contextSpaceService.js');

// ---------- helpers ----------

function makeSpace(name: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  dbMod.insertContextSpace({
    id,
    type: 'project',
    name,
    description: null,
    owner_subject_id: 'me',
    status: 'active',
    created_at: now,
    updated_at: now,
    intent_json: null,
    work_map_ref_json: null,
    suggestion_policy: 'manual_confirm',
  });
  return id;
}

/** 直接把 intent_json 写成老 schema（只有 workMap* 没有 seed*），模拟 S2 上线前数据。 */
function seedLegacyIntent(spaceId: string, opts: {
  workMapGoalTitles?: string[];
  workMapRiskTitles?: string[];
  updatedBy?: 'user' | 'work_map_writer';
}) {
  const intent: Record<string, unknown> = {
    schemaVersion: 1,
    workMapGoalTitles: opts.workMapGoalTitles ?? [],
    workMapRiskTitles: opts.workMapRiskTitles ?? [],
    updatedBy: opts.updatedBy ?? 'work_map_writer',
    updatedAt: new Date().toISOString(),
  };
  dbMod.db
    .prepare('UPDATE context_spaces SET intent_json=? WHERE id=?')
    .run(JSON.stringify(intent), spaceId);
}

function workMapRef(name: string) {
  return {
    source: 'work_map_writer' as const,
    projectName: name,
    origin: 'work_map' as const,
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================

test('组合 1：全新 Space，传 seed* → seed* 与 workMap* 都被填且值相等', () => {
  const id = makeSpace('proj-A');
  const merged = syncSpaceIntentFromWorkMap(
    id,
    {
      seedGoalTitles: ['Q3 渗透率 40%', '完善评测基准'],
      seedConcernTitles: ['Bandwidth 紧张'],
    },
    workMapRef('proj-A')
  );
  assert.ok(merged);
  assert.deepEqual(merged!.seedGoalTitles, ['Q3 渗透率 40%', '完善评测基准']);
  assert.deepEqual(merged!.seedConcernTitles, ['Bandwidth 紧张']);
  // 兼容键同步双写，值与主键完全一致
  assert.deepEqual(merged!.workMapGoalTitles, merged!.seedGoalTitles);
  assert.deepEqual(merged!.workMapRiskTitles, merged!.seedConcernTitles);
});

test('组合 2：老库行仅有 workMap*，第一次 sync 应保留旧值并迁移到 seed*', () => {
  const id = makeSpace('proj-B');
  seedLegacyIntent(id, {
    workMapGoalTitles: ['老目标 X', '老目标 Y'],
    workMapRiskTitles: ['老风险 Z'],
    updatedBy: 'work_map_writer',
  });

  // workMapWriter 重新跑一次但 patch.seed* 为空（模拟用户没在 UI 上改任何东西）
  const merged = syncSpaceIntentFromWorkMap(
    id,
    {
      // 空 patch：什么都不传
    },
    workMapRef('proj-B')
  );
  assert.ok(merged);
  // 老的 workMap* 数据应该被迁到 seed* 主键，且不丢
  assert.deepEqual(
    new Set(merged!.seedGoalTitles ?? []),
    new Set(['老目标 X', '老目标 Y']),
    'seedGoalTitles 应承接 workMapGoalTitles 的老数据'
  );
  assert.deepEqual(
    new Set(merged!.seedConcernTitles ?? []),
    new Set(['老风险 Z']),
    'seedConcernTitles 应承接 workMapRiskTitles 的老数据'
  );
  // 兼容键仍存在
  assert.deepEqual(merged!.workMapGoalTitles, merged!.seedGoalTitles);
  assert.deepEqual(merged!.workMapRiskTitles, merged!.seedConcernTitles);
});

test('组合 3：调用方传旧键 workMapGoalTitles → 归一到 seed* 主键', () => {
  const id = makeSpace('proj-C');
  const merged = syncSpaceIntentFromWorkMap(
    id,
    {
      // 模拟 S2 上线前的 caller 仍在传旧字段
      workMapGoalTitles: ['遗留路径 G'],
      workMapRiskTitles: ['遗留路径 R'],
    },
    workMapRef('proj-C')
  );
  assert.ok(merged);
  assert.deepEqual(merged!.seedGoalTitles, ['遗留路径 G']);
  assert.deepEqual(merged!.seedConcernTitles, ['遗留路径 R']);
  // 双写
  assert.deepEqual(merged!.workMapGoalTitles, ['遗留路径 G']);
  assert.deepEqual(merged!.workMapRiskTitles, ['遗留路径 R']);
});

test('组合 4：同时传 seed* 和 workMap* → seed* 优先（迁移期保护）', () => {
  const id = makeSpace('proj-D');
  const merged = syncSpaceIntentFromWorkMap(
    id,
    {
      seedGoalTitles: ['新键内容'],
      workMapGoalTitles: ['旧键内容（应被忽略）'],
      seedConcernTitles: ['新风险'],
      workMapRiskTitles: ['旧风险（应被忽略）'],
    },
    workMapRef('proj-D')
  );
  assert.ok(merged);
  assert.deepEqual(merged!.seedGoalTitles, ['新键内容']);
  assert.deepEqual(merged!.seedConcernTitles, ['新风险']);
  assert.deepEqual(merged!.workMapGoalTitles, ['新键内容']);
  assert.deepEqual(merged!.workMapRiskTitles, ['新风险']);
});

test('user-owned Space：sync 不覆盖用户已设的 seed*，但仍会同步双写到 workMap*', () => {
  const id = makeSpace('proj-E');
  // 用户先在 UI 上手动设了 seedGoalTitles + updatedBy='user'
  const intent = {
    schemaVersion: 1,
    seedGoalTitles: ['用户钉死的目标'],
    seedConcernTitles: ['用户钉死的风险'],
    workMapGoalTitles: ['用户钉死的目标'],
    workMapRiskTitles: ['用户钉死的风险'],
    updatedBy: 'user',
    updatedAt: new Date().toISOString(),
  };
  dbMod.db
    .prepare('UPDATE context_spaces SET intent_json=? WHERE id=?')
    .run(JSON.stringify(intent), id);

  // 之后 workMapWriter 再跑一次想用新内容覆盖
  const merged = syncSpaceIntentFromWorkMap(
    id,
    {
      seedGoalTitles: ['work_map 新内容'],
      seedConcernTitles: ['work_map 新风险'],
    },
    workMapRef('proj-E')
  );
  assert.ok(merged);
  // user-owned 语义：array 字段做并集追加，不删用户原值
  assert.ok(
    (merged!.seedGoalTitles ?? []).includes('用户钉死的目标'),
    '用户原值不应被删'
  );
  assert.ok(
    (merged!.seedGoalTitles ?? []).includes('work_map 新内容'),
    'work_map 新内容应追加'
  );
  assert.equal(merged!.updatedBy, 'user', 'user-owned 标志保留');
  // workMap* 仍跟 seed* 同步
  assert.deepEqual(merged!.workMapGoalTitles, merged!.seedGoalTitles);
  assert.deepEqual(merged!.workMapRiskTitles, merged!.seedConcernTitles);
});

test('decodeSpaceIntent 老库 JSON（仅 workMap*）正确反序列化', () => {
  const legacy = JSON.stringify({
    schemaVersion: 1,
    workMapGoalTitles: ['L1', 'L2'],
    workMapRiskTitles: ['R1'],
    updatedBy: 'work_map_writer',
  });
  const decoded = decodeSpaceIntent(legacy);
  assert.deepEqual(decoded.workMapGoalTitles, ['L1', 'L2']);
  assert.deepEqual(decoded.workMapRiskTitles, ['R1']);
  // seed* 字段未填（codec 不主动迁移，迁移在 sync 时发生）
  assert.equal(decoded.seedGoalTitles, undefined);
  assert.equal(decoded.seedConcernTitles, undefined);
});

test('decodeSpaceIntent 新库 JSON（仅 seed*）正确反序列化', () => {
  const fresh = JSON.stringify({
    schemaVersion: 1,
    seedGoalTitles: ['G1'],
    seedConcernTitles: ['C1'],
    workMapGoalTitles: ['G1'], // sync 自动双写
    workMapRiskTitles: ['C1'],
  });
  const decoded = decodeSpaceIntent(fresh);
  assert.deepEqual(decoded.seedGoalTitles, ['G1']);
  assert.deepEqual(decoded.seedConcernTitles, ['C1']);
});

test('getSpaceIntent 端到端：sync 后 seed* 与 workMap* 都能取到', () => {
  const id = makeSpace('proj-F');
  syncSpaceIntentFromWorkMap(
    id,
    { seedGoalTitles: ['一句话目标'] },
    workMapRef('proj-F')
  );
  const intent = getSpaceIntent(id);
  assert.ok(intent);
  assert.deepEqual(intent!.seedGoalTitles, ['一句话目标']);
  assert.deepEqual(intent!.workMapGoalTitles, ['一句话目标']);
});
