/**
 * MVP15 §4 (revision) — 部门名 → {business, functionPath} 解析 + 缓存。
 *
 * 数据流：
 *   1. 调用方传入一组 unique department names
 *   2. 先查 org_department_taxonomy 表，命中的直接复用
 *   3. 未命中的批量送 LLM（agentName='aiisn-dept-taxonomy'），prompt 在
 *      departmentTaxonomyPrompt.ts
 *   4. LLM 输出解析 + 写表 + 返回
 *
 * 缓存语义：永久。部门改名时手动 DELETE 对应行让它重新解析。
 *
 * 错误策略：LLM 整体失败 → 未命中部门留 null，不写表（下次有机会重试）。
 * 部分 LLM 结果格式错 → 仅丢弃该条，其他写入。
 */

import { jsonrepair } from 'jsonrepair';
import { getDeptTaxonomiesBulk, upsertDeptTaxonomy } from '../db.js';
import { runOneShot } from '../triage/backgroundRuntime.js';

export type DeptTaxonomyResult = {
  business: string | null;
  functionLabel: string | null;
  functionPath: string[] | null;
};

const LLM_BATCH_LIMIT = 30; // 单次 LLM 调用最多解析 30 个，避免 prompt 过长
const LLM_TIMEOUT_MS = 60_000;

export type ParseDepartmentsOpts = {
  /** 测试钩子：传入则跳过 runOneShot，直接由 hook 返回 JSON 文本。 */
  llmHook?: (userMessage: string) => Promise<string>;
};

/**
 * 主入口。输入 unique 部门名数组，输出 name → 解析结果 Map。
 * 未能解析的 key 也会出现在结果里、值为 null 结构（business/functionPath 都 null）。
 */
export async function parseDepartments(
  deptNames: string[],
  opts: ParseDepartmentsOpts = {}
): Promise<Map<string, DeptTaxonomyResult>> {
  const out = new Map<string, DeptTaxonomyResult>();
  const uniqueNames = Array.from(new Set(deptNames.filter((s) => s && s.trim())));
  if (uniqueNames.length === 0) return out;

  // 1) 缓存命中
  const cached = getDeptTaxonomiesBulk(uniqueNames);
  for (const [name, row] of cached) {
    out.set(name, {
      business: row.business,
      functionLabel: row.function_label,
      functionPath: row.function_path_json
        ? safeParsePathArray(row.function_path_json)
        : null,
    });
  }

  // 2) 未命中的批量送 LLM（分组 ≤30 个一次）
  const unparsed = uniqueNames.filter((n) => !cached.has(n));
  for (let i = 0; i < unparsed.length; i += LLM_BATCH_LIMIT) {
    const batch = unparsed.slice(i, i + LLM_BATCH_LIMIT);
    try {
      const parsed = await callLlmAndPersist(batch, opts);
      for (const [name, result] of parsed) {
        out.set(name, result);
      }
    } catch (err) {
      console.warn(
        `[deptTaxonomy] LLM batch failed (${batch.length} items): ${err instanceof Error ? err.message : String(err)}`
      );
      // 失败留 null，下次有机会再 parse —— 不写表
      for (const name of batch) {
        if (!out.has(name)) {
          out.set(name, { business: null, functionLabel: null, functionPath: null });
        }
      }
    }
  }

  return out;
}

async function callLlmAndPersist(
  batch: string[],
  opts: ParseDepartmentsOpts
): Promise<Map<string, DeptTaxonomyResult>> {
  const userMessage = [
    '请按 system prompt 的 schema 解析下面这些部门名。严格按输入顺序返回 `results` 数组。',
    '',
    '<deptNames>',
    JSON.stringify(batch, null, 2),
    '</deptNames>',
    '',
    '只输出 JSON 对象，不要 Markdown。',
  ].join('\n');

  let rawText: string;
  if (opts.llmHook) {
    rawText = await opts.llmHook(userMessage);
  } else {
    const shot = await runOneShot(userMessage, {
      agentName: 'aiisn-dept-taxonomy',
      timeoutMs: LLM_TIMEOUT_MS,
    });
    rawText = shot.text;
  }

  const items = parseLlmJson(rawText);
  const now = new Date().toISOString();
  const out = new Map<string, DeptTaxonomyResult>();

  // 按输入顺序对齐（不依赖 LLM 必然按顺序返回；用 deptName 字段索引）
  const byName = new Map<string, LlmResultItem>();
  for (const it of items) {
    if (typeof it?.deptName === 'string') byName.set(it.deptName, it);
  }

  for (const name of batch) {
    const item = byName.get(name);
    const result = normalizeItem(item);
    out.set(name, result);

    upsertDeptTaxonomy({
      dept_name: name,
      business: result.business,
      function_label: result.functionLabel,
      function_path_json: result.functionPath
        ? JSON.stringify(result.functionPath)
        : null,
      parsed_by: 'llm',
      parsed_at: now,
    });
  }
  return out;
}

type LlmResultItem = {
  deptName?: string;
  business?: string | null;
  functionPath?: string[] | null;
};

function parseLlmJson(raw: string): LlmResultItem[] {
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
    // 抠 fence / 抠最外层 {}
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) parsed = tryParse(fenced[1]);
    if (parsed === null) {
      const first = raw.indexOf('{');
      const last = raw.lastIndexOf('}');
      if (first >= 0 && last > first) parsed = tryParse(raw.slice(first, last + 1));
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as { results?: unknown };
  if (!Array.isArray(obj.results)) return [];
  return obj.results.filter((x): x is LlmResultItem => !!x && typeof x === 'object');
}

function normalizeItem(item: LlmResultItem | undefined): DeptTaxonomyResult {
  if (!item) return { business: null, functionLabel: null, functionPath: null };
  const business = typeof item.business === 'string' && item.business.trim()
    ? item.business.trim()
    : null;
  let functionPath: string[] | null = null;
  if (Array.isArray(item.functionPath)) {
    const cleaned = item.functionPath
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (cleaned.length > 0) functionPath = cleaned;
  }
  const functionLabel = functionPath ? functionPath[0] : null;
  return { business, functionLabel, functionPath };
}

function safeParsePathArray(json: string): string[] | null {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) {
      const cleaned = v.filter((x): x is string => typeof x === 'string');
      return cleaned.length ? cleaned : null;
    }
  } catch {}
  return null;
}
