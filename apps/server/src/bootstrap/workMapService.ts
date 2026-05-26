/**
 * MVP7 Work Map 业务封装。
 * - getCurrentWorkMap()：查当前已确认 Work Map（work scope 且 mergeKey 以 'work_map:' 开头）
 * - confirmWorkMap(draft)：转交 workMapWriter
 * - generateDraft(...)：MVP7.1 才实现，MVP7.0 留个 stub 抛 NotImplemented
 */

import {
  getContextEntityById,
  getSetting,
  listContextSpaces,
  listPersonEntitiesWithOpenIdAlias,
  listSpaceLinks,
} from '../db.js';
import { listActiveContextUnits } from '../context/contextStore.js';
import { listActiveBoundaryRules } from '../boundary/boundaryStore.js';
import { scoreContextUnit } from '../context/activeContext.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import type { BoundaryRule } from '../boundary/BoundaryRule.js';
import type {
  WorkMapDraft,
  WorkMapWriteSummary,
} from './workMapTypes.js';
import { writeWorkMap } from './workMapWriter.js';
import {
  parsePersonAttributesFromRow,
  type OrgRoleFromMe,
  type PersonAttributes,
} from '../context/personAttributes.js';
import { computeOrgRoleFromMe } from '../context/personOrgRole.js';
import {
  WORK_MAP_DRAFT_SYSTEM_PROMPT,
  parseWorkMapDraft,
  sanitizeExcerpt,
} from './workMapDraftPrompt.js';
import { runOneShot } from '../triage/backgroundRuntime.js';

// MVP15 §4: stakeholder 在组织里的关系信息（前端 chip + attention prompt 都消费这个结构）
export type StakeholderOrgInfo = {
  role: OrgRoleFromMe;
  business?: string;
  functionLabel?: string;
};

export type CurrentWorkMap = {
  bootstrapCompletedAt: string | null;
  role: ContextUnit | null;
  responsibilities: ContextUnit[];
  goals: ContextUnit[];
  commitments: ContextUnit[];
  risks: ContextUnit[];
  preferences: ContextUnit[];
  relationships: ContextUnit[];
  /**
   * MVP15 §4: 与 `relationships` 平行的 orgRole + 解析后业务/职能信息，key 为 person
   * entity 的 name。缺失 = 未连接飞书 / 不可判定。前端用来渲染 stakeholder chip。
   */
  stakeholderOrgRoles: Record<string, StakeholderOrgInfo>;
  spaces: Array<{
    id: string;
    name: string;
    description: string | null;
    docCount: number;
  }>;
  boundaryRules: BoundaryRule[];
};

export function getCurrentWorkMap(): CurrentWorkMap {
  const bootstrapCompletedAt = getSetting('bootstrap_completed_at');
  const units = listActiveContextUnits({ limit: 1000 }).filter(
    (u) => u.scope === 'work' && u.mergeKey?.startsWith('work_map:')
  );
  const role =
    units.find((u) => u.mergeKey === 'work_map:role:self') ?? null;
  const responsibilities = units.filter((u) =>
    u.mergeKey?.startsWith('work_map:responsibility:')
  );
  const goals = units.filter((u) => u.mergeKey?.startsWith('work_map:goal:'));
  const commitments = units.filter((u) =>
    u.mergeKey?.startsWith('work_map:commitment:')
  );
  const risks = units.filter((u) => u.mergeKey?.startsWith('work_map:risk:'));
  const preferences = units.filter((u) =>
    u.mergeKey?.startsWith('work_map:preference:')
  );
  const relationships = units.filter((u) =>
    u.mergeKey?.startsWith('work_map:relationship:')
  );

  const projectSpaces = listContextSpaces({ status: 'active', limit: 50 }).filter(
    (s) => s.type === 'project'
  );
  const spaces = projectSpaces.map((s) => {
    const links = listSpaceLinks(s.id);
    const docCount = links.filter((l) => l.target_type === 'entity').length;
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      docCount,
    };
  });

  // 只展示 source='manual' 的 boundary rule（Work Map 写入），用户在 RulesPanel
  // 已能看到 card_action / migration 来的规则。
  const boundaryRules = listActiveBoundaryRules().filter(
    (r) => r.source === 'manual'
  );

  const stakeholderOrgRoles = computeStakeholderOrgRoles(relationships);

  return {
    bootstrapCompletedAt,
    role,
    responsibilities,
    goals,
    commitments,
    risks,
    preferences,
    relationships,
    stakeholderOrgRoles,
    spaces,
    boundaryRules,
  };
}

