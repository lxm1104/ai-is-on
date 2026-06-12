// 启动恢复：补救「重启即丢」的内存态。
//
// 背景（2026-06-10 实测）：
//   - triage 队列是纯内存的（triageQueue.ts），dev 模式 tsx watch 每次改代码都
//     重启进程，队列里未处理的 events 永远停在 processed_at IS NULL（积压 2014 条）。
//   - in-flight 的 attention_engine_runs / agent_runs 随进程死掉后没人收尸，
//     永久停留在占位/running 状态（agent_runs 有 4 条 5/19 起卡住的 running）。
//
// 原则：
//   - 年轻的真积压 → 重新入队（attention 价值还在）。
//   - 过老的积压 → 直接销账（价值已衰减，回灌只会压垮 LLM 闸门，还会生成过期卡片）。
//   - 孤儿 run → 标 failed，让监控/调试视图反映真实状态。
import { db, type EventRow } from './db.js';
import { enqueueEvents } from './triage/triageQueue.js';
import { sendTopicMessage } from './chat/chatTopics.js';

/** 超过该年龄的未处理事件不再回灌 triage，直接销账。 */
const RECOVERY_MAX_AGE_HOURS = 48;
/** 单次启动最多回灌多少条，防止启动风暴（按 triageBatchSize=6 即 ≤10 个 LLM 批次）。 */
const RECOVERY_MAX_REQUEUE = 60;

export type StartupRecoveryReport = {
  orphanedAttentionRuns: number;
  orphanedAgentRuns: number;
  eventsWrittenOff: number;
  eventsRequeued: number;
  eventsLeftBehind: number;
  chatTurnsResumed: number;
};

/** 重启被杀的聊天 turn：只续最近 30 分钟内、且中止标记是该 topic 最后一条消息的。 */
const CHAT_RESUME_WINDOW_MIN = 30;
const CHAT_RESUME_CAP = 2;

// tsx watch 下改码即重启，正在跑的聊天 turn 会被 forceKill 杀掉（2026-06-12 实测：
// 用户点「让 AI 处理」后两次拿到半截调查就没下文）。messageBus 现在会把「本轮被中止」
// 落成 system 消息——这里据此找到被杀 topic，自动补一条续跑指令。
function resumeKilledChatTurns(): number {
  const rows = db
    .prepare(
      `SELECT t.id AS topic_id
       FROM chat_topics t
       JOIN runtime_messages m ON m.topic_id = t.id
       WHERE m.id = (
         SELECT id FROM runtime_messages WHERE topic_id = t.id
         ORDER BY created_at DESC LIMIT 1
       )
         AND m.role = 'system'
         AND m.text LIKE '%本轮被中止%'
         AND m.created_at > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-${CHAT_RESUME_WINDOW_MIN} minutes')
       LIMIT ${CHAT_RESUME_CAP}`
    )
    .all() as Array<{ topic_id: string }>;
  let resumed = 0;
  for (const r of rows) {
    try {
      sendTopicMessage({
        topicId: r.topic_id,
        text: '（系统恢复）上一轮因服务重启被中止。请基于已有进展继续完成任务，并以明确结论收尾；不要从头重做已完成的步骤。',
        skipContext: true,
      });
      resumed += 1;
    } catch (err) {
      console.warn(
        '[recovery] chat turn resume failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return resumed;
}

export function runStartupRecovery(): StartupRecoveryReport {
  const now = new Date().toISOString();
  const cutoff = new Date(
    Date.now() - RECOVERY_MAX_AGE_HOURS * 3600_000
  ).toISOString();

  // 1) 孤儿 attention run：startEngineRun 先写占位行（completed_at IS NULL），
  //    进程死掉后没人 finish。重启后所有未完成行必然是孤儿。
  const orphanedAttentionRuns = db
    .prepare(
      `UPDATE attention_engine_runs
       SET status = 'failed', error = 'orphaned by restart', completed_at = ?
       WHERE completed_at IS NULL`
    )
    .run(now).changes;

  // 2) 孤儿 agent run：同理，running/queued 状态随进程死亡失效。
  const orphanedAgentRuns = db
    .prepare(
      `UPDATE agent_runs
       SET status = 'failed', error = 'orphaned by restart', completed_at = ?
       WHERE status IN ('running', 'queued')`
    )
    .run(now).changes;

  // 3) 过老积压销账。
  const writtenOffOld = db
    .prepare(
      `UPDATE events SET processed_at = ?
       WHERE processed_at IS NULL AND created_at < ?`
    )
    .run(now, cutoff).changes;

  // 4) skipTriage 类历史存量销账：doc_comment / doc_comment_reply 在 ingest 已
  //    结构化（driveCommentCollector skipTriage=true），从不需要 triage。
  //    scheduler 现在 ingest 即打 processed_at；这里只兜旧数据。
  const writtenOffSkip = db
    .prepare(
      `UPDATE events SET processed_at = ?
       WHERE processed_at IS NULL
         AND source = 'drive' AND kind IN ('doc_comment', 'doc_comment_reply')`
    )
    .run(now).changes;

  // 5) 年轻真积压重新入队（FIFO，有 cap）。
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE processed_at IS NULL
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(RECOVERY_MAX_REQUEUE) as EventRow[];
  if (rows.length) enqueueEvents(rows);

  const leftBehind = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE processed_at IS NULL`)
      .get() as { n: number }
  ).n - rows.length;

  // 6) 重启被杀的聊天 turn 自动续跑（标记由 messageBus 持久化的「本轮被中止」消息提供）。
  const chatTurnsResumed = resumeKilledChatTurns();

  return {
    orphanedAttentionRuns,
    orphanedAgentRuns,
    eventsWrittenOff: writtenOffOld + writtenOffSkip,
    eventsRequeued: rows.length,
    eventsLeftBehind: Math.max(0, leftBehind),
    chatTurnsResumed,
  };
}
