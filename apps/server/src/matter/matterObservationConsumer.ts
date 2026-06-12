/**
 * MVP33 U2 — matter_observations 消费通路。
 *
 * 背景：triage 对每个 event 直出 MatterObservation（"这条 event 在推进/完成/阻塞某事项"），
 * 但 MVP29 只落了表没接消费——观察是只写死信，doc 编辑、应用通知、state 单元等
 * 非语义 kind 证据永远到不了 Matter 状态机（2026-06-12 专利事故的第二层根因）。
 *
 * 数据流：
 *   triageQueue.persistMatterObservations → recordMatterObservation（返回 id）
 *     → void consumeMatterObservation(id)（fire-and-forget，不阻塞 triage 批次）
 *        ① 门槛：lifecycle_effect ∈ {advance, resolve, block, reopen} 且 confidence ≥ 配置
 *        ② 让路：event 已产出 HANDLED_KINDS 语义单元 → reducer hook 已负责，跳过防双判
 *        ③ 召回：scoreAndRank（实体轴）∪ titleSimilarity(obs.title, matter.title)（标题轴，
 *           补实体稀疏的应用通知类证据），合并 top 8
 *        ④ 判定+落地：reduceUnitWithCandidates —— 复用 reducer 的 LLM 判定与保守阈值
 *           （≥0.78 改状态、0.55-0.78 只挂证据、永不 create/drop）
 *        ⑤ 销账：consumed_at + consume_result + 回写 candidate_matter_ids_json
 *
 * 失败语义：judge 失败（provider 超时等）不销账 → 进程重启时 recoverUnconsumedObservations
 * 补扫重试（48h 窗口、单轮上限、走 opencode 单并发闸门），不会无限循环。
 */
import { config } from '../config.js';
import {
  getMatterObservationRow,
  listUnconsumedMatterObservationRows,
  markMatterObservationConsumed,
} from '../db.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import { getContextUnitById } from '../context/contextStore.js';
import { scoreAndRank, titleSimilarity } from './matterMatcher.js';
import {
  HANDLED_KINDS,
  type ReduceOptions,
  reduceUnitWithCandidates,
} from './matterReducer.js';
import { listMatters } from './matterStore.js';
import type { Matter, MatterStatus } from './matterTypes.js';

const ACTIVE_STATUSES: MatterStatus[] = [
  'open',
  'acknowledged',
  'in_progress',
  'waiting',
  'blocked',
];

// 只消费作用于既有 Matter 的效果；create 类由 commitment 单元路径负责创建
// （那条路有 actionability/实体门槛，防观察类噪声开新 Matter）。
const CONSUMABLE_EFFECTS = new Set(['advance', 'resolve', 'block', 'reopen']);

// 标题轴召回线：char-bigram Jaccard。比 scoreAndRank 的 titleSimilar(0.3) 略松——
// 这里只是进候选（top 8 + LLM 判定 + 0.78/0.55 双闸在后面兜底）。
const TITLE_RECALL_THRESHOLD = 0.25;
const CANDIDATE_CAP = 8;
const RECOVERY_WINDOW_MS = 48 * 3600_000;
const RECOVERY_BATCH_LIMIT = 50;

export type ConsumeOutcome = {
  observationId: string;
  /** 终态描述，写入 consume_result（'pending_retry' 例外：未销账，待重启补扫）。 */
  result: string;
};

/** 标题轴召回（纯函数，便于单测）：活跃 matter 里标题与观察标题相似的。 */
export function recallByTitle(
  obsTitle: string,
  matters: Matter[],
  threshold = TITLE_RECALL_THRESHOLD
): Matter[] {
  return matters
    .map((m) => ({ m, sim: titleSimilarity(obsTitle, m.title) }))
    .filter((x) => x.sim >= threshold)
    .sort((a, b) => b.sim - a.sim)
    .map((x) => x.m);
}

