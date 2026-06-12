// 数据新鲜度看门狗（2026-06-12）。
//
// 背景：6/11-12 lark-cli 子进程整批挂死，collector 互斥锁被永久占住，采集停摆
// 19 小时 —— 期间 attention 引擎照常运行并报 "ok"（吃的全是陈旧数据），authWatchdog
// 只认「错误消息」而挂死不产生错误，用户对失明毫无感知。
//
// 机制：周期检查全部在册 collector 的 last_success_at；连最新的一条都比现在旧超过
// 阈值（默认 30min，collector 间隔最长 10min）→ 升确定性 P0 系统卡（无 LLM、固定
// input_hash 去重）；恢复后自动撤卡。与 authWatchdog 互补：那边管"报错"，这边管"沉默"。
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { insertAttentionItem } from '../attention/attentionStore.js';
import { broadcast } from '../ws.js';
import { getCollectorSnapshot } from './scheduler.js';

const STALE_CARD_HASH = 'system:collectors-stale';
const WATERMARK_LAG_CARD_HASH = 'system:collector-watermark-lag';

export type FreshnessVerdict =
  | { stale: false }
  | { stale: true; staleMinutes: number; freshestName: string | null };

export type WatermarkLagVerdict =
  | { lagging: false }
  | { lagging: true; worstName: string; lagMinutes: number };

/**
 * MVP33 U1 纯决策：扫描在成功（lastSuccessAt 新鲜）但覆盖水位落后实时超阈值 → 告警。
 * 与停滞告警互补：那边管「活性」（采集是否还在跑），这边管「覆盖进度」（数据是否跟得上）。
 * 触发场景：积压排水太慢、某 chat 截断 clamp 不收敛、外部单聊持续抓取失败等。
 * 只看 lastSuccessAt 新鲜的 collector——停摆场景由 evaluateFreshness 负责，不双报。
 */
export function evaluateWatermarkLag(
  snapshot: Array<{ name: string; lastSuccessAt?: string; coveredUntil?: string }>,
  nowMs: number,
  lagAlarmMs: number,
  staleAfterMs: number
): WatermarkLagVerdict {
  let worst: { name: string; lagMs: number } | null = null;
  for (const c of snapshot) {
    if (!c.lastSuccessAt || !c.coveredUntil) continue;
    const successMs = Date.parse(c.lastSuccessAt);
    if (!Number.isFinite(successMs) || nowMs - successMs > staleAfterMs) continue; // 停摆另有告警
    const coveredMs = Date.parse(c.coveredUntil);
    if (!Number.isFinite(coveredMs)) continue;
    const lagMs = nowMs - coveredMs;
    if (lagMs > lagAlarmMs && (!worst || lagMs > worst.lagMs)) {
      worst = { name: c.name, lagMs };
    }
  }
  if (!worst) return { lagging: false };
  return { lagging: true, worstName: worst.name, lagMinutes: Math.round(worst.lagMs / 60_000) };
}

/** 纯决策：给定各 collector 的 lastSuccessAt，判断采集是否整体停滞。 */
export function evaluateFreshness(
  snapshot: Array<{ name: string; lastSuccessAt?: string }>,
  nowMs: number,
  staleAfterMs: number
): FreshnessVerdict {
  if (!snapshot.length) return { stale: false }; // collector 未启用，不告警
  let freshestMs = -Infinity;
  let freshestName: string | null = null;
  for (const c of snapshot) {
    if (!c.lastSuccessAt) continue;
    const t = Date.parse(c.lastSuccessAt);
    if (Number.isFinite(t) && t > freshestMs) {
      freshestMs = t;
      freshestName = c.name;
    }
  }
  // 从未有任何成功记录（全新库）：交给首轮采集自己跑，不在这里告警。
  if (!Number.isFinite(freshestMs) || freshestMs === -Infinity) return { stale: false };
  const ageMs = nowMs - freshestMs;
  if (ageMs <= staleAfterMs) return { stale: false };
  return { stale: true, staleMinutes: Math.round(ageMs / 60_000), freshestName };
}

function liveCardIdByHash(hash: string): string | null {
  const row = db
    .prepare(`SELECT id FROM attention_items WHERE status = 'live' AND input_hash = ? LIMIT 1`)
    .get(hash) as { id: string } | undefined;
  return row?.id ?? null;
}

function liveStaleCardId(): string | null {
  return liveCardIdByHash(STALE_CARD_HASH);
}

