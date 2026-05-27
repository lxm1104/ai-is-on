/**
 * MVP15B M3 — inferDecisionAuthority：给 entity_edges (kind='person_project')
 * 的 top N 条边打 decision_authority 标签。
 *
 * 数据流：
 *   1. 查 entity_edges where kind='person_project' AND
 *      (llm_classified_at IS NULL OR llm_classified_at < now-14d)
 *      ORDER BY weight DESC LIMIT topN（默认 50）
 *   2. 给每条边收集证据：
 *      - person attributes (orgRole / business / functionLabel) from context_entities.attributes_json
 *      - project canonicalName（= edge.to_id）
 *      - 最近 5 条 evidence unit 的 title + meaning
 *   3. batch ≤10 条 / LLM call（aiisn-decision-authority）
 *   4. LLM 输出 [{edgeId, decisionAuthority, why}]
 *   5. updateEntityEdgeLlmTags 写 decision_authority + llm_why + llm_classified_at
 *
 * 错误策略：
 *   - LLM 失败 → 这批边不写，下次重试（llm_classified_at 不更新）
 *   - LLM 漏返某 edgeId → 该边不写，下次重试
 *   - decisionAuthority 不在白名单 → 跳过该条
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
const EVIDENCE_TITLES_CAP = 5;

export type DecisionAuthorityInput = {
  edgeId: string;
  personName: string;
  orgRole?: string;
  business?: string;
  functionLabel?: string;
  projectCanonicalName: string;
  sqlInferredRole: string;
  evidence: Array<{ title: string; meaning?: string }>;
};

export type DecisionAuthorityOutput = {
  edgeId: string;
  decisionAuthority: 'high' | 'mid' | 'low';
  why: string;
};

export type ClassifyOpts = {
  topN?: number;
  force?: boolean;          // 忽略 14d cache 强制重判
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

export async function classifyTopPpjEdges(
  opts: ClassifyOpts = {}
): Promise<ClassifyResult> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now - TTL_MS).toISOString();
  const topN = Math.min(Math.max(opts.topN ?? DEFAULT_TOP_N, 1), 500);

  // 1) 选 top N 候选边
  //    "需要分类" = llm_classified_at 为 NULL 或早于 14 天前
  const sqlCond = opts.force
    ? `edge_kind = 'person_project'`
    : `edge_kind = 'person_project'
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

  // 2) 为每条边收证据 → 构造 LLM 输入
  const inputs: DecisionAuthorityInput[] = [];
  for (const edge of candidates) {
    const inp = buildInputForEdge(edge);
    if (inp) inputs.push(inp);
  }
  if (inputs.length === 0) {
    return { run: false, classified: 0, skipped: 0, failed: 0 };
  }

  // 3) batch
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
          decision_authority: out.decisionAuthority,
          llm_why: out.why.slice(0, 200),
          llm_classified_at: nowIso,
        });
        classified++;
      }
    } catch (err) {
      console.warn(
        `[decisionAuthority] LLM batch failed (${batch.length} items): ${err instanceof Error ? err.message : String(err)}`
      );
      failed += batch.length;
    }
  }

  return { run: true, classified, skipped: candidates.length - inputs.length, failed };
}

// ---------------------------------------------------------------------------
// 收证据
// ---------------------------------------------------------------------------

function buildInputForEdge(edge: EntityEdgeRow): DecisionAuthorityInput | null {
  // person 端：from_id 是 person entity id
  const personRow = getContextEntityById(edge.from_id);
  if (!personRow) return null; // entity 被删了
  const personAttrs = parsePersonAttributesFromRow(personRow);

  // project 端：to_id 已经是 canonical name（不是 entity id）—— 见 personProjectInducer
  const projectCanonicalName = edge.to_id;

  // evidence：解析 evidence_unit_ids_json，拉这些 unit 的 title + meaning
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
    personName: personRow.name,
    orgRole: personAttrs?.orgRoleFromMe,
    business: personAttrs?.larkDeptBusiness,
    functionLabel: personAttrs?.larkDeptFunctionLabel,
    projectCanonicalName,
    sqlInferredRole: edge.role_or_type ?? 'contributor',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// LLM 调用 + 解析
// ---------------------------------------------------------------------------

async function callLlm(
  batch: DecisionAuthorityInput[],
  opts: ClassifyOpts
): Promise<DecisionAuthorityOutput[]> {
  const userMessage = [
    '请按 system prompt 的 schema 判定下面每条 (person, project) 边的决策权重。',
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
      agentName: 'aiisn-decision-authority',
      timeoutMs: LLM_TIMEOUT_MS,
    });
    rawText = shot.text;
  }

  return parseLlmOutput(rawText, batch);
}

function parseLlmOutput(
  raw: string,
  batch: DecisionAuthorityInput[]
): DecisionAuthorityOutput[] {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') {
    throw new Error(`decisionAuthority LLM not parseable: ${raw.slice(0, 200)}`);
  }
  const results = (obj as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error(`decisionAuthority LLM missing results: ${raw.slice(0, 200)}`);
  }
  const inputIds = new Set(batch.map((b) => b.edgeId));
  const ALLOWED = new Set(['high', 'mid', 'low']);
  const out: DecisionAuthorityOutput[] = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const edgeId = typeof r.edgeId === 'string' ? r.edgeId : '';
    if (!inputIds.has(edgeId)) continue;
    const da = typeof r.decisionAuthority === 'string' && ALLOWED.has(r.decisionAuthority)
      ? (r.decisionAuthority as 'high' | 'mid' | 'low')
      : null;
    const why = typeof r.why === 'string' ? r.why.trim() : '';
    if (!da || why.length < 5) continue;
    out.push({ edgeId, decisionAuthority: da, why });
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
