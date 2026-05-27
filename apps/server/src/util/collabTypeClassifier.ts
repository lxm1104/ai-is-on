/**
 * MVP15B M4 — classifyPersonPersonEdges：给 entity_edges (kind='person_person')
 * 的 top N 条边打 collab_type 标签。
 *
 * 数据流跟 decisionAuthorityClassifier 几乎一致，区别在：
 *   - 输入是 person-person 边（两个 person attrs）
 *   - 输出 collabType ∈ {collab, reviewer_author, cross_team, mentor}
 *   - 默认 'collab'，只有强信号才升其他三档
 *   - evidence cap 10（pp 边的 evidence_unit_ids_json 通常更长）
 */

import { jsonrepair } from 'jsonrepair';
import {
  db,
  getContextEntityById,
  updateEntityEdgeLlmTags,
  type EntityEdgeRow,
} from '../db.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { parsePersonAttributesFromRow } from '../context/personAttributes.js';

const LLM_BATCH_LIMIT = 10;
const LLM_TIMEOUT_MS = 180_000;
const TTL_MS = 14 * 86400_000;
const DEFAULT_TOP_N = 50;
const EVIDENCE_TITLES_CAP = 10;

export type CollabTypeInput = {
  edgeId: string;
  personAName: string;
  personAOrgRole?: string;
  personABusiness?: string;
  personAFunction?: string;
  personBName: string;
  personBOrgRole?: string;
  personBBusiness?: string;
  personBFunction?: string;
  businessRelation: string;
  sharedProjectCount: number;
  evidence: Array<{ title: string; meaning?: string }>;
};

export type CollabType = 'collab' | 'reviewer_author' | 'cross_team' | 'mentor';

export type CollabTypeOutput = {
  edgeId: string;
  collabType: CollabType;
  why: string;
};

export type ClassifyOpts = {
  topN?: number;
  force?: boolean;
  now?: number;
  llmHook?: (userMessage: string) => Promise<string>;
};

export type ClassifyResult = {
  run: boolean;
  classified: number;
  skipped: number;
  failed: number;
};

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function classifyTopPpEdges(
  opts: ClassifyOpts = {}
): Promise<ClassifyResult> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now - TTL_MS).toISOString();
  const topN = Math.min(Math.max(opts.topN ?? DEFAULT_TOP_N, 1), 500);

  const sqlCond = opts.force
    ? `edge_kind = 'person_person'`
    : `edge_kind = 'person_person'
       AND (llm_classified_at IS NULL OR llm_classified_at < ?)`;
  const params: Array<string | number> = opts.force ? [] : [cutoffIso];
  params.push(topN);

  const candidates = db
    .prepare(
      `SELECT * FROM entity_edges
        WHERE ${sqlCond}
        ORDER BY weight DESC
        LIMIT ?`
    )
    .all(...params) as EntityEdgeRow[];

  if (candidates.length === 0) {
    return { run: false, classified: 0, skipped: 0, failed: 0 };
  }

  const inputs: CollabTypeInput[] = [];
  for (const edge of candidates) {
    const inp = buildInputForEdge(edge);
    if (inp) inputs.push(inp);
  }
  if (inputs.length === 0) {
    return { run: false, classified: 0, skipped: 0, failed: 0 };
  }

  let classified = 0;
  let failed = 0;
  for (let i = 0; i < inputs.length; i += LLM_BATCH_LIMIT) {
    const batch = inputs.slice(i, i + LLM_BATCH_LIMIT);
    try {
      const outputs = await callLlm(batch, opts);
      const byEdgeId = new Map(outputs.map((o) => [o.edgeId, o]));
      for (const inp of batch) {
        const out = byEdgeId.get(inp.edgeId);
        if (!out) {
          failed++;
          continue;
        }
        updateEntityEdgeLlmTags(inp.edgeId, {
          collab_type: out.collabType,
          llm_why: out.why.slice(0, 200),
          llm_classified_at: nowIso,
        });
        classified++;
      }
    } catch (err) {
      console.warn(
        `[collabType] LLM batch failed (${batch.length} items): ${err instanceof Error ? err.message : String(err)}`
      );
      failed += batch.length;
    }
  }

  return { run: true, classified, skipped: candidates.length - inputs.length, failed };
}

// ---------------------------------------------------------------------------
// 收证据
// ---------------------------------------------------------------------------

