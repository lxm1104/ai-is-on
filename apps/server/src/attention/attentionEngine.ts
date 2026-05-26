// MVP14 Attention Engine — 主循环。
//
// runAttentionTick()：
//   1. assembleGlobalContextPacket()
//   2. 查 5min 内同 inputHash 的成功 run → cache_hit 直接返回
//   3. buildAttentionUserMessage + runOneShot(ATTENTION_SYSTEM_PROMPT)
//   4. parseAttentionOutput
//   5. markAttentionItemsSupersededByHash（幂等重跑保护）
//   6. 批量 insertAttentionItem
//   7. finishEngineRun(status=ok) + broadcast 'attention_updated'
//
// 调度（任务 8 会接进 index.ts）：
//   - startAttentionScheduler()：boot 后 30s 跑首次，之后每 5 分钟跑一次
//   - 同时挂 contextStore upsert hook，debounce 60s 后跑一次
//   - input_hash 5min cache 兜底，重复触发不会重复出钱

import { randomUUID } from 'node:crypto';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { broadcast } from '../ws.js';
import { registerUpsertHook } from '../context/contextStore.js';
import { assembleGlobalContextPacket } from '../context/agentContextAssembler.js';
import {
  ATTENTION_SYSTEM_PROMPT,
  ATTENTION_PROMPT_VERSION,
  buildAttentionUserMessage,
  parseAttentionOutput,
} from './attentionPrompt.js';
import {
  insertAttentionItem,
  listLiveAttentionItems,
  markAttentionItemsSupersededByHash,
  markAttentionItemsExpired,
  startEngineRun,
  finishEngineRun,
  writeTerminalEngineRun,
  findRecentSuccessfulRunByInputHash,
  nextGeneration,
  updateAttentionItemStatus,
} from './attentionStore.js';
import type {
  AttentionEngineRunSummary,
  AttentionInputSummary,
  AttentionRunTrigger,
} from './attentionTypes.js';

const TICK_INTERVAL_MS = 5 * 60_000;          // 5 分钟一次定时全量
const DEBOUNCE_MS = 60_000;                    // upsert hook debounce
const CACHE_TTL_MINUTES = 5;                   // input_hash 缓存窗口
const ONE_SHOT_TIMEOUT_MS = 180_000;           // 比 triage 长，因为输入更大；85 分钟实跑 3/23 ≈ 13% 超时，从 120s 提到 180s
const ITEM_TTL_HOURS = 24;                     // 兜底：超过 24h 还在 live 的 items 自动 expire

let tickTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<AttentionEngineRunSummary> | null = null;
let lastSuccessAt = 0;

// --------------------------------------------------------------------------
// 核心入口
// --------------------------------------------------------------------------

export type RunAttentionTickOpts = {
  trigger?: AttentionRunTrigger;
  /** 测试钩子：传入则跳过 runOneShot，直接用此函数返回 LLM 文本。 */
  llmHook?: (userMessage: string, systemPrompt: string) => Promise<string>;
};

/**
 * 跑一次 attention tick。
 * 全程串行：同时只允许一个 inFlight，第二次调用会复用同一 Promise。
 */
