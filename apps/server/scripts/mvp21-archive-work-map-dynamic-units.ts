/**
 * MVP21 S4 §7.3 — 归档历史的 work_map:commitment:* / work_map:risk:* unit。
 *
 * 背景：S4 上线后 workMapWriter 不再写这两类 unit，但既有 DB 行仍然 status='active'，
 * 会继续被 agentContextAssembler 喂给 attention LLM。本 script 把它们一次性
 * 标 status='archived'（**不删行**，可手工回滚）。
 *
 * 默认 dry-run：只打印将被影响的行数，不写库。必须显式传 --confirm 才执行。
 *
 * 用法：
 *   # 1) 先看影响范围
 *   $ npx tsx apps/server/scripts/mvp21-archive-work-map-dynamic-units.ts
 *
 *   # 2) 确认无误后执行
 *   $ npx tsx apps/server/scripts/mvp21-archive-work-map-dynamic-units.ts --confirm
 *
 *   # 回滚（手工 SQL，本 script 不提供 unarchive flag 以免误用）
 *   $ sqlite3 data/ai-is-on.sqlite "UPDATE context_units SET status='active' \
 *       WHERE status='archived' AND (merge_key LIKE 'work_map:commitment:%' \
 *       OR merge_key LIKE 'work_map:risk:%')"
 *
 * 幂等：重跑只会处理仍 'active' 的行；已 archived 不再重复操作。
 */
import { db } from '../src/db.js';

type Row = {
  id: string;
  merge_key: string | null;
  kind: string;
  title: string;
  updated_at: string;
};

function listAffectedRows(): Row[] {
  return db
    .prepare(
      `SELECT id, merge_key, kind, title, updated_at
         FROM context_units
        WHERE status='active'
          AND merge_key IS NOT NULL
          AND (merge_key LIKE 'work_map:commitment:%'
               OR merge_key LIKE 'work_map:risk:%')
        ORDER BY merge_key`
    )
    .all() as Row[];
}

function applyArchive(now: string): number {
  const r = db
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

function main(): void {
  const args = new Set(process.argv.slice(2));
  const confirm = args.has('--confirm');
  const rows = listAffectedRows();

  console.log(`== MVP21 S4 archive: work_map dynamic-signal unit ==`);
  console.log(`Found ${rows.length} active row(s) matching work_map:commitment:* / work_map:risk:*`);

  if (rows.length === 0) {
    console.log('Nothing to do (no active work_map dynamic-signal unit).');
    return;
  }

  // 前 10 条预览
  const preview = rows.slice(0, 10);
  console.log(`\nPreview (showing ${preview.length} of ${rows.length}):`);
  for (const r of preview) {
    console.log(`  [${r.kind}] ${r.merge_key} -- ${r.title.slice(0, 50)}`);
  }
  if (rows.length > 10) {
    console.log(`  ... and ${rows.length - 10} more`);
  }

  if (!confirm) {
    console.log(`\nDRY RUN. No changes written. Re-run with --confirm to archive.`);
    return;
  }

  const now = new Date().toISOString();
  const changed = applyArchive(now);
  console.log(`\nArchived ${changed} row(s) (status='archived', updated_at=${now}).`);
  console.log(`Rollback if needed:`);
  console.log(`  sqlite3 data/ai-is-on.sqlite "UPDATE context_units SET status='active' \\`);
  console.log(`    WHERE status='archived' AND updated_at='${now}' \\`);
  console.log(`    AND merge_key LIKE 'work_map:%'"`);
}

main();
