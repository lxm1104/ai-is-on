// MVP14 Step 3: 原 triage→cards 流水线已下线。
// 这个文件保留 contextUpdates 的提取链路（"context enrichment"）：
//   raw event → LLM 抽 contextUpdates → 写 context_units (kind=state/goal/commitment/...)
// L2 Attention engine 完全依赖这条富化链给 packet 喂料；没有它 commitments/uncertainties 会枯竭。
// 已删：insertTriageResult / createCardsFromTriage。triage_results、cards(source_kind='triage') 两表不再被写入。
//
// 文件名暂保留为 triageQueue.ts（rename 影响面大，留作下一轮清理）。
import { config } from '../config.js';
import {
  db,
  type EventRow,
  listActiveUserRules,
  markEventContextExtracted,
  markEventProcessed,
  resolveProjectCanonical,
  upsertProjectCanonicalProposal,
} from '../db.js';
import { buildTriageUserMessage } from './triagePrompt.js';
import { runTriageOnce } from './backgroundRuntime.js';
import {
  parseTriageResult,
  type ProposedNewProject,
  type TriageItem,
} from './parseTriage.js';
import {
  findEventContextUnitId,
  linkContextUnits,
  upsertContextUnit,
} from '../context/contextStore.js';
import type { ContextEntityRef, ContextScope } from '../context/ContextUnit.js';
import { isCaringPaused } from '../caring/caringSettings.js';

function scopeForEvent(ev: EventRow): ContextScope {
  switch (ev.source) {
    case 'calendar':
    case 'im':
    case 'mail':
    case 'drive':
      return 'work';
    case 'manual':
      return 'personal';
    default:
      return 'work';
  }
}

type QueueItem = { events: EventRow[] };

const queue: QueueItem[] = [];
let running = false;

