/**
 * MVP15B M2 — judgeProjectPhase：给 canonical project 打 phase + health 标签。
 *
 * 数据流：
 *   1. 列出 org_project_taxonomy 所有 canonical_name
 *   2. listProjectPhasesNeedingRefresh 过滤已记录且 ttl_until > now 的
 *   3. 给每个 uncached canonical 用 listUnitsForProjectCanonical 收证据
 *      （goals + active commitments + 近 14d events，各 cap 5）
 *   4. batch ≤10 个 / call 送 LLM（aiisn-project-phase agent）
 *   5. LLM 输出 phases[]，upsertProjectPhase；ttl_until = now + 30 天
 *
 * 错误策略：
 *   - LLM 失败 → 这批 canonical 留空 phase（不写表，下次重试）
 *   - JSON parse 失败 → 同上
 *   - LLM 漏掉某 canonical → 该 canonical 不写表，下次重试
 */

import { jsonrepair } from 'jsonrepair';
import {
  db,
  getProjectPhase,
  listProjectPhasesNeedingRefresh,
  listProjectTaxonomy,
  upsertProjectPhase,
  type OrgProjectPhaseRow,
} from '../db.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { listUnitsForProjectCanonical } from '../context/projectUnitsResolver.js';
import type { ContextUnit } from '../context/ContextUnit.js';

// 沿用 MVP15A projectTaxonomy 的实测参数：batch 大 / 单 call timeout 不够会超时
const LLM_BATCH_LIMIT = 10;
const LLM_TIMEOUT_MS = 180_000;

// project phase TTL：30 天后重判（项目状态不会一夜之间变）
const TTL_MS = 30 * 86400_000;

// 近 14d events 的回看窗口
const RECENT_EVENT_WINDOW_MS = 14 * 86400_000;

// 每个 canonical 收集的证据上限（防止 prompt 撑爆）
const EVIDENCE_PER_KIND_CAP = 5;

export type ProjectPhaseInput = {
  canonicalName: string;
  goals: Array<{ id: string; title: string }>;
  commitments: Array<{ id: string; title: string; dueAt?: string }>;
  recentEvents: Array<{ id: string; title: string; updatedAt: string }>;
  uncertainties: Array<{ id: string; title: string }>;
};

export type ProjectPhaseClusterOutput = {
  canonicalName: string;
  phase: 'discovery' | 'planning' | 'execution' | 'review' | 'frozen';
  health: 'on_track' | 'at_risk' | 'overdue' | 'unknown';
  healthEvidenceUnitIds: string[];
  summary: string;
};

export type RefreshOpts = {
  force?: boolean;
  /** 测试用：直接注入 LLM 输出字符串 */
  llmHook?: (userMessage: string) => Promise<string>;
  /** 默认 now=Date.now() */
  now?: number;
};

export type RefreshResult = {
  run: boolean;
  refreshed: number;   // 成功写入的数量
  skipped: number;     // ttl 未过期跳过的数量
  failed: number;      // LLM 失败的数量
};

// ---------------------------------------------------------------------------
// 入口：lazy refresh
// ---------------------------------------------------------------------------

export async function refreshProjectPhasesIfNeeded(
  opts: RefreshOpts = {}
): Promise<RefreshResult> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const ttlIso = new Date(now + TTL_MS).toISOString();
  const sinceIso = new Date(now - RECENT_EVENT_WINDOW_MS).toISOString();

  // 1. 拿全部 canonical
  const allCanonicals = listProjectTaxonomy().map((r) => r.canonical_name);
  if (allCanonicals.length === 0) {
    return { run: false, refreshed: 0, skipped: 0, failed: 0 };
  }

  // 2. 过滤需要刷新的（force 全跑 / 否则按 ttl）
  const targets = opts.force
    ? allCanonicals
    : listProjectPhasesNeedingRefresh(allCanonicals, nowIso);
  const skipped = allCanonicals.length - targets.length;
  if (targets.length === 0) {
    return { run: false, refreshed: 0, skipped, failed: 0 };
  }

  // 3. 给每个 target 收集证据
  const inputs: ProjectPhaseInput[] = targets.map((name) =>
    buildInputForCanonical(name, sinceIso)
  );

  // 4. batch LLM
  let refreshed = 0;
  let failed = 0;
  for (let i = 0; i < inputs.length; i += LLM_BATCH_LIMIT) {
    const batch = inputs.slice(i, i + LLM_BATCH_LIMIT);
    try {
      const outputs = await callLlm(batch, opts);
      const byName = new Map(outputs.map((o) => [o.canonicalName, o]));
      for (const inp of batch) {
        const out = byName.get(inp.canonicalName);
        if (!out) {
          // LLM 漏掉了 → 不写、下次重试
          failed++;
          continue;
        }
        upsertProjectPhase({
          canonical_name: out.canonicalName,
          phase: out.phase,
          health: out.health,
          health_evidence_unit_ids_json: JSON.stringify(out.healthEvidenceUnitIds ?? []),
          summary: out.summary || null,
          llm_classified_at: nowIso,
          ttl_until: ttlIso,
        });
        refreshed++;
      }
    } catch (err) {
      console.warn(
        `[projectPhase] LLM batch failed (${batch.length} items): ${err instanceof Error ? err.message : String(err)}`
      );
      failed += batch.length;
    }
  }

  return { run: true, refreshed, skipped, failed };
}

