/**
 * MVP15A §7.1.5 — project entity 去重 + 永久缓存。
 *
 * 数据流：
 *   1. 调用方传入 ProjectTaxonomyInput[]（entity 名 + 各自 top 5 共现协作者/文档名）
 *   2. 已经在 org_project_taxonomy 表里的 entity（出现在任意 cluster 的 aliases_json 中）
 *      跳过，不再送 LLM
 *   3. 未缓存的批量送 LLM（agentName='aiisn-project-taxonomy'），单次 ≤30 个 entity
 *   4. LLM 输出 ProjectCluster[]，写入 org_project_taxonomy（upsertProjectTaxonomy
 *      内部做 aliases 并集合并）
 *   5. 返回这批 entity 各自归属的 canonicalName 映射
 *
 * 错误策略：
 *   - LLM 失败 → 这批 entity 留 fallback（canonicalName === entityName 自己），不写表
 *   - JSON parse 失败 → 同上
 *
 * 增量解析触发：调用 `refreshProjectTaxonomyIfNeeded` 时
 *   - force=true → 即使全部已缓存也跑（测试用）
 *   - 否则：仅给未缓存的 entity 跑 LLM
 *   - 全部已缓存 → run=false 直接返回
 */

import { jsonrepair } from 'jsonrepair';
import {
  db,
  listProjectTaxonomy,
  upsertProjectTaxonomy,
  resolveProjectCanonical,
  type OrgProjectTaxonomyRow,
} from '../db.js';
import { runOneShot } from '../triage/backgroundRuntime.js';

const LLM_BATCH_LIMIT = 30;
const LLM_TIMEOUT_MS = 60_000;

export type ProjectTaxonomyInput = {
  entityName: string;
  /** top 5 跟此 entity 共现的协作者/文档名，作为消歧上下文 */
  cooccurNames: string[];
};

export type ProjectCluster = {
  canonicalName: string;
  memberNames: string[];
  summary: string | null;
};

export type RefreshOpts = {
  /** 不计 force 强制全跑 */
  force?: boolean;
  /** 注入假 LLM 用于测试 */
  llmHook?: (userMessage: string) => Promise<string>;
};

export type RefreshResult = {
  run: boolean;
  clustersWritten: number;
  newEntities: number;
};

// ---------------------------------------------------------------------------
// 入口 1：给定一组 entity 调用，返回 clusters；同时写缓存
// ---------------------------------------------------------------------------

