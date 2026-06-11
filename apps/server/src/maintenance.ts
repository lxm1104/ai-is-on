// 日常维护任务（2026-06-11）。
//
// 背景：每次 runOneShot 都让 opencode 创建一个持久 session，一次性 triage/attention
// 调用每天产生 200+ 个，opencode.db 三周涨到 592MB；叠加磁盘高水位后，并发
// `PRAGMA wal_checkpoint` 开始间歇性失败（2026-06-11 晨 2h 内 77 个 exit=1 失败）。
// 一次性清理（10351→1152 session + VACUUM）后 580MB→24MB，失败消失。
//
// 本模块把清理固化：每天一次，小批量删 14 天前的 session（短事务 + 逐批 checkpoint，
// 不做 VACUUM —— 删行已能复用页、阻止增长；VACUUM 需要独占锁，留给手动维护）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const OPENCODE_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');
const RETAIN_DAYS = 14;
const BATCH = 500;
const MAX_BATCHES = 40;
const INTERVAL_MS = 24 * 3600_000;

let timer: NodeJS.Timeout | null = null;

async function sqlite(sql: string): Promise<string> {
  const { stdout } = await execFileAsync('sqlite3', [OPENCODE_DB, sql], {
    timeout: 60_000,
  });
  return stdout.trim();
}

export async function pruneOpencodeSessions(): Promise<{ removed: number } | null> {
  if (!fs.existsSync(OPENCODE_DB)) return null;
  const cutoffExpr = `(strftime('%s','now','-${RETAIN_DAYS} days')*1000)`;
  const before = Number(await sqlite(`SELECT COUNT(*) FROM session WHERE time_created < ${cutoffExpr}`));
  if (!Number.isFinite(before) || before === 0) return { removed: 0 };

  let batches = 0;
  while (batches < MAX_BATCHES) {
    const remaining = Number(
      await sqlite(`SELECT COUNT(*) FROM session WHERE time_created < ${cutoffExpr}`)
    );
    if (!remaining) break;
    await sqlite(`
      PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TEMP TABLE batch AS SELECT id FROM session WHERE time_created < ${cutoffExpr} LIMIT ${BATCH};
      DELETE FROM part WHERE session_id IN (SELECT id FROM batch);
      DELETE FROM message WHERE session_id IN (SELECT id FROM batch);
      DELETE FROM todo WHERE session_id IN (SELECT id FROM batch);
      DELETE FROM session_share WHERE session_id IN (SELECT id FROM batch);
      DELETE FROM session_message WHERE session_id IN (SELECT id FROM batch);
      DELETE FROM session WHERE id IN (SELECT id FROM batch);
      DROP TABLE batch;
      COMMIT;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    batches += 1;
  }
  const after = Number(await sqlite(`SELECT COUNT(*) FROM session WHERE time_created < ${cutoffExpr}`));
  const removed = before - (Number.isFinite(after) ? after : 0);
  console.log(`[maintenance] opencode session 清理：删除 ${removed} 个（保留 ${RETAIN_DAYS} 天内）`);
  return { removed };
}

export function startMaintenance(): void {
  if (timer) return;
  // 启动后 5 分钟首跑（避开启动恢复高峰），此后每 24h 一次。
  const kick = () => {
    pruneOpencodeSessions().catch((err) => {
      console.warn(
        '[maintenance] opencode session 清理失败:',
        err instanceof Error ? err.message : String(err)
      );
    });
  };
  setTimeout(kick, 5 * 60_000).unref();
  timer = setInterval(kick, INTERVAL_MS);
  timer.unref();
}

export function stopMaintenance(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