// ---------------------------------------------------------------------------
// 收证据
// ---------------------------------------------------------------------------

function buildInputForCanonical(
  canonicalName: string,
  sinceIso: string
): ProjectPhaseInput {
  const goals = listUnitsForProjectCanonical(canonicalName, {
    kinds: ['goal'],
    limit: EVIDENCE_PER_KIND_CAP,
  });
  const commitments = listUnitsForProjectCanonical(canonicalName, {
    kinds: ['commitment'],
    limit: EVIDENCE_PER_KIND_CAP,
  });
  const uncertainties = listUnitsForProjectCanonical(canonicalName, {
    kinds: ['uncertainty'],
    limit: EVIDENCE_PER_KIND_CAP,
  });
  const recentEvents = listUnitsForProjectCanonical(canonicalName, {
    kinds: ['event'],
    limit: EVIDENCE_PER_KIND_CAP,
    sinceIso,
  });
  return {
    canonicalName,
    goals: goals.map((u) => ({ id: u.id, title: u.title })),
    commitments: commitments.map((u) => ({
      id: u.id,
      title: u.title,
      dueAt: u.time?.dueAt,
    })),
    uncertainties: uncertainties.map((u) => ({ id: u.id, title: u.title })),
    recentEvents: recentEvents.map((u) => ({
      id: u.id,
      title: u.title,
      updatedAt: u.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// LLM 调用 + JSON 解析
// ---------------------------------------------------------------------------

async function callLlm(
  batch: ProjectPhaseInput[],
  opts: RefreshOpts
): Promise<ProjectPhaseClusterOutput[]> {
  const userMessage = [
    '请按 system prompt 的 schema 给下面这些 canonical project 判定 phase + health。',
    '每个 project 带 goals / commitments / uncertainties / recentEvents。',
    'commitment.dueAt 是 ISO 时间；recentEvent.updatedAt 是 ISO 时间。',
    `参考"今天"：${new Date().toISOString()}`,
    '',
    '<projects>',
    JSON.stringify(batch, null, 2),
    '</projects>',
    '',
    '只输出 JSON 对象，不要 Markdown。',
  ].join('\n');

  let rawText: string;
  if (opts.llmHook) {
    rawText = await opts.llmHook(userMessage);
  } else {
    const shot = await runOneShot(userMessage, {
      agentName: 'aiisn-project-phase',
      timeoutMs: LLM_TIMEOUT_MS,
    });
    rawText = shot.text;
  }

  return parseLlmOutput(rawText, batch);
}

function parseLlmOutput(
  raw: string,
  batch: ProjectPhaseInput[]
): ProjectPhaseClusterOutput[] {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') {
    throw new Error(`projectPhase LLM output not parseable as JSON: ${raw.slice(0, 200)}`);
  }
  const phases = (obj as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) {
    throw new Error(`projectPhase LLM output missing 'phases' array: ${raw.slice(0, 200)}`);
  }
  const out: ProjectPhaseClusterOutput[] = [];
  const inputNames = new Set(batch.map((b) => b.canonicalName));
  const ALLOWED_PHASES = new Set(['discovery', 'planning', 'execution', 'review', 'frozen']);
  const ALLOWED_HEALTH = new Set(['on_track', 'at_risk', 'overdue', 'unknown']);
  for (const item of phases) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const canonicalName = typeof r.canonicalName === 'string' ? r.canonicalName : '';
    if (!inputNames.has(canonicalName)) continue; // 忽略 LLM 编出来的
    const phase = typeof r.phase === 'string' && ALLOWED_PHASES.has(r.phase) ? r.phase : null;
    const health =
      typeof r.health === 'string' && ALLOWED_HEALTH.has(r.health) ? r.health : null;
    if (!phase || !health) continue; // 必须两者都有效
    const healthEvidenceUnitIds = Array.isArray(r.healthEvidenceUnitIds)
      ? (r.healthEvidenceUnitIds as unknown[]).filter(
          (x): x is string => typeof x === 'string'
        )
      : [];
    const summary =
      typeof r.summary === 'string' ? r.summary.slice(0, 200) : '';
    out.push({
      canonicalName,
      phase: phase as ProjectPhaseClusterOutput['phase'],
      health: health as ProjectPhaseClusterOutput['health'],
      healthEvidenceUnitIds,
      summary,
    });
  }
  return out;
}

function extractJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
    try {
      return JSON.parse(jsonrepair(fenced[1]));
    } catch {}
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = s.slice(first, last + 1);
    try {
      return JSON.parse(sliced);
    } catch {}
    try {
      return JSON.parse(jsonrepair(sliced));
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// 暴露给测试
// ---------------------------------------------------------------------------
export const __internal = {
  TTL_MS,
  LLM_BATCH_LIMIT,
  buildInputForCanonical,
  parseLlmOutput,
};