/**
 * MVP15 §4: 把"所有已知 person entity"映射到 orgRole（key=entity.name）。
 *
 * 关键设计变更（2026-05-26 dogfood 反馈）：
 *   - 旧实现只覆盖**已确认 relationship** 的人 → 草稿阶段没法显示 chip
 *   - 新实现覆盖**所有有 attributes_json 的 person entity**（≈ larkOrgCollector 同步过的）
 *   - 这样 generateWorkMapDraft 出的草稿里只要某个名字匹配已知 entity，chip 就出来
 *
 * orgRole 在 read 时现算，**不依赖 attributes_json.orgRoleFromMe 是否预先写入**。
 * 这是为了兼容这种情况：collector 同步某 person 时 self 还没缓存，导致 orgRoleFromMe
 * 没写进 attrs；下次 self 同步成功后，无需重刷其他 entity 也能得到正确 orgRole。
 *
 * 入参 relationships 现在不需要——保留签名是为了减少调用方改动。
 */
function computeStakeholderOrgRoles(
  _relationships: ContextUnit[]
): Record<string, StakeholderOrgInfo> {
  const out: Record<string, StakeholderOrgInfo> = {};
  const self = loadSelfAttributes();
  const selfId = getSetting('self_person_entity_id');
  const candidates = listPersonEntitiesWithOpenIdAlias(500);
  for (const row of candidates) {
    // 跳过 self —— 自己不该是自己的 stakeholder
    if (selfId && row.id === selfId) continue;
    if (!row.attributes_json) continue;
    const target = parsePersonAttributesFromRow(row);
    if (!target) continue;
    // 双保险：open_id 也对比
    if (self && target.larkOpenId && target.larkOpenId === self.larkOpenId) continue;
    const role = computeOrgRoleFromMe(self, target);
    if (!role) continue;
    const info: StakeholderOrgInfo = { role };
    if (target.larkDeptBusiness) info.business = target.larkDeptBusiness;
    if (target.larkDeptFunctionLabel) info.functionLabel = target.larkDeptFunctionLabel;
    out[row.name] = info;
  }
  return out;
}

function loadSelfAttributes(): PersonAttributes | null {
  const id = getSetting('self_person_entity_id');
  if (!id) return null;
  const row = getContextEntityById(id);
  if (!row) return null;
  return parsePersonAttributesFromRow(row);
}

export function confirmWorkMap(draft: WorkMapDraft): WorkMapWriteSummary {
  return writeWorkMap(draft);
}

// ---------------- MVP7.1: LLM 草稿 ----------------

const TOKEN_BUDGET_DEFAULT = 8000;
const TOKEN_BUDGET_HARD = 10000;

// 按 kind 分桶 cap（§4.5）
const PER_KIND_CAPS: Record<string, number> = {
  goal: 10,
  commitment: 10,
  uncertainty: 10, // 我们 risk 对应 uncertainty
  decision: 10,
  event: 20,
};
const OTHER_KIND_TOTAL_CAP = 30;

type DraftCandidate = {
  unit: ContextUnit;
  score: number;
};

function estimateItemTokens(item: { title: string; meaning?: string; excerpt?: string }): number {
  const t = item.title?.length ?? 0;
  const m = item.meaning?.length ?? 0;
  const e = item.excerpt?.length ?? 0;
  // ~2 chars/token 中文；与 activeContext 估计一致
  return Math.ceil((t + m + e) / 2);
}

