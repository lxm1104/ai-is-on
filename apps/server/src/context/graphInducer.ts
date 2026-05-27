/**
 * MVP15A §7.6 — Graph inducer orchestrator。
 *
 * 顺序至关重要（详 §7.2.1）：
 *   1. projectTaxonomy (LLM 缓存) —— 没它 personProject 用原 entity 名
 *   2. personProject —— 写 entity_edges (kind='person_project')
 *   3. personPerson —— 依赖 personProject 算 sharedProjectCanonicalNames
 *   4. workItem follows —— 完全独立
 *   5. purgeStaleEdges —— 清理 90 天没碰过的边（dryRun 默认 true）
 *
 * Throttle: 5 分钟。/api/graph/* 路由懒触发；server boot 后 10s 异步预热。
 */

import {
  refreshProjectTaxonomyIfNeeded,
  type RefreshResult,
} from '../util/projectTaxonomy.js';
import { inducePersonProjectEdges } from './personProjectInducer.js';
import { inducePersonPersonEdges } from './personPersonInducer.js';
import {
  induceWorkItemFollowsEdges,
  purgeStaleEdges,
  type PurgeSummary,
} from './workItemInducer.js';

const THROTTLE_MS = 5 * 60_000;
let lastRunAt = 0;
let lastSummary: GraphInducerSummary | null = null;

export type GraphInducerSummary = {
  ranAt: string;
  durationMs: number;
  taxonomy: RefreshResult;
  personProject: {
    written: number;
    skippedLowSignal: number;
    rawTuples: number;
  };
  personPerson: {
    written: number;
    skippedLowSignal: number;
    rawPairs: number;
  };
  workItem: {
    written: number;
    resolved: number;
    skippedSelfLoop: number;
  };
  purge: PurgeSummary;
};

export type RunGraphInducerOpts = {
  /** 跳过 throttle，强制跑（route /run-once 用） */
  force?: boolean;
  /** 跳过 LLM taxonomy（测试用，跑得快） */
  skipTaxonomy?: boolean;
  /** 写入 cutoff cache 用的当前时间 */
  now?: number;
};

export async function runGraphInducer(
  opts: RunGraphInducerOpts = {}
): Promise<GraphInducerSummary> {
  const now = opts.now ?? Date.now();

  // throttle: 5min 内重复调用直接返回上次结果
  if (!opts.force && lastSummary && now - lastRunAt < THROTTLE_MS) {
    return lastSummary;
  }

  const t0 = now;

  // 1) taxonomy (LLM, ~10-30s if needed)
  const taxonomy: RefreshResult = opts.skipTaxonomy
    ? { run: false, clustersWritten: 0, newEntities: 0 }
    : await refreshProjectTaxonomyIfNeeded({});

  // 2) personProject (writes to entity_edges)
  const personProject = inducePersonProjectEdges({ now });

  // 3) personPerson (depends on personProject in entity_edges)
  const personPerson = inducePersonPersonEdges({ now });

  // 4) workItem follows
  const workItem = induceWorkItemFollowsEdges();

  // 5) purge (dryRun default)
  const purge = purgeStaleEdges({ now, dryRun: true });

  const summary: GraphInducerSummary = {
    ranAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    taxonomy,
    personProject,
    personPerson,
    workItem,
    purge,
  };
  lastRunAt = now;
  lastSummary = summary;

  console.log(
    `[graphInducer] ${summary.durationMs}ms taxonomy=${taxonomy.clustersWritten} ` +
      `pp=${personPerson.written} ppj=${personProject.written} ` +
      `wif=${workItem.written}/${workItem.resolved} ` +
      `purge.dry=${purge.entityEdgesMatched}`
  );

  return summary;
}

export function getLastRunAt(): number {
  return lastRunAt;
}

export function resetThrottle(): void {
  lastRunAt = 0;
  lastSummary = null;
}