export function runAttentionTick(
  opts: RunAttentionTickOpts = {}
): Promise<AttentionEngineRunSummary> {
  if (inFlight) return inFlight;
  inFlight = doRunAttentionTick(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRunAttentionTick(
  opts: RunAttentionTickOpts
): Promise<AttentionEngineRunSummary> {
  const trigger = opts.trigger ?? 'manual';
  const runId = randomUUID();
  const generation = nextGeneration();
  const startedAt = new Date().toISOString();

  // 0) TTL 兜底：把 24h 前还在 live 的 item 标 expired
  const ttlCutoff = new Date(Date.now() - ITEM_TTL_HOURS * 3600_000).toISOString();
  const expiredCount = markAttentionItemsExpired(ttlCutoff, startedAt);
  if (expiredCount > 0) {
    console.log(`[attention] TTL expired ${expiredCount} items older than ${ITEM_TTL_HOURS}h`);
  }

  // 1) 组装 packet
  const packet = assembleGlobalContextPacket();
  const currentLive = listLiveAttentionItems(20);
  const inputSummary: AttentionInputSummary = {
    subjectPresent: !!packet.subject,
    spacesCount: packet.spaces.length,
    goalsCount: packet.goals.length,
    commitmentsCount: packet.commitments.length,
    uncertaintiesCount: packet.uncertainties.length,
    recentEventsCount: packet.recentEvents.length,
    topActiveCount: packet.topActive.length,
    stakeholdersCount: packet.stakeholders.length,
    preferencesCount: packet.preferences.length,
    boundaryRulesCount: packet.boundaryRules.length,
    attentionInteractionsCount: packet.attentionInteractions.length,
    liveAttentionCount: currentLive.length,
    tokenEstimate: packet.tokenEstimate,
  };

  // 2) Bootstrap 未完且数据极少 → skip
  if (
    !packet.bootstrapped &&
    packet.topActive.length === 0 &&
    packet.commitments.length === 0 &&
    packet.recentEvents.length === 0
  ) {
    const completedAt = new Date().toISOString();
    writeTerminalEngineRun({
      id: runId,
      generation,
      trigger,
      inputHash: packet.inputHash,
      inputSummary,
      promptVersion: ATTENTION_PROMPT_VERSION,
      status: 'skipped_no_change',
      startedAt,
      completedAt,
    });
    return summary(runId, generation, packet.inputHash, 'skipped_no_change', 0, startedAt, completedAt);
  }

  // 3) cache 命中检查
  const cached = findRecentSuccessfulRunByInputHash(packet.inputHash, CACHE_TTL_MINUTES);
  if (cached) {
    const completedAt = new Date().toISOString();
    writeTerminalEngineRun({
      id: runId,
      generation,
      trigger,
      inputHash: packet.inputHash,
      inputSummary,
      promptVersion: ATTENTION_PROMPT_VERSION,
      status: 'cache_hit',
      startedAt,
      completedAt,
    });
    return summary(runId, generation, packet.inputHash, 'cache_hit', 0, startedAt, completedAt);
  }

  // 4) 先写 running 行（status 占位 ok，最后由 finishEngineRun 覆盖）
  startEngineRun({
    id: runId,
    generation,
    trigger,
    inputHash: packet.inputHash,
    inputSummary,
    promptVersion: ATTENTION_PROMPT_VERSION,
    startedAt,
  });

  // 5) 调 LLM
  const userMsg = buildAttentionUserMessage(packet, { currentLive });
  let llmText: string;
  let modelId: string | null = null;
  try {
    if (opts.llmHook) {
      llmText = await opts.llmHook(userMsg, ATTENTION_SYSTEM_PROMPT);
    } else {
      const shot = await runOneShot(userMsg, {
        agentName: 'aiisn-attention',
        systemPrompt: ATTENTION_SYSTEM_PROMPT,
        timeoutMs: ONE_SHOT_TIMEOUT_MS,
      });
      llmText = shot.text;
      const raw = shot.raw as Record<string, unknown> | null;
      if (raw && typeof raw.model === 'string') {
        modelId = raw.model;
      }
    }
  } catch (err) {
    const completedAt = new Date().toISOString();
    const error = err instanceof Error ? err.message : String(err);
    finishEngineRun({
      id: runId,
      status: 'failed',
      itemsEmitted: 0,
      error,
      completedAt,
    });
    console.warn('[attention] runOneShot failed:', error.slice(0, 300));
    return summary(runId, generation, packet.inputHash, 'failed', 0, startedAt, completedAt, error);
  }

  // 6) 解析
  let llmItems;
  try {
    llmItems = parseAttentionOutput(llmText);
  } catch (err) {
    const completedAt = new Date().toISOString();
    const error = err instanceof Error ? err.message : String(err);
    finishEngineRun({
      id: runId,
      status: 'failed',
      itemsEmitted: 0,
      outputText: llmText.slice(0, 4000),
      modelId,
      error,
      completedAt,
    });
    console.warn('[attention] parse failed:', error.slice(0, 200));
    return summary(runId, generation, packet.inputHash, 'failed', 0, startedAt, completedAt, error);
  }

  // 7) 幂等：把同 inputHash 的旧 live 标 superseded（即便我们刚跑、cache 没命中，
  //    也可能因为上一轮成功且数据没变；我们用 inputHash 而不是 time 来判同源）。
  const persistAt = new Date().toISOString();
  const sameHashSupersededCount = markAttentionItemsSupersededByHash(packet.inputHash, persistAt);

  // 7.5) 用 LLM 给的 supersedeIds，把它点名的旧 item（可能来自其他 inputHash 代）也标 superseded。
  //      同时识别 "supersede-only" item：title='supersede' 的 item 只执行清理，不落新行。
  const liveIds = new Set(currentLive.map((x) => x.id));
  let llmDrivenSupersededCount = 0;
  const itemsToPersist: typeof llmItems = [];
  for (const it of llmItems) {
    const sIds = (it.supersedeIds ?? []).filter((id) => liveIds.has(id));
    for (const oldId of sIds) {
      updateAttentionItemStatus(oldId, 'superseded', persistAt);
      llmDrivenSupersededCount++;
    }
    const isSupersedeOnly = it.title.trim().toLowerCase() === 'supersede';
    if (!isSupersedeOnly) itemsToPersist.push(it);
  }

  // 8) 批量插入新 items（不含 supersede-only）
  for (const it of itemsToPersist) {
    insertAttentionItem({
      id: randomUUID(),
      generation,
      llmRunId: runId,
      inputHash: packet.inputHash,
      llmItem: it,
      now: persistAt,
    });
  }

  // 9) 写 run 完成行（items_emitted 记的是真正落库的，不含 supersede-only）
  const completedAt = new Date().toISOString();
  finishEngineRun({
    id: runId,
    status: 'ok',
    itemsEmitted: itemsToPersist.length,
    outputText: llmText.slice(0, 8000), // 留底
    modelId,
    completedAt,
  });

  lastSuccessAt = Date.now();

  // 10) 广播（只在确实有产出时；避免 WS 风暴）
  if (itemsToPersist.length > 0) {
    try {
      broadcast({
        type: 'attention_updated',
        generation,
        itemsEmitted: itemsToPersist.length,
      });
    } catch {}
  }

  const totalSuperseded = sameHashSupersededCount + llmDrivenSupersededCount;
  console.log(
    `[attention] tick generation=${generation} items=${itemsToPersist.length} ` +
      `superseded=${totalSuperseded}(hash=${sameHashSupersededCount}, llm=${llmDrivenSupersededCount}) ` +
      `trigger=${trigger} hash=${packet.inputHash.slice(0, 8)}`
  );

  return summary(runId, generation, packet.inputHash, 'ok', itemsToPersist.length, startedAt, completedAt);
}

function summary(
  runId: string,
  generation: number,
  inputHash: string,
  status: AttentionEngineRunSummary['status'],
  itemsEmitted: number,
  startedAt: string,
  completedAt: string | null,
  error?: string
): AttentionEngineRunSummary {
  return { runId, generation, status, itemsEmitted, inputHash, startedAt, completedAt, error };
}

// --------------------------------------------------------------------------
// 调度
// --------------------------------------------------------------------------

/**
 * MVP14 Step 4：用户反馈触发后调，10s 后跑一次 tick，让 attention 输出反映新 L1。
 * 复用 debounce 逻辑：如果已经有 debouncedTimer 在跑就让它继续。
 */
export function enqueueAttentionTickSoon(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    safeTick('upsert_hook');
  }, 10_000);
  debounceTimer.unref?.();
}