export async function consumeMatterObservation(
  observationId: string,
  opts: ReduceOptions = {}
): Promise<ConsumeOutcome> {
  const obs = getMatterObservationRow(observationId);
  if (!obs) return { observationId, result: 'missing' };
  if (obs.consumed_at) return { observationId, result: 'already_consumed' };

  const nowMs = opts.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const settle = (result: string, candidateIds?: string[]): ConsumeOutcome => {
    markMatterObservationConsumed(
      observationId,
      nowIso,
      result,
      candidateIds ? JSON.stringify(candidateIds) : undefined
    );
    return { observationId, result };
  };

  if (!config.matterObsConsumeEnabled) return settle('disabled');

  const effect = (obs.lifecycle_effect ?? '').toLowerCase();
  if (!CONSUMABLE_EFFECTS.has(effect)) return settle(`skip:effect=${effect || 'none'}`);
  if (obs.confidence < config.matterObsMinConfidence) {
    return settle(`skip:low_confidence=${obs.confidence.toFixed(2)}`);
  }

  // ② 让路：同 event 的语义单元已走 reducer hook，避免对同一证据双跑 LLM 判定/写冲突 transition。
  let unitIds: string[] = [];
  try {
    unitIds = JSON.parse(obs.context_unit_ids_json || '[]') as string[];
  } catch {
    /* 容错：当空处理 */
  }
  const units = unitIds
    .map((id) => getContextUnitById(id))
    .filter((u): u is ContextUnit => !!u);
  if (units.some((u) => HANDLED_KINDS.has(u.kind))) return settle('delegated_to_reducer');

  // ③ 选 unit：优先语义单元（state 等），否则 raw event 单元。
  const unit = units.find((u) => u.kind !== 'event') ?? units[0];
  if (!unit) return settle('skip:no_context_unit');

  // ④ 召回：实体轴 ∪ 标题轴，去重 cap 8。
  const ranked = scoreAndRank(unit, nowMs).map((r) => r.matter);
  const active = listMatters({
    statuses: ACTIVE_STATUSES,
    updatedSince: new Date(nowMs - 90 * 86400_000).toISOString(),
    limit: 100,
  });
  const titleHits = recallByTitle(obs.title, active);
  const seen = new Set<string>();
  const candidates: Matter[] = [];
  for (const m of [...ranked, ...titleHits]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    candidates.push(m);
    if (candidates.length >= CANDIDATE_CAP) break;
  }
  if (candidates.length === 0) return settle('skip:no_candidates', []);

  // ⑤ 判定+落地。观察标题/证据前置进 content（sketch 400 字截断内可见），id 不变
  // （applyDecision 用 unit.id 挂 matter_context_links / 继承实体）。
  const enriched: ContextUnit = {
    ...unit,
    content: `观察：${obs.title}\n证据：${obs.evidence}\n---\n${unit.content}`,
  };
  const res = await reduceUnitWithCandidates(enriched, candidates, { ...opts, now: nowMs });

  // judge 瞬时失败（provider 超时等）不销账：留给重启补扫重试。
  if (res.action === 'ignore' && res.reason.startsWith('judge failed')) {
    console.warn(`[matter-obs] ${observationId} judge 失败，留待补扫: ${res.reason.slice(0, 160)}`);
    return { observationId, result: 'pending_retry' };
  }

  const result = `${res.action}:${res.effect ?? 'none'}:${res.applied ? 'applied' : 'no_status_change'}`;
  if (res.applied) {
    console.log(
      `[matter-obs] 观察 ${observationId.slice(0, 8)}「${obs.title.slice(0, 30)}」→ matter ${res.matterId?.slice(0, 8)} ${res.effect}`
    );
  }
  return settle(result, candidates.map((c) => c.id));
}

/** triage 落库后的 fire-and-forget 入口：不阻塞批次收尾，失败仅日志。 */
export function consumeMatterObservationSoon(observationId: string): void {
  void consumeMatterObservation(observationId).catch((err) => {
    console.warn(
      `[matter-obs] consume ${observationId} failed:`,
      err instanceof Error ? err.message : String(err)
    );
  });
}

/**
 * 启动补扫：fire-and-forget 在进程重启时丢失的 in-flight 观察（consumed_at IS NULL）。
 * 串行消费（每条一次 LLM 判定，走 opencode 单并发闸门），窗口 48h、单轮上限 50。
 */
export async function recoverUnconsumedObservations(
  opts: ReduceOptions = {}
): Promise<{ scanned: number; consumed: number }> {
  const cutoff = new Date((opts.now ?? Date.now()) - RECOVERY_WINDOW_MS).toISOString();
  const rows = listUnconsumedMatterObservationRows(cutoff, RECOVERY_BATCH_LIMIT);
  let consumed = 0;
  for (const row of rows) {
    try {
      const out = await consumeMatterObservation(row.id, opts);
      if (out.result !== 'pending_retry') consumed++;
    } catch (err) {
      console.warn(
        `[matter-obs] recovery consume ${row.id} failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  if (rows.length > 0) {
    console.log(`[matter-obs] 启动补扫：扫描 ${rows.length} 条未消费观察，销账 ${consumed} 条`);
  }
  return { scanned: rows.length, consumed };
}
