// 授权过期看门狗（2026-06-10）。
//
// 背景：lark-cli user token 过期时，collectors 静默失败（只写 collector_state.last_error），
// 监控系统自己瞎了却不告诉用户 —— 实际发生于 2026-06-10 上午，用户是在「让 AI 处理」
// 的聊天里才被告知 token 失效。
//
// 机制：collector 失败消息匹配 auth 类特征 → 插一张确定性 P0 系统卡（无 LLM）提示重登；
// 任一 collector 成功 → 自动把系统卡标 superseded。卡片走既有 attention 投影/动作通道。
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { insertAttentionItem } from '../attention/attentionStore.js';
import { broadcast } from '../ws.js';

/** 同一时间最多一张；用固定 input_hash 去重 + 恢复时定位。 */
const AUTH_CARD_HASH = 'system:lark-auth-expired';

const AUTH_ERROR_PATTERNS = [
  /identity:\s*missing/i,
  /user identity/i,
  /unauthorized/i,
  /token.*(expired|invalid)/i,
  /invalid.*token/i,
  /auth.*(expired|failed|required)/i,
  /99991663|99991664|99991665/, // 飞书开放平台 token 类错误码
];

export function looksLikeAuthError(msg: string): boolean {
  return AUTH_ERROR_PATTERNS.some((re) => re.test(msg));
}

function liveAuthCardId(): string | null {
  const row = db
    .prepare(
      `SELECT id FROM attention_items WHERE status = 'live' AND input_hash = ? LIMIT 1`
    )
    .get(AUTH_CARD_HASH) as { id: string } | undefined;
  return row?.id ?? null;
}

// 举报者：只有同一个 collector 成功才撤卡，防止 bot 身份 collector 的成功
// 误撤 user 身份失效卡（两套 token 独立过期）。进程重启丢失 → 退化为任意成功可撤，可接受。
let raisedBy: string | null = null;

/** collector 失败时调用：auth 类错误 → 升起 P0 系统卡（幂等）。 */
export function reportCollectorError(collectorName: string, msg: string): void {
  if (!looksLikeAuthError(msg)) return;
  if (liveAuthCardId()) return; // 已有在场卡，不重复
  const now = new Date().toISOString();
  try {
    const item = insertAttentionItem({
      id: randomUUID(),
      generation: 0, // 系统卡不参与 LLM 代际
      llmRunId: null,
      inputHash: AUTH_CARD_HASH,
      llmItem: {
        priority: 'P0',
        title: '飞书授权已失效，监控暂停',
        why:
          `collector「${collectorName}」遇到鉴权错误：${msg.slice(0, 160)}。` +
          ' 日历/IM/文档信号采集已中断，新事项不会进来。',
        suggestedAction: '在终端运行 `lark-cli auth login` 重新登录，恢复后本卡自动消失。',
        signalIds: [],
      },
      now,
    });
    raisedBy = collectorName;
    broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
    console.warn(`[auth-watchdog] 升起授权失效卡 ${item.id}（来自 ${collectorName}）`);
  } catch (err) {
    console.warn(
      '[auth-watchdog] 插入系统卡失败:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** collector 成功时调用：举报者本人恢复（或举报者未知）才撤卡（幂等、零成本早退）。 */
export function reportCollectorSuccess(collectorName: string): void {
  const id = liveAuthCardId();
  if (!id) return;
  if (raisedBy && raisedBy !== collectorName) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE attention_items SET status = 'superseded', updated_at = ? WHERE id = ?`
  ).run(now, id);
  raisedBy = null;
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 0 });
  console.log('[auth-watchdog] 授权恢复，撤下系统卡');
}