type LlmInputItem = {
  kind: string;
  title: string;
  meaning?: string;
  excerpt?: string;
  entities: string[];
  time?: { occurredAt?: string; dueAt?: string; startsAt?: string };
  confidence: number;
  updatedAt: string;
};

function unitToLlmItem(u: ContextUnit): LlmInputItem {
  const includeExcerpt = !u.meaning || (u.confidence ?? 0) < 0.5;
  return {
    kind: u.kind,
    title: u.title,
    meaning: u.meaning,
    excerpt: includeExcerpt ? sanitizeExcerpt(u.content) || undefined : undefined,
    entities: (u.entities ?? []).map((e) => `${e.type}:${e.name}`).slice(0, 6),
    time: u.time
      ? {
          occurredAt: u.time.occurredAt,
          dueAt: u.time.dueAt,
          startsAt: u.time.startsAt,
        }
      : undefined,
    confidence: u.confidence,
    updatedAt: u.updatedAt,
  };
}

function buildLlmInput(
  candidates: DraftCandidate[],
  budget: number
): { items: LlmInputItem[]; tokenEstimate: number; truncated: number } {
  // per-kind cap
  const byKind = new Map<string, DraftCandidate[]>();
  for (const c of candidates) {
    const arr = byKind.get(c.unit.kind) ?? [];
    arr.push(c);
    byKind.set(c.unit.kind, arr);
  }
  const capped: DraftCandidate[] = [];
  let otherUsed = 0;
  for (const [kind, arr] of byKind) {
    const cap = PER_KIND_CAPS[kind];
    if (cap !== undefined) {
      capped.push(...arr.slice(0, cap));
    } else {
      const room = Math.max(0, OTHER_KIND_TOTAL_CAP - otherUsed);
      if (room <= 0) continue;
      const take = arr.slice(0, room);
      capped.push(...take);
      otherUsed += take.length;
    }
  }
  capped.sort((a, b) => b.score - a.score);

  // token budget
  const items: LlmInputItem[] = [];
  let used = 0;
  let truncated = 0;
  for (const c of capped) {
    const item = unitToLlmItem(c.unit);
    const est = estimateItemTokens(item);
    if (used + est > budget) {
      truncated++;
      continue;
    }
    items.push(item);
    used += est;
  }
  return { items, tokenEstimate: used, truncated };
}

export type GenerateDraftOpts = {
  seedText?: string;
  lookbackDays?: number;
  mode?: 'full' | 'incremental';
  budgetTokens?: number;
  /** 测试钩子：传入则跳过 runOneShot，直接用此函数生成文本（用于离线 eval）。 */
  llmHook?: (
    userMessage: string,
    system: string
  ) => Promise<string>;
};

