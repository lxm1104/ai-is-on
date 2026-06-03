/**
 * MVP5 飞书任务 collector。
 *
 * 把用户在飞书里的任务（get-my-tasks 指派给我 ∪ get-related-tasks 我创建/关注）
 * 采集成 kind='commitment' 的 ContextUnit，挂 {type:'task', name:'lark_task:<guid>'} entity，
 * mergeHint='lark_task:<guid>'。装配层（agentContextAssembler）会把这些归入独立 tasks slice。
 *
 * 与 larkOrgCollector 同模式：collect() 内部 side-effect 写库、返回空 RawSignal[]
 * （任务是状态单位、不是事件，不该走 events / triage 流）。
 *
 * 生命周期（集合差对账）：
 *   1. 每轮拉「未完成全集」liveGuids；
 *   2. 每个任务 → upsertContextUnit（active，mergeHint 命中则原地 update，与卡片路径去重）；
 *   3. 本地所有 active 飞书任务 commitment，guid 不在 liveGuids 里的 → 标 superseded
 *      （已完成或已删除，对 attention 等价）。
 *   ⚠️ 对账只在两路 fetch 都成功后才跑——任一 fetch 抛错则整轮 throw、不对账，
 *      避免 API 抖动把本地任务误标完成。
 *
 * 时间归一：get-my-tasks 的 created_at/due_at 是带时区 ISO8601；
 * get-related-tasks 是「YYYY-MM-DD HH:MM:SS」无时区——按 +08:00 解释后统一成 ISO。
 */

import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { upsertContextUnit, getContextUnitById } from '../context/contextStore.js';
import { updateContextUnit, listActiveLarkTaskCommitmentRows } from '../db.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import type { Collector, RawSignal } from './types.js';

const COLLECTOR_NAME = 'larkTask';
const TASK_ENTITY_PREFIX = 'lark_task:';

type LarkTaskItem = {
  guid?: string;
  summary?: string;
  url?: string;
  created_at?: string;
  due_at?: string;
};

type TasksResp = {
  ok?: boolean;
  data?: { items?: LarkTaskItem[]; has_more?: boolean };
};

type LarkTaskDeps = {
  runLarkCliJson?: <T = unknown>(args: string[]) => Promise<T>;
};

export const larkTaskCollector: Collector = {
  name: COLLECTOR_NAME,
  intervalMs: config.taskIntervalMs,
  async collect(): Promise<RawSignal[]> {
    await runLarkTaskSync();
    return [];
  },
};

export type LarkTaskSyncResult = {
  fetched: number;
  upserted: number;
  superseded: number;
};

export async function runLarkTaskSync(
  deps: LarkTaskDeps = {}
): Promise<LarkTaskSyncResult> {
  const runJson =
    (deps.runLarkCliJson as typeof runLarkCliJson | undefined) ?? runLarkCliJson;

  // 1) 两路拉未完成全集（任一抛错 → 整个 sync 抛，不进对账）
  const [mine, related] = await Promise.all([
    fetchMyIncompleteTasks(runJson),
    fetchRelatedCreatedByMeIncompleteTasks(runJson),
  ]);

  // 2) 按 guid 去重合并；liveGuids 收录所有 fetch 到的 guid（含被噪声过滤掉的，
  //    避免对账时把"还活着但被过滤"的任务误标完成）。
  const byGuid = new Map<string, LarkTaskItem>();
  const liveGuids = new Set<string>();
  for (const item of [...mine, ...related]) {
    const guid = item.guid?.trim();
    if (!guid) continue;
    liveGuids.add(guid);
    if (!byGuid.has(guid)) byGuid.set(guid, item);
  }

  // 3) upsert（cap 保护）
  let upserted = 0;
  const items = [...byGuid.values()].slice(0, config.taskMaxPerTick);
  for (const item of items) {
    if (upsertTaskCommitment(item)) upserted++;
  }

  // 4) 集合差对账：本地 active 飞书任务 commitment，不在 liveGuids 里 → superseded
  const superseded = reconcileCompletedTasks(liveGuids);

  console.log(
    `[collectors] ${COLLECTOR_NAME}: fetched=${liveGuids.size} ` +
      `(my=${mine.length}, related=${related.length}) upserted=${upserted} superseded=${superseded}`
  );
  return { fetched: liveGuids.size, upserted, superseded };
}

