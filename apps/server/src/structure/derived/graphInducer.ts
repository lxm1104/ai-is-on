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

// MVP21 S5.1: 本文件从 context/ 迁到 structure/derived/。
//   - 同目录兄弟 (./xxx) 保持
//   - util / context 留下的兄弟 → ../../{util,context}/...
//   - inducerRegistry 在 structure/ 上层 → ../inducerRegistry
import {
  refreshProjectTaxonomyIfNeeded,
  type RefreshResult,
} from '../../util/projectTaxonomy.js';
import { inducePersonProjectEdges } from './personProjectInducer.js';
import { inducePersonPersonEdges } from './personPersonInducer.js';
import {
  induceWorkItemFollowsEdges,
  purgeStaleEdges,
  type PurgeSummary,
} from './workItemInducer.js';
// MVP15B D12：inducer 写完 entity_edges 后必须 invalidate SCR + graphContext cache，
// 否则前端 panel 和 attention prompt 在 60s 内看到的还是没标签的旧数据。
import { __internal as scrInternal } from './selfCollaboratorRanking.js';
import { __internal as gcInternal } from '../../context/graphContextAssembler.js';
// MVP21 S5: 注册表观测（只元数据，不接管调度，throttle/cache 仍由本文件自管）
import { registerInducer, reportInducerRun } from '../inducerRegistry.js';

const THROTTLE_MS = 5 * 60_000;
let lastRunAt = 0;
let lastSummary: GraphInducerSummary | null = null;

// MVP21 S5: 顶层 inducer 元数据登记。trigger='tick' 因为 boot 后定时跑 +
// /api/graph/_inducer/run-once 手动触发；产出落到 entity_edges / work_item_edges
// （都属 derived_signal layer）。
registerInducer('graph_inducer', 'derived_signal', 'tick');

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
  // MVP21 S5: 主入口 try/finally 包一层，无论成功失败都向注册表汇报一次。
  // 主流程不能因为 reportInducerRun 抛错而崩溃，所以 catch 兜底。
  let errorMsg: string | null = null;
  try {
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

    // MVP15B D12：写完 entity_edges → 强制 invalidate downstream caches
    scrInternal.resetCache();
    gcInternal.resetCache();

    console.log(
      `[graphInducer] ${summary.durationMs}ms taxonomy=${taxonomy.clustersWritten} ` +
        `pp=${personPerson.written} ppj=${personProject.written} ` +
        `wif=${workItem.written}/${workItem.resolved} ` +
        `purge.dry=${purge.entityEdgesMatched}`
    );

    return summary;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    try {
      reportInducerRun('graph_inducer', Date.now() - t0, errorMsg);
    } catch {
      /* 注册表报告失败不影响主流程 */
    }
  }
}

export function getLastRunAt(): number {
  return lastRunAt;
}

export function resetThrottle(): void {
  lastRunAt = 0;
  lastSummary = null;
}