function raiseCard(verdict: Extract<FreshnessVerdict, { stale: true }>): void {
  if (liveStaleCardId()) return;
  const now = new Date().toISOString();
  try {
    const item = insertAttentionItem({
      id: randomUUID(),
      generation: 0, // 系统卡不参与 LLM 代际
      llmRunId: null,
      inputHash: STALE_CARD_HASH,
      llmItem: {
        priority: 'P0',
        title: '事项采集已停滞，监控可能失明',
        why:
          `所有 collector 已 ${verdict.staleMinutes} 分钟没有任何成功扫描` +
          `（最近一次成功：${verdict.freshestName ?? '未知'}）。` +
          ' 新的日历/IM/文档信号进不来，看板内容正在变陈旧。',
        suggestedAction:
          '查看 /api/collectors 的 lastError 与 running 状态；' +
          "若有挂死子进程可执行 pkill -9 -f 'npm-global/.*lark-cli'，必要时重启服务。恢复后本卡自动消失。",
        signalIds: [],
      },
      now,
    });
    broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
    console.error(
      `[freshness-watchdog] 采集停滞 ${verdict.staleMinutes}min，升起系统卡 ${item.id}`
    );
  } catch (err) {
    console.warn(
      '[freshness-watchdog] 插入系统卡失败:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

function withdrawCard(): void {
  const id = liveStaleCardId();
  if (!id) return;
  const now = new Date().toISOString();
  db.prepare(`UPDATE attention_items SET status = 'superseded', updated_at = ? WHERE id = ?`).run(
    now,
    id
  );
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 0 });
  console.log('[freshness-watchdog] 采集恢复，撤下停滞系统卡');
}

// MVP33 U1：水位滞后卡（P1）。raise/withdraw 与停滞卡同构，独立 input_hash 互不干扰。
function raiseWatermarkLagCard(verdict: Extract<WatermarkLagVerdict, { lagging: true }>): void {
  if (liveCardIdByHash(WATERMARK_LAG_CARD_HASH)) return;
  const now = new Date().toISOString();
  try {
    const item = insertAttentionItem({
      id: randomUUID(),
      generation: 0,
      llmRunId: null,
      inputHash: WATERMARK_LAG_CARD_HASH,
      llmItem: {
        priority: 'P1',
        title: '采集覆盖落后于实时',
        why:
          `collector「${verdict.worstName}」扫描在正常运行，但覆盖水位落后实时 ` +
          `${verdict.lagMinutes} 分钟（阈值 ${Math.round(config.collectorWatermarkLagAlarmMs / 60_000)} 分钟）。` +
          ' 多为停摆后积压排水、单 chat 截断不收敛或某抓取路径持续失败——期间新消息会延迟呈现。',
        suggestedAction:
          '查看 /api/collectors 的 coveredUntil 与服务日志中的「覆盖水位 clamp」记录；' +
          '若长期不收敛可调大 IM_MAX_SCAN_WINDOW_MS / IM_P2P_PAGE_LIMIT。追平后本卡自动消失。',
        signalIds: [],
      },
      now,
    });
    broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
    console.error(
      `[freshness-watchdog] 覆盖水位滞后 ${verdict.lagMinutes}min（${verdict.worstName}），升起系统卡 ${item.id}`
    );
  } catch (err) {
    console.warn(
      '[freshness-watchdog] 插入水位滞后卡失败:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

function withdrawWatermarkLagCard(): void {
  const id = liveCardIdByHash(WATERMARK_LAG_CARD_HASH);
  if (!id) return;
  const now = new Date().toISOString();
  db.prepare(`UPDATE attention_items SET status = 'superseded', updated_at = ? WHERE id = ?`).run(
    now,
    id
  );
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 0 });
  console.log('[freshness-watchdog] 覆盖水位追平，撤下滞后系统卡');
}

function check(): void {
  const snapshot = getCollectorSnapshot();
  const verdict = evaluateFreshness(snapshot, Date.now(), config.collectorStaleAlarmMs);
  if (verdict.stale) raiseCard(verdict);
  else withdrawCard();

  const lagVerdict = evaluateWatermarkLag(
    snapshot,
    Date.now(),
    config.collectorWatermarkLagAlarmMs,
    config.collectorStaleAlarmMs
  );
  if (lagVerdict.lagging) raiseWatermarkLagCard(lagVerdict);
  else withdrawWatermarkLagCard();
}

let timer: NodeJS.Timeout | undefined;

export function startFreshnessWatchdog(): void {
  if (!config.collectorEnabled) return;
  if (timer) return;
  // 首查延后 5min：给启动后的首轮采集留时间，避免重启即误报。
  setTimeout(() => check(), 5 * 60_000).unref();
  timer = setInterval(() => check(), 5 * 60_000);
  console.log(
    `[freshness-watchdog] started（阈值 ${Math.round(config.collectorStaleAlarmMs / 60_000)}min，每 5min 检查）`
  );
}

export function stopFreshnessWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