export function startAttentionScheduler(): void {
  if (tickTimer) {
    console.warn('[attention] scheduler already started, ignoring');
    return;
  }
  // boot 后 30s 跑首次，让 collectors 先进一波数据
  setTimeout(() => safeTick('tick'), 30_000);
  tickTimer = setInterval(() => safeTick('tick'), TICK_INTERVAL_MS);

  // contextStore upsert hook：debounce 60s 跑一次
  registerUpsertHook(() => scheduleDebouncedTick());

  console.log(
    `[attention] scheduler started; first tick in 30s, then every ${TICK_INTERVAL_MS / 1000}s; ` +
      `upsert hook debounced ${DEBOUNCE_MS / 1000}s`
  );
}

export function stopAttentionScheduler(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
}

function scheduleDebouncedTick(): void {
  // 如果一次 tick 刚跑完不到 60s，等够 60s 再跑
  const since = Date.now() - lastSuccessAt;
  const wait = Math.max(0, DEBOUNCE_MS - since);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    safeTick('upsert_hook');
  }, wait);
  debounceTimer.unref?.();
}

function safeTick(trigger: AttentionRunTrigger): void {
  void runAttentionTick({ trigger }).catch((err) => {
    console.warn(
      '[attention] tick crashed:',
      err instanceof Error ? err.message : String(err)
    );
  });
}
