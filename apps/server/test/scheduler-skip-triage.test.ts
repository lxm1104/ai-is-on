/**
 * MVP11.0-a §I-6：scheduler 中 skipTriage 与 row 索引绑定不被 dedup 错位。
 *
 * 这里做结构性检查：scheduler.ts 必须出现
 *   - `InsertedRow` 元组类型
 *   - `skipTriage: sig.skipTriage`
 *   - `triagedRows = newRows.filter`
 * 行为级验证留给 mvp11-0-smoke（接到真实 collector 数据后跑）。
 *
 * 运行：npx tsx --test apps/server/test/scheduler-skip-triage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schedulerSrc = readFileSync(
  path.resolve(__dirname, '../src/collectors/scheduler.ts'),
  'utf8'
);

test('scheduler 用 InsertedRow 元组保存 skipTriage', () => {
  assert.match(schedulerSrc, /InsertedRow\s*=\s*\{\s*row:\s*EventRow;\s*skipTriage:\s*boolean/);
});

test('scheduler push 时把 skipTriage 与 row 一起入栈', () => {
  assert.match(schedulerSrc, /newRows\.push\(\s*\{\s*row,\s*skipTriage:\s*sig\.skipTriage\s*===\s*true\s*\}/);
});

test('scheduler enqueueEvents 前按 skipTriage 分流（skip 行即时标 processed）', () => {
  // 2026-06-10 起：skipTriage 行 ingest 即 markEventProcessed（"processed_at IS NULL ≡ 等 triage"
  // 的语义由重启恢复依赖），其余行进 triagedRows 再 enqueue。
  assert.match(schedulerSrc, /if\s*\(x\.skipTriage\)\s*\{\s*markEventProcessed\(x\.row\.id/);
  assert.match(schedulerSrc, /else\s*\{\s*triagedRows\.push\(x\.row\)/);
  assert.match(schedulerSrc, /if\s*\(triagedRows\.length\)\s*enqueueEvents\(triagedRows\)/);
});

test('scheduler 把 sig 的新字段透传给 insertMinimalEventContextUnit', () => {
  assert.match(schedulerSrc, /entities:\s*sig\.entities/);
  assert.match(schedulerSrc, /contextMergeHint:\s*sig\.contextMergeHint/);
  assert.match(schedulerSrc, /actionability:\s*sig\.actionability/);
  assert.match(schedulerSrc, /semanticTags:\s*sig\.semanticTags/);
  assert.match(schedulerSrc, /scope:\s*sig\.scope\s*\?\?\s*scopeForSource/);
});