function buildInputForEdge(edge: EntityEdgeRow): CollabTypeInput | null {
  const personA = getContextEntityById(edge.from_id);
  const personB = getContextEntityById(edge.to_id);
  if (!personA || !personB) return null;

  const aAttrs = parsePersonAttributesFromRow(personA);
  const bAttrs = parsePersonAttributesFromRow(personB);

  // shared projects count
  let sharedProjectCount = 0;
  try {
    const arr = JSON.parse(edge.shared_ids_json ?? '[]');
    if (Array.isArray(arr)) sharedProjectCount = arr.length;
  } catch {}

  // evidence
  let evidenceUnitIds: string[] = [];
  try {
    const arr = JSON.parse(edge.evidence_unit_ids_json);
    if (Array.isArray(arr)) {
      evidenceUnitIds = arr.filter((s): s is string => typeof s === 'string');
    }
  } catch {}
  const evidence: Array<{ title: string; meaning?: string }> = [];
  if (evidenceUnitIds.length > 0) {
    const cap = Math.min(evidenceUnitIds.length, EVIDENCE_TITLES_CAP);
    const placeholders = Array(cap).fill('?').join(',');
    const rows = db
      .prepare(
        `SELECT title, meaning FROM context_units WHERE id IN (${placeholders})`
      )
      .all(...evidenceUnitIds.slice(0, cap)) as Array<{
      title: string;
      meaning: string | null;
    }>;
    for (const r of rows) {
      evidence.push({ title: r.title, meaning: r.meaning ?? undefined });
    }
  }

  return {
    edgeId: edge.id,
    personAName: personA.name,
    personAOrgRole: aAttrs?.orgRoleFromMe,
    personABusiness: aAttrs?.larkDeptBusiness,
    personAFunction: aAttrs?.larkDeptFunctionLabel,
    personBName: personB.name,
    personBOrgRole: bAttrs?.orgRoleFromMe,
    personBBusiness: bAttrs?.larkDeptBusiness,
    personBFunction: bAttrs?.larkDeptFunctionLabel,
    businessRelation: edge.business_relation ?? 'unknown',
    sharedProjectCount,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// LLM 调用 + 解析
// ---------------------------------------------------------------------------

async function callLlm(
  batch: CollabTypeInput[],
  opts: ClassifyOpts
): Promise<CollabTypeOutput[]> {
  const userMessage = [
    '请按 system prompt 的 schema 给下面每条 person-person 边判定 collabType。',
    '默认 collab；只有 evidence 里有 ≥2 条强信号才升级到 reviewer_author / mentor / cross_team。',
    '',
    '<edges>',
    JSON.stringify(batch, null, 2),
    '</edges>',
    '',
    '只输出 JSON 对象，不要 Markdown。',
  ].join('\n');

  let rawText: string;
  if (opts.llmHook) {
    rawText = await opts.llmHook(userMessage);
  } else {
    const shot = await runOneShot(userMessage, {
      agentName: 'aiisn-collab-type',
      timeoutMs: LLM_TIMEOUT_MS,
    });
    rawText = shot.text;
  }

  return parseLlmOutput(rawText, batch);
}

function parseLlmOutput(
  raw: string,
  batch: CollabTypeInput[]
): CollabTypeOutput[] {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') {
    throw new Error(`collabType LLM not parseable: ${raw.slice(0, 200)}`);
  }
  const results = (obj as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error(`collabType LLM missing results: ${raw.slice(0, 200)}`);
  }
  const inputIds = new Set(batch.map((b) => b.edgeId));
  const ALLOWED: ReadonlySet<CollabType> = new Set<CollabType>([
    'collab',
    'reviewer_author',
    'cross_team',
    'mentor',
  ]);
  const out: CollabTypeOutput[] = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const edgeId = typeof r.edgeId === 'string' ? r.edgeId : '';
    if (!inputIds.has(edgeId)) continue;
    const ct = typeof r.collabType === 'string' && (ALLOWED as Set<string>).has(r.collabType)
      ? (r.collabType as CollabType)
      : null;
    const why = typeof r.why === 'string' ? r.why.trim() : '';
    if (!ct || why.length < 5) continue;
    out.push({ edgeId, collabType: ct, why });
  }
  return out;
}

function extractJson(s: string): unknown {
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(jsonrepair(s)); } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch {}
    try { return JSON.parse(jsonrepair(fenced[1])); } catch {}
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = s.slice(first, last + 1);
    try { return JSON.parse(sliced); } catch {}
    try { return JSON.parse(jsonrepair(sliced)); } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// 测试暴露
// ---------------------------------------------------------------------------
export const __internal = {
  LLM_BATCH_LIMIT,
  TTL_MS,
  DEFAULT_TOP_N,
  buildInputForEdge,
  parseLlmOutput,
};