// --------------------------------------------------------------------------
// fetch
// --------------------------------------------------------------------------

async function fetchMyIncompleteTasks(
  runJson: typeof runLarkCliJson
): Promise<LarkTaskItem[]> {
  const resp = await runJson<TasksResp>([
    'task',
    '+get-my-tasks',
    '--as',
    'user',
    '--complete=false',
    '--page-all',
    '--format',
    'json',
  ]);
  if (!resp || resp.ok === false) {
    throw new Error('get-my-tasks 返回 ok=false');
  }
  return resp.data?.items ?? [];
}

async function fetchRelatedCreatedByMeIncompleteTasks(
  runJson: typeof runLarkCliJson
): Promise<LarkTaskItem[]> {
  const resp = await runJson<TasksResp>([
    'task',
    '+get-related-tasks',
    '--as',
    'user',
    '--created-by-me',
    '--include-complete=false',
    '--page-all',
    '--format',
    'json',
  ]);
  if (!resp || resp.ok === false) {
    throw new Error('get-related-tasks 返回 ok=false');
  }
  return resp.data?.items ?? [];
}

// --------------------------------------------------------------------------
// upsert
// --------------------------------------------------------------------------

/** 返回 true=已 upsert，false=被噪声过滤跳过。 */
function upsertTaskCommitment(item: LarkTaskItem): boolean {
  const guid = item.guid?.trim();
  if (!guid) return false;
  const summary = cleanSummary(item.summary);
  if (!summary) return false; // 纯图片占位 / 空标题 → 不落库

  const url = item.url?.trim() || undefined;
  const dueAt = normalizeLarkTime(item.due_at);

  const entities: ContextEntityRef[] = [
    {
      type: 'task',
      name: `${TASK_ENTITY_PREFIX}${guid}`,
      aliases: url ? [url] : undefined,
      role: 'target',
      confidence: 1.0,
    },
  ];

  upsertContextUnit({
    kind: 'commitment',
    title: summary,
    content: `飞书任务：${summary}${url ? `\n链接：${url}` : ''}`,
    entities,
    scope: 'work',
    origin: { kind: 'system', refId: `${TASK_ENTITY_PREFIX}${guid}` },
    time: dueAt ? { dueAt } : undefined,
    actionability: 'act',
    confidence: 0.9,
    mergeHint: `${TASK_ENTITY_PREFIX}${guid}`,
  });
  return true;
}

// --------------------------------------------------------------------------
// reconcile（集合差）
// --------------------------------------------------------------------------

function reconcileCompletedTasks(liveGuids: Set<string>): number {
  const rows = listActiveLarkTaskCommitmentRows();
  const nowIso = new Date().toISOString();
  let superseded = 0;
  for (const row of rows) {
    // 取 task entity 拿 guid（origin_ref_id 对卡片路径不是 guid，不能依赖）
    const unit = getContextUnitById(row.id);
    if (!unit) continue;
    const taskEntity = unit.entities.find(
      (e) => e.type === 'task' && e.name.startsWith(TASK_ENTITY_PREFIX)
    );
    if (!taskEntity) continue;
    const guid = taskEntity.name.slice(TASK_ENTITY_PREFIX.length);
    if (liveGuids.has(guid)) continue; // 仍未完成
    updateContextUnit({
      ...row,
      status: 'superseded',
      version: row.version + 1,
      updated_at: nowIso,
    });
    superseded++;
  }
  return superseded;
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** 去掉 [图片] 占位、压缩空白；返回 trim 后的纯文本（可能为空）。 */
function cleanSummary(raw?: string): string {
  return (raw ?? '')
    .replace(/\[图片\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 归一飞书任务时间：
 *  - 「YYYY-MM-DD HH:MM:SS」无时区 → 按 +08:00 解释；
 *  - 其余（带时区 ISO8601 等）→ Date.parse 兜底；
 *  - 解析失败 → undefined。
 */
export function normalizeLarkTime(raw?: string): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const v = raw.trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
