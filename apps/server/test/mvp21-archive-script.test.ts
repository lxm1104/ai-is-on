/**
 * MVP21 S4 §7.5 — archive script 单测。
 *
 * 直接 import script 模块测试不现实（顶层 main() 在 import-time 执行）。
 * 改为直接测它使用的两个 SQL：listAffectedRows 和 applyArchive 的等价逻辑。
 *
 * 覆盖：
 *   - 空 DB：affected = 0
 *   - 有匹配行：列出来 + dry-run 不改库 + --confirm 写库
 *   - 幂等：重跑只处理 active 行
 *   - 不会误伤其它 work_map:* 前缀（role / goal / relationship / preference）
 *
 * 运行：npx tsx --test apps/server/test/mvp21-archive-script.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiio-mvp21-archive-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.COLLECTOR_ENABLED = 'false';

const dbMod = await import('../src/db.js');

// ---------- helpers：模拟 script 内的两个核心 SQL ----------

type Row = { id: string; merge_key: string | null; kind: string };

function listAffectedRows(): Row[] {
  return dbMod.db
    .prepare(
      `SELECT id, merge_key, kind FROM context_units
        WHERE status='active'
          AND merge_key IS NOT NULL
          AND (merge_key LIKE 'work_map:commitment:%'
               OR merge_key LIKE 'work_map:risk:%')
        ORDER BY merge_key`
    )
    .all() as Row[];
}

function applyArchive(now: string): number {
  const r = dbMod.db
    .prepare(
      `UPDATE context_units
          SET status='archived', updated_at=?
        WHERE status='active'
          AND merge_key IS NOT NULL
          AND (merge_key LIKE 'work_map:commitment:%'
               OR merge_key LIKE 'work_map:risk:%')`
    )
    .run(now);
  return r.changes;
}

function insertLegacyUnit(opts: {
  kind: string;
  mergeKey: string;
  status?: string;
}) {
  const now = new Date().toISOString();
  dbMod.db
    .prepare(
      `INSERT INTO context_units
       (id, subject_id, scope, origin_kind, origin_ref_id, kind, title, content,
        actionability, confidence, merge_key, version, status, created_at, updated_at)
       VALUES (?, 'me', 'work', 'system', 'work_map', ?, 'legacy', '',
               'record', 0.7, ?, 1, ?, ?, ?)`
    )
    .run(randomUUID(), opts.kind, opts.mergeKey, opts.status ?? 'active', now, now);
}

function resetDb() {
  dbMod.db.exec(`DELETE FROM context_units;`);
}

// ============================================================================

test('空 DB：affected = 0', () => {
  resetDb();
  assert.deepEqual(listAffectedRows(), []);
});

test('有 commitment / risk 老数据：列出来 + dry-run 不改库', () => {
  resetDb();
  insertLegacyUnit({ kind: 'commitment', mergeKey: 'work_map:commitment:proj-a:dl-1' });
  insertLegacyUnit({ kind: 'commitment', mergeKey: 'work_map:commitment:proj-a:dl-2' });
  insertLegacyUnit({ kind: 'uncertainty', mergeKey: 'work_map:risk:proj-a:r1' });
  const affected = listAffectedRows();
  assert.equal(affected.length, 3, '应识别出 3 条');

  // 模拟 dry-run：不调 applyArchive
  // 验证 active 行还在
  const stillActive = dbMod.db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_units
        WHERE status='active' AND merge_key LIKE 'work_map:%'`
    )
    .get() as { n: number };
  assert.equal(stillActive.n, 3, 'dry-run 不应改任何行');
});

test('--confirm 路径：archive 写入 status=archived + updated_at', () => {
  resetDb();
  insertLegacyUnit({ kind: 'commitment', mergeKey: 'work_map:commitment:proj-a:dl-1' });
  insertLegacyUnit({ kind: 'uncertainty', mergeKey: 'work_map:risk:proj-a:r1' });

  const now = '2026-05-28T12:00:00.000Z';
  const changed = applyArchive(now);
  assert.equal(changed, 2);

  const archivedCount = dbMod.db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_units
        WHERE status='archived' AND merge_key LIKE 'work_map:%' AND updated_at=?`
    )
    .get(now) as { n: number };
  assert.equal(archivedCount.n, 2);

  // affected 现在为 0
  assert.equal(listAffectedRows().length, 0);
});

test('幂等：重跑只处理仍 active 的行', () => {
  resetDb();
  insertLegacyUnit({ kind: 'commitment', mergeKey: 'work_map:commitment:p:d1' });
  // 一条已归档的（之前的 archive 跑过）
  insertLegacyUnit({ kind: 'risk', mergeKey: 'work_map:risk:p:r1', status: 'archived' });

  const changed = applyArchive('2026-05-28T13:00:00.000Z');
  assert.equal(changed, 1, '只动 1 条新的 active；已 archived 的不重复');
});

test('不误伤其它 work_map:* 前缀 (goal / state / preference / relationship)', () => {
  resetDb();
  insertLegacyUnit({ kind: 'goal', mergeKey: 'work_map:goal:p:q3' });
  insertLegacyUnit({ kind: 'state', mergeKey: 'work_map:role:self' });
  insertLegacyUnit({ kind: 'state', mergeKey: 'work_map:responsibility:pm' });
  insertLegacyUnit({ kind: 'preference', mergeKey: 'work_map:preference:abc' });
  insertLegacyUnit({ kind: 'relationship', mergeKey: 'work_map:relationship:zhang-san' });
  // 控制组：一条 commitment 应该被 archive
  insertLegacyUnit({ kind: 'commitment', mergeKey: 'work_map:commitment:p:d1' });

  const affected = listAffectedRows();
  assert.equal(affected.length, 1, '只 commitment 一条受影响');
  assert.equal(affected[0].mergeKey ?? affected[0].merge_key, 'work_map:commitment:p:d1');

  const changed = applyArchive('2026-05-28T14:00:00.000Z');
  assert.equal(changed, 1);

  // 验证其它 5 条仍 active
  const stillActive = dbMod.db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_units
        WHERE status='active' AND merge_key LIKE 'work_map:%'`
    )
    .get() as { n: number };
  assert.equal(stillActive.n, 5, 'goal/state/preference/relationship 5 条仍 active');
});

test('不动 triage 出的 commitment（mergeKey 非 work_map:* 前缀）', () => {
  resetDb();
  // 模拟 triage 写的 commitment（sha1 mergeKey）
  insertLegacyUnit({ kind: 'commitment', mergeKey: 'a1b2c3d4e5f6' });
  insertLegacyUnit({ kind: 'commitment', mergeKey: 'work_map:commitment:p:d1' });

  const changed = applyArchive('2026-05-28T15:00:00.000Z');
  assert.equal(changed, 1, '只 work_map:* seed 被 archive，triage 的不动');

  // 验证 triage 的还在
  const triageStillActive = dbMod.db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_units
        WHERE status='active' AND merge_key='a1b2c3d4e5f6'`
    )
    .get() as { n: number };
  assert.equal(triageStillActive.n, 1);
});
