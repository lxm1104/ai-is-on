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
import { config } from '../config.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { broadcast } from '../ws.js';
import { registerUpsertHook } from '../context/contextStore.js';
import { assembleGlobalContextPacket } from '../context/agentContextAssembler.js';
import { absolutizeRelativeDatesInTitle, titlesEquivalent } from './titleHygiene.js';
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
  markAttentionItemsSupersededForResolvedMatters,
  markAttentionItemsExpired,
  startEngineRun,
  finishEngineRun,
  writeTerminalEngineRun,
  findRecentSuccessfulRunByInputHash,
  nextGeneration,
  updateAttentionItemStatus,
  updateAttentionItemPriority,
} from './attentionStore.js';
import type {
  AttentionEngineRunSummary,
  AttentionInputSummary,
  AttentionRunTrigger,
} from './attentionTypes.js';

const TICK_INTERVAL_MS = 5 * 60_000;          // 5 分钟一次定时全量
const DEBOUNCE_MS = 60_000;                    // upsert hook debounce
const CACHE_TTL_MINUTES = 5;                   // input_hash 缓存窗口
// 比 triage 长，因为输入更大。实测 glm-5.1 单次 ~26k input 需要 ~104s（无竞争），
// 180s 时代 2026-06-09 失败率 87%：超时误杀 → fallback 重试翻倍负载 → 级联超时。
// 现默认 300s（ATTENTION_TIMEOUT_MS 可调），并发挤兑由 backgroundRuntime 全局闸门解决。
const ONE_SHOT_TIMEOUT_MS = config.attentionTimeoutMs;
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

  // 0.5) MVP28：清理绑定到已 resolved/dropped Matter 的旧卡（"已处理还在催"的最后一环）。
  const matterClearedCount = markAttentionItemsSupersededForResolvedMatters(startedAt);
  if (matterClearedCount > 0) {
    console.log(`[attention] superseded ${matterClearedCount} items bound to resolved/dropped matters`);
  }

  // 1) 组装 packet（currentLive cap 12：均值 ~70 chars/条，瘦身 packet 的一部分）
  const packet = assembleGlobalContextPacket();
  const currentLive = listLiveAttentionItems(12);
  const inputSummary: AttentionInputSummary = {
    subjectPresent: !!packet.subject,
    spacesCount: packet.spaces.length,
    goalsCount: packet.goals.length,
    commitmentsCount: packet.commitments.length,
    uncertaintiesCount: packet.uncertainties.length,
    recentEventsCount: packet.recentEvents.length,
    topActiveCount: packet.topActive.length,
    mattersCount: packet.matters.length,
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

  // 4) 先组 userMsg（纯函数），把真实输入长度记进 summary，再写 running 行
  const userMsg = buildAttentionUserMessage(packet, { currentLive });
  inputSummary.inputChars = userMsg.length;
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
        priority: true, // attention 是用户可感知引擎，闸门插队，不排在 triage/matter 后
        // turbo（thinking disabled，见 opencode.json）实测 13.4k 输入 15-94s；
        // glm-5.1 兜底质量。P0 从严标定见 attentionPrompt v2。
        model: config.attentionModel,
        fallbackModel: config.attentionFallbackModel,
      });
      llmText = shot.text;
      inputSummary.llmWaitMs = shot.timing.waitMs;
      inputSummary.llmExecMs = shot.timing.execMs;
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
      inputSummary,
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
      inputSummary,
    });
    console.warn('[attention] parse failed:', error.slice(0, 200));
    return summary(runId, generation, packet.inputHash, 'failed', 0, startedAt, completedAt, error);
  }

  // 6.5) 标题相对日期治理：prompt v3 禁了但 turbo 偶发不守，跨天即错；解析处确定性改写兜底。
  for (const it of llmItems) {
    const fixed = absolutizeRelativeDatesInTitle(it.title);
    if (fixed !== it.title) {
      console.warn(`[attention] 标题相对日期改写: "${it.title}" → "${fixed}"`);
      it.title = fixed;
    }
  }

  // 7) 幂等：把同 inputHash 的旧 live 标 superseded（即便我们刚跑、cache 没命中，
  //    也可能因为上一轮成功且数据没变；我们用 inputHash 而不是 time 来判同源）。
  const persistAt = new Date().toISOString();
  const sameHashSupersededCount = markAttentionItemsSupersededByHash(packet.inputHash, persistAt);

  // 7.5) 用 LLM 给的 supersedeIds，把它点名的旧 item（可能来自其他 inputHash 代）也标 superseded。
  //      同时识别 "supersede-only" item：title='supersede' 的 item 只执行清理，不落新行。
  //      churn guard（2026-06-10）：turbo 无 thinking 模式倾向每轮全量重发（实测 1h 内 29 条 superseded，
  //      看板 created_at 全被重置、用户状态丢失）。若新卡与被替代旧卡**等价**
  //      （同 priority + 同 matterId 或同 signal 集合），视为「保留」：不灭旧卡、不发新卡。
  const liveIds = new Set(currentLive.map((x) => x.id));
  let llmDrivenSupersededCount = 0;
  let keptAsEquivalentCount = 0;
  const itemsToPersist: typeof llmItems = [];

  // 提案卡/系统卡（办结确认 proposal:*、授权失效/采集停滞 system:*）生命周期归各自服务管：
  // 用户动作、matter resolve、看门狗恢复才能动它们。LLM 点名替代与防抖等价机制一律无权染指
  // —— 2026-06-12 实测首张办结提案升起 20 分钟即被「优先级升级替代」误杀（同 matter 的
  // P0 催办卡与 P1 提案卡被判定等价）。
  const liveById = new Map(currentLive.map((x) => [x.id, x]));
  const isProtectedCard = (x: { inputHash: string }) =>
    x.inputHash.startsWith('proposal:') || x.inputHash.startsWith('system:');

  // 内容等价 = 同 matterId，或 signal 集合完全一致，或标题归一化全等（churn guard v2）。
  // 不同 matterId 是硬否决（即使标题相同也不合并）。
  const contentEquivalent = (
    old: (typeof currentLive)[number],
    it: (typeof llmItems)[number]
  ) => {
    if (old.matterId && it.matterId) return old.matterId === it.matterId;
    const a = [...old.signalIds].sort().join(',');
    const b = [...(it.signalIds ?? [])].sort().join(',');
    if (a !== '' && a === b) return true;
    // v2：模型重发时 signalIds 常略有出入 → 仅靠集合等价判不出「同一张卡」，
    // 实测 5min 内同标题卡成对 superseded+新建（洗牌）。标题全等兜底。
    return titlesEquivalent(old.title, it.title);
  };
  // 等价（含 priority）→「保留旧卡」；仅内容等价但 priority 变了 →「升级」：
  // 自动替掉旧卡（即使模型忘了声明 supersedeIds —— 2026-06-11 实测 P2→P1 升级产生跨优先级双卡）。
  const findEquivalentLive = (it: (typeof llmItems)[number]) =>
    currentLive.find(
      (old) => !isProtectedCard(old) && old.priority === it.priority && contentEquivalent(old, it)
    );
  const findPriorityShiftedLive = (it: (typeof llmItems)[number]) =>
    currentLive.filter(
      (old) => !isProtectedCard(old) && old.priority !== it.priority && contentEquivalent(old, it)
    );

  for (const it of llmItems) {
    // 受保护卡从 LLM 点名替代里剔除（liveById 必含，因为 sIds 已过 liveIds 过滤）
    const sIds = (it.supersedeIds ?? []).filter(
      (id) => liveIds.has(id) && !isProtectedCard(liveById.get(id)!)
    );
    // 宽匹配：模型常写 "supersede 已过期的XX" 带后缀（2026-06-11 实测泄漏成真卡），
    // 只要以 supersede 开头且带 supersedeIds 就视为清理指令。
    // 以 supersede 开头的 title 永远是清理指令、绝不落地成真卡 —— 不再要求带
    // supersedeIds（2026-06-12 实测模型发过不带 ids 的「supersede: 清理…」，
    // 旧条件漏成了用户可见的 P3 卡；没 ids 就当 no-op 丢弃）。
    const titleLower = it.title.trim().toLowerCase();
    const isSupersedeOnly = titleLower.startsWith('supersede');

    if (!isSupersedeOnly) {
      // 对照**所有** live 卡（不只 supersedeIds 指到的）：模型重发时常忘了声明替代，
      // 实测产生过同内容双卡（2026-06-10「CLI 能力开放」）。
      const equivalentOld = findEquivalentLive(it);
      if (equivalentOld) {
        keptAsEquivalentCount++;
        // 等价旧卡保留原状。注意：step 7 的 same-hash supersede 可能已把它标为 superseded，
        // 需要恢复回 live（否则"保留"变成"双重清除"：hash supersede 掉、新卡也被丢弃）。
        updateAttentionItemStatus(equivalentOld.id, 'live', persistAt);
        // 模型点名替代的其它旧卡照常清理（那是真过时的）。
        for (const oldId of sIds) {
          if (oldId === equivalentOld.id) continue;
          updateAttentionItemStatus(oldId, 'superseded', persistAt);
          llmDrivenSupersededCount++;
        }
        continue; // 新卡丢弃
      }
    }

    if (!isSupersedeOnly) {
      // churn guard v2：内容等价但 priority 变了 → 原地升降级，保卡片身份
      //（id/created_at/用户状态），不再「杀旧建新」。旧版的杀旧建新在 2026-06-12
      // 实测导致每轮洗牌（同标题卡成对 superseded+重建）。
      const shifted = findPriorityShiftedLive(it);
      if (shifted.length > 0) {
        const keep = shifted[0];
        updateAttentionItemStatus(keep.id, 'live', persistAt); // 可能已被 same-hash supersede，先恢复
        updateAttentionItemPriority(keep.id, it.priority, persistAt);
        keptAsEquivalentCount++;
        for (const oldId of sIds) {
          if (oldId === keep.id) continue;
          updateAttentionItemStatus(oldId, 'superseded', persistAt);
          llmDrivenSupersededCount++;
        }
        // 同内容多张旧卡（真双卡）只留一张
        for (const extra of shifted.slice(1)) {
          if (sIds.includes(extra.id)) continue; // 已替过
          updateAttentionItemStatus(extra.id, 'superseded', persistAt);
          llmDrivenSupersededCount++;
        }
        continue; // 新卡丢弃，身份保留在旧卡上
      }
    }

    for (const oldId of sIds) {
      updateAttentionItemStatus(oldId, 'superseded', persistAt);
      llmDrivenSupersededCount++;
    }
    if (!isSupersedeOnly) {
      itemsToPersist.push(it);
    }
  }
  if (keptAsEquivalentCount > 0) {
    console.log(`[attention] churn guard kept ${keptAsEquivalentCount} equivalent item(s) unchanged`);
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
    inputSummary,
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