export function enqueueEvents(events: EventRow[]) {
  if (events.length === 0) return;
  const batchSize = Math.max(1, config.triageBatchSize);
  for (let i = 0; i < events.length; i += batchSize) {
    queue.push({ events: events.slice(i, i + batchSize) });
  }
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await processBatch(item.events);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[triage] batch failed (${item.events.length} events). prompt~${Math.round(estimatePromptBytes(item.events) / 1024)}KB. error:\n${msg}`
        );
        // still mark as processed so we don't spin forever
        for (const ev of item.events) markEventProcessed(ev.id, new Date().toISOString());
      }
    }
  } finally {
    running = false;
  }
}

function estimatePromptBytes(events: EventRow[]): number {
  let n = 0;
  for (const e of events) n += (e.text?.length ?? 0) + (e.title?.length ?? 0) + 64;
  return n;
}

const RETRYABLE_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /fetch failed/i,
  /rate.?limit/i,
  /overloaded/i,
  /529/i, // anthropic overloaded
  /502 Bad Gateway/i,
  /503 Service Unavailable/i,
];

function shouldRetry(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE_PATTERNS.some((re) => re.test(msg));
}

async function processBatch(events: EventRow[]) {
  const rules = listActiveUserRules();
  const caringPaused = isCaringPaused();
  const user = buildTriageUserMessage({
    signals: events.map((e) => ({
      id: e.id,
      source: e.source,
      kind: e.kind,
      occurredAt: e.occurred_at,
      title: e.title,
      text: e.text,
      actor: e.actor,
      url: e.url,
    })),
    userRules: rules.map((r) => ({ description: r.description })),
    caringPaused,
  });

  let text: string;
  try {
    text = (await runTriageOnce(user)).text;
  } catch (err) {
    if (!shouldRetry(err)) throw err;
    console.warn(
      `[triage] retrying once after transient error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`
    );
    await new Promise((r) => setTimeout(r, 1500));
    text = (await runTriageOnce(user)).text;
  }

  let parsed: ReturnType<typeof parseTriageResult>;
  try {
    parsed = parseTriageResult(text);
  } catch (err) {
    console.error(
      '[triage] parse failed:',
      err instanceof Error ? err.message : String(err),
      '\n--- raw ---\n',
      text.slice(0, 1000)
    );
    for (const ev of events) markEventProcessed(ev.id, new Date().toISOString());
    return;
  }

  const eventById = new Map<string, EventRow>();
  for (const ev of events) eventById.set(ev.id, ev);

  for (const item of parsed.items) {
    const ev = eventById.get(item.sourceEventId);
    if (!ev) continue;
    persistOne(ev, item);
  }
  for (const ev of events) markEventProcessed(ev.id, new Date().toISOString());
}

// MVP14 Step 3: 只保留 contextUpdates 落库，不再写 triage_results / cards。
// LLM 输出里的 priority/title/summary/reason/cardActions 字段在 enrichment 链路里被丢弃；
// "现在该看什么、为什么"现在由 attentionEngine 全局推理产出。
function persistOne(ev: EventRow, item: TriageItem) {
  try {
    persistContextUpdates(ev, item);
  } catch (err) {
    console.warn(
      `[context] persist contextUpdates failed for event ${ev.id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

function persistContextUpdates(ev: EventRow, item: TriageItem) {
  if (!item.contextUpdates || item.contextUpdates.length === 0) {
    // 即便没有 contextUpdates，item.proposedNewProjects 仍可能需要落库
    persistProposedNewProjects(ev, item, []);
    return;
  }
  const scope = scopeForEvent(ev);
  const eventCtxId = findEventContextUnitId(ev.id);
  const createdUnitIds: string[] = [];
  // MVP19：闭词表兜底——LLM 抗指令时把不在 knownProjects 里的 project entity
  // 收集起来，写完单元后转 proposal。按 name 去重，避免多 unit 含相同未知 project 时重复写。
  const fallbackProposals = new Map<string, ProposedNewProject>();

  for (const draft of item.contextUpdates) {
    // MVP12 §4.1 P1.4：过滤 LLM 误产出的 type:'chat' / type:'app'。
    // chat 路由证据只在 raw event ContextUnit 上保留；写进 semantic unit 会污染 mergeKey。
    // doc 保留（commitment 的真实语义对象可以是 doc）。
    let filtered: ContextEntityRef[] | undefined = draft.entities
      ? draft.entities.filter((e) => e.type !== 'chat' && e.type !== 'app')
      : draft.entities;

    // MVP19：project entity 必须命中 knownProjects（resolveProjectCanonical 返回值 !== 原名）。
    // 命中失败的剔除 + 合成 fallback proposal。
    if (filtered) {
      const kept: ContextEntityRef[] = [];
      for (const e of filtered) {
        if (e.type === 'project') {
          const canonical = resolveProjectCanonical(e.name);
          if (canonical === e.name) {
            // 没在注册表里命中（命中后 canonical 会变成存储原大小写或别名归一名；
            // 这里粗判：返回值就是原 input 时算未命中）。
            // 边界：canonical 名跟 input 拼写完全相同也算命中——此时 canonical === input，
            // 但该 canonical 行确实存在；不会被误打到 fallback。我们通过单独查一次确认。
            const exists = projectCanonicalExists(e.name);
            if (!exists) {
              if (!fallbackProposals.has(e.name)) {
                fallbackProposals.set(e.name, {
                  name: e.name,
                  evidence: `triage 抽出但 knownProjects 未命中 (event=${ev.id.slice(0, 8)})`,
                });
              }
              continue; // 不写进 entities
            }
          }
        }
        kept.push(e);
      }
      filtered = kept;
    }

    const cleanedDraft = { ...draft, entities: filtered };
    const { unit } = upsertContextUnit({
      ...cleanedDraft,
      scope,
      origin: { kind: 'event', refId: ev.id },
    });
    createdUnitIds.push(unit.id);
    if (eventCtxId && eventCtxId !== unit.id) {
      try {
        linkContextUnits(eventCtxId, unit.id, 'updates', 0.8);
      } catch (err) {
        // 同一对 link 重复创建：忽略，不阻塞
        console.warn(
          `[context] link create failed (event→unit):`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  // MVP19：fallback + LLM 明示的 proposedNewProjects 一并落 proposal 队列
  if (fallbackProposals.size > 0) {
    for (const p of fallbackProposals.values()) {
      writeProposalSafe(p, createdUnitIds, ev.id);
    }
  }
  persistProposedNewProjects(ev, item, createdUnitIds);

  // MVP2.1: triage 已经为这条 event 完成了 context 富化
  markEventContextExtracted(ev.id, new Date().toISOString());
}

function persistProposedNewProjects(
  ev: EventRow,
  item: TriageItem,
  createdUnitIds: string[]
) {
  if (!item.proposedNewProjects || item.proposedNewProjects.length === 0) return;
  for (const p of item.proposedNewProjects) {
    writeProposalSafe(p, createdUnitIds, ev.id);
  }
}

function writeProposalSafe(
  p: ProposedNewProject,
  sourceUnitIds: string[],
  sourceEventId: string
) {
  try {
    upsertProjectCanonicalProposal({
      proposedName: p.name,
      sourceUnitIds,
      sourceEventId,
    });
  } catch (err) {
    console.warn(
      `[triage] proposal upsert failed for "${p.name}":`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * MVP19：判断给定名字是否对应到注册表里一行 canonical（包括 alias 命中且 canonical 拼写
 * 跟 input 一致的边界情况）。
 *
 * 背景：resolveProjectCanonical 在"未命中"和"命中且 canonical===input"两种情形下都
 * 返回原 input。本函数额外查一次 canonical_name=input 来区分。
 */
function projectCanonicalExists(name: string): boolean {
  const r = db
    .prepare(`SELECT 1 AS x FROM org_project_taxonomy WHERE canonical_name = ?`)
    .get(name) as { x: number } | undefined;
  return !!r;
}