export async function parseProjectClusters(
  entities: ProjectTaxonomyInput[],
  opts: { llmHook?: (userMessage: string) => Promise<string> } = {}
): Promise<ProjectCluster[]> {
  const uniqueByName = new Map<string, ProjectTaxonomyInput>();
  for (const e of entities) {
    if (!e.entityName?.trim()) continue;
    uniqueByName.set(e.entityName.trim(), e);
  }
  if (uniqueByName.size === 0) return [];

  const out: ProjectCluster[] = [];
  const list = Array.from(uniqueByName.values());
  for (let i = 0; i < list.length; i += LLM_BATCH_LIMIT) {
    const batch = list.slice(i, i + LLM_BATCH_LIMIT);
    try {
      const clusters = await callLlm(batch, opts);
      // 校验：每个 input entity 必须出现在某个 cluster 里
      const allMembers = new Set<string>();
      for (const c of clusters) for (const m of c.memberNames) allMembers.add(m);
      const missing = batch.filter((e) => !allMembers.has(e.entityName));
      // 漏掉的 entity → 自成 cluster（兜底）
      for (const e of missing) {
        clusters.push({
          canonicalName: e.entityName,
          memberNames: [e.entityName],
          summary: null,
        });
      }
      // 持久化
      const now = new Date().toISOString();
      for (const c of clusters) {
        upsertProjectTaxonomy({
          canonical_name: c.canonicalName,
          aliases_json: JSON.stringify(c.memberNames),
          summary: c.summary,
          parsed_by: 'llm',
          parsed_at: now,
        });
      }
      out.push(...clusters);
    } catch (err) {
      console.warn(
        `[projectTaxonomy] LLM batch failed (${batch.length} items): ${err instanceof Error ? err.message : String(err)}`
      );
      // 失败兜底：每个 entity 自成 cluster，但**不写缓存**，下次重试
      for (const e of batch) {
        out.push({
          canonicalName: e.entityName,
          memberNames: [e.entityName],
          summary: null,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 入口 2：lazy refresh —— graphInducer 调用前先看缓存够不够
// ---------------------------------------------------------------------------

/**
 * 列出所有 project entity 名（type='project' 且 status 未删除）。
 * 不直接走 db.listContextEntities 是因为后者按 updated_at desc 排，这里只关心存在性。
 */
function listAllProjectEntityNames(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT name FROM context_entities WHERE type = 'project' ORDER BY name`
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * 给定一个 project entity name，找出它最常共现的 top N entity 名（type ∈ person/doc）。
 * 用于 LLM 消歧上下文。共现定义：同 context_unit 出现 + cu.status='active' AND scope='work'。
 */
function getTopCooccurNames(entityName: string, topN = 5): string[] {
  const rows = db
    .prepare(
      `WITH src AS (
         SELECT cue1.entity_id AS src_id FROM context_unit_entities cue1
         JOIN context_entities e1 ON e1.id = cue1.entity_id
         WHERE e1.type='project' AND e1.name = ?
       )
       SELECT e2.name AS partner_name, COUNT(*) AS cnt
       FROM context_unit_entities cue1
       JOIN src ON src.src_id = cue1.entity_id
       JOIN context_unit_entities cue2
         ON cue2.context_unit_id = cue1.context_unit_id
         AND cue2.entity_id != cue1.entity_id
       JOIN context_entities e2 ON e2.id = cue2.entity_id
       JOIN context_units cu ON cu.id = cue1.context_unit_id
       WHERE cu.status='active' AND cu.scope='work'
         AND e2.type IN ('person','doc')
       GROUP BY e2.id
       ORDER BY cnt DESC
       LIMIT ?`
    )
    .all(entityName, topN) as Array<{ partner_name: string; cnt: number }>;
  return rows.map((r) => r.partner_name);
}

/**
 * graphInducer 调用此函数确保 taxonomy 覆盖当前所有 project entity。
 * - 全部已缓存 + !force → 立即返回 run=false
 * - 否则：仅对未缓存 entity 调 LLM；写入后返回 run=true + 实际 cluster 数
 */
export async function refreshProjectTaxonomyIfNeeded(
  opts: RefreshOpts = {}
): Promise<RefreshResult> {
  const allNames = listAllProjectEntityNames();
  if (allNames.length === 0) return { run: false, clustersWritten: 0, newEntities: 0 };

  // 找未缓存的 entity：用 resolveProjectCanonical，返回值 === 原名说明缓存里没找到
  const uncached = opts.force
    ? allNames
    : allNames.filter((n) => resolveProjectCanonical(n) === n && !isInAnyCluster(n));

  if (uncached.length === 0) {
    return { run: false, clustersWritten: 0, newEntities: 0 };
  }

  // 给每个 uncached entity 收集消歧上下文
  const inputs: ProjectTaxonomyInput[] = uncached.map((name) => ({
    entityName: name,
    cooccurNames: getTopCooccurNames(name, 5),
  }));

  const clusters = await parseProjectClusters(inputs, { llmHook: opts.llmHook });

  return {
    run: true,
    clustersWritten: clusters.length,
    newEntities: uncached.length,
  };
}

/**
 * resolveProjectCanonical 在 entity 自己是 canonical 时也会返回原名（命中缓存了）。
 * 这里要更强：必须出现在 aliases_json 列表里才算"已缓存"。
 */
function isInAnyCluster(entityName: string): boolean {
  const rows: OrgProjectTaxonomyRow[] = listProjectTaxonomy();
  for (const r of rows) {
    let arr: unknown;
    try {
      arr = JSON.parse(r.aliases_json);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    if (arr.some((a) => typeof a === 'string' && a.trim() === entityName.trim())) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// LLM 调用 + JSON 解析
// ---------------------------------------------------------------------------

async function callLlm(
  batch: ProjectTaxonomyInput[],
  opts: { llmHook?: (userMessage: string) => Promise<string> }
): Promise<ProjectCluster[]> {
  const userMessage = [
    '请按 system prompt 的 schema 把下面这些项目 entity 聚类。',
    '每个 entity 带它最常共现的协作者/文档名（top 5）作为消歧上下文。',
    '',
    '<entities>',
    JSON.stringify(
      batch.map((b) => ({ entityName: b.entityName, cooccurNames: b.cooccurNames })),
      null,
      2
    ),
    '</entities>',
    '',
    '只输出 JSON 对象，不要 Markdown。',
  ].join('\n');

  let rawText: string;
  if (opts.llmHook) {
    rawText = await opts.llmHook(userMessage);
  } else {
    const shot = await runOneShot(userMessage, {
      agentName: 'aiisn-project-taxonomy',
      timeoutMs: LLM_TIMEOUT_MS,
    });
    rawText = shot.text;
  }

  const clusters = parseClusterJson(rawText);
  if (clusters.length === 0) {
    throw new Error(`projectTaxonomy: parsed 0 clusters from LLM output: ${rawText.slice(0, 200)}`);
  }
  return clusters;
}

function parseClusterJson(raw: string): ProjectCluster[] {
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {}
    try {
      return JSON.parse(jsonrepair(s));
    } catch {}
    return null;
  };
  let parsed = tryParse(raw);
  if (parsed === null) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) parsed = tryParse(fenced[1]);
    if (parsed === null) {
      const first = raw.indexOf('{');
      const last = raw.lastIndexOf('}');
      if (first >= 0 && last > first) parsed = tryParse(raw.slice(first, last + 1));
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as { clusters?: unknown };
  if (!Array.isArray(obj.clusters)) return [];

  const out: ProjectCluster[] = [];
  for (const c of obj.clusters) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as { canonicalName?: unknown; memberNames?: unknown; summary?: unknown };
    if (typeof obj.canonicalName !== 'string' || !obj.canonicalName.trim()) continue;
    if (!Array.isArray(obj.memberNames)) continue;
    const members = obj.memberNames
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      .map((m) => m.trim());
    if (members.length === 0) continue;
    // canonicalName 必须出现在 memberNames 里
    const canonical = obj.canonicalName.trim();
    if (!members.includes(canonical)) members.unshift(canonical);
    const summary =
      typeof obj.summary === 'string' && obj.summary.trim() ? obj.summary.trim() : null;
    out.push({ canonicalName: canonical, memberNames: members, summary });
  }
  return out;
}

// 暴露给测试
export const __internal = {
  LLM_BATCH_LIMIT,
  parseClusterJson,
  getTopCooccurNames,
  isInAnyCluster,
  listAllProjectEntityNames,
};