export async function generateWorkMapDraft(
  opts: GenerateDraftOpts = {}
): Promise<{
  draft: WorkMapDraft;
  tokenEstimate: number;
  itemsConsidered: number;
  itemsTruncated: number;
  rawText: string;
  /** 实际跑这次草稿的模型 id；由 runOneShot 返回的 raw.model 透出，stub 路径为 null。 */
  modelId: string | null;
}> {
  const budget = Math.min(opts.budgetTokens ?? TOKEN_BUDGET_DEFAULT, TOKEN_BUDGET_HARD);
  const lookbackMs = (opts.lookbackDays ?? 14) * 86400_000;
  const now = Date.now();
  const since = new Date(now - lookbackMs).toISOString();
  const completedAt = getSetting('bootstrap_completed_at');

  // 拉 scope=work 的 active units
  const all = listActiveContextUnits({ limit: 1000 }).filter((u) => u.scope === 'work');
  const filtered = all.filter((u) => {
    // 增量模式：仅取 confirm 后变动的 + 当前 Work Map 自身条目
    if (opts.mode === 'incremental' && completedAt) {
      const isWorkMap = u.mergeKey?.startsWith('work_map:');
      return isWorkMap || u.updatedAt > completedAt;
    }
    // 全量：lookback 内的，但 Work Map 自身永远进
    return u.mergeKey?.startsWith('work_map:') || u.updatedAt >= since;
  });

  const candidates: DraftCandidate[] = filtered.map((u) => ({
    unit: u,
    score: scoreContextUnit(u, now),
  }));
  candidates.sort((a, b) => b.score - a.score);

  const { items, tokenEstimate, truncated } = buildLlmInput(candidates, budget);

  // 当前 Work Map summary（用于增量草稿；全量模式也带，让 LLM 知道已有什么）
  const summarySnapshot = summarizeCurrentForLlm();

  const userMessage = [
    opts.seedText ? `seedText（用户的自描述）：\n${opts.seedText.trim()}\n` : '',
    summarySnapshot
      ? `已有 Work Map 快照（仅参考，避免重复发明）：\n<current>\n${summarySnapshot}\n</current>\n`
      : '',
    `近期 work-scope context（按价值排序，共 ${items.length} 条；截掉 ${truncated} 条更低相关性）：`,
    '<context>',
    JSON.stringify(items, null, 2),
    '</context>',
    '',
    '只输出 JSON，无 Markdown。',
  ]
    .filter(Boolean)
    .join('\n');

  let rawText: string;
  let modelId: string | null = null;
  if (opts.llmHook) {
    rawText = await opts.llmHook(userMessage, WORK_MAP_DRAFT_SYSTEM_PROMPT);
  } else {
    const shot = await runOneShot(userMessage, {
      agentName: 'aiisn-work-map',
      systemPrompt: WORK_MAP_DRAFT_SYSTEM_PROMPT,
      timeoutMs: 120_000,
    });
    rawText = shot.text;
    const raw = shot.raw as Record<string, unknown> | null;
    // opencode runOneShot 在 raw 里直接给出 model id（例: "zai-coding-plan/glm-5.1"）
    if (raw && typeof raw.model === 'string') {
      modelId = raw.model;
    }
  }

  const draft = parseWorkMapDraft(rawText);

  // MVP15 §4 (revision): 防御性过滤 self —— 即使 LLM 没遵守 prompt 把自己加进 stakeholders，
  // 服务端也兜底剔除。按 self.larkLocalizedName 字符串相等比较（trim 后）。
  const selfAttrs = loadSelfAttributes();
  const selfName = selfAttrs?.larkLocalizedName?.trim();
  if (selfName && draft.stakeholders.length > 0) {
    const before = draft.stakeholders.length;
    draft.stakeholders = draft.stakeholders.filter(
      (s) => s.name.trim() !== selfName
    );
    if (draft.stakeholders.length < before) {
      console.log(
        `[workMapDraft] filtered self ('${selfName}') from stakeholders: ${before} → ${draft.stakeholders.length}`
      );
    }
  }

  return {
    draft,
    tokenEstimate,
    itemsConsidered: items.length,
    itemsTruncated: truncated,
    rawText,
    modelId,
  };
}

function summarizeCurrentForLlm(): string {
  const cur = getCurrentWorkMap();
  if (!cur.bootstrapCompletedAt) return '';
  const lines: string[] = [];
  if (cur.role) lines.push(`role: ${cur.role.title}`);
  if (cur.responsibilities.length)
    lines.push(`responsibilities: ${cur.responsibilities.map((u) => u.title).join('; ')}`);
  if (cur.spaces.length) lines.push(`projects: ${cur.spaces.map((s) => s.name).join(', ')}`);
  if (cur.goals.length) lines.push(`goals: ${cur.goals.map((u) => u.title).join('; ')}`);
  if (cur.commitments.length)
    lines.push(`commitments: ${cur.commitments.map((u) => u.title).join('; ')}`);
  if (cur.preferences.length)
    lines.push(`preferences: ${cur.preferences.map((u) => u.title).join('; ')}`);
  return lines.join('\n');
}
