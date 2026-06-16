/**
 * MVP50 — 项目路由：决定一件事项(matter)属于哪个项目(context_space)，从而把该项目的
 * 自然语言「排查档案」(investigation_profile) 拼进处理它的 prompt。
 *
 * 用户愿景：在一个大输入框里写完整的项目自然语言配置，AI **按不同项目/不同情况自动决定**
 * 是否把它拼进 prompt。落地为三档路由，**确定性优先、省 token**：
 *   ① primarySpaceId —— reducer 已按实体确定性归属（零成本，多数情况）。
 *   ② 确定性兜底 —— canonical 别名(resolveProjectCanonical→权威 space) + 标题包含/相似。纯 JS，零 LLM。
 *   ③ AI 兜底（用户已开启「允许 AI 判断」）—— 仅当 ①② 全落空时打一次轻量 one-shot，从候选项目里挑一个；
 *      **按 matterId 缓存**(含 null)，同一事项不重复打；config.projectRoutingAiEnabled 可关。
 *
 * 关键安全：标题档要求**唯一胜出**(并列/接近不采纳，宁缺毋错，避免把 A 项目的档案误拼进 B)；
 * AI 只能从给定候选 id 里选，越界/编造 id 一律丢弃。
 */
import {
  getContextEntityById,
  getContextSpace,
  getProjectAuthoritativeSpaceId,
  listContextSpaces,
  resolveProjectCanonical,
  type ContextSpaceRow,
} from '../db.js';
import { listMatterEntities } from '../matter/matterStore.js';
import { titleSimilarity } from '../matter/matterMatcher.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { config } from '../config.js';
import { buildProjectRouterMessage, parseProjectRouterReply } from './projectRouterPrompt.js';

export type ProjectRouteBasis = 'primary' | 'canonical' | 'title' | 'ai';
export type ProjectRoute = { spaceId: string; basis: ProjectRouteBasis } | null;

export type RoutableMatter = {
  id?: string;
  primarySpaceId?: string | null;
  title?: string;
  currentSummary?: string;
};

// 标题路由很容易误判（标题里顺带提了个项目名 ≠ 这件事属于该项目），故极保守：
// (a) 仅当**独特**的项目名/别名作为子串**唯一**出现在标题里才采纳（多个命中=歧义→交给 AI 兜底）；
// (b) 否则要求**很强**的整体标题相似（短/通用/顺带提及达不到，自然落到 AI 用全上下文判）。
const STRONG_SIM_FLOOR = 0.6; // 无包含命中时的整体相似门槛
const SIM_MARGIN = 0.1; // 多候选时领先第二名的最小差

/** 名字是否"足够独特"，可信其子串出现：≥4 个 CJK 字 或 ≥8 个英数字。短/通用名（test/报错/Chatbot）不可信。 */
export function isDistinctiveName(name: string): boolean {
  const n = name.trim();
  const cjk = (n.match(/[一-鿿]/g) || []).length;
  const alnum = (n.match(/[a-zA-Z0-9]/g) || []).length;
  return cjk >= 4 || alnum >= 8;
}

function parseAliases(space: ContextSpaceRow): string[] {
  try {
    const j = JSON.parse(space.intent_json || '{}') as { aliases?: unknown };
    return Array.isArray(j.aliases) ? j.aliases.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function profileNonEmpty(spaceId: string): boolean {
  return Boolean(getContextSpace(spaceId)?.investigation_profile?.trim());
}

/** 收集 matter 上 project/org 类实体名 + 标题，作为 canonical 别名匹配的候选词。 */
function projectNameCandidates(matter: RoutableMatter): string[] {
  const names: string[] = [];
  if (matter.id) {
    for (const link of listMatterEntities(matter.id)) {
      const e = getContextEntityById(link.entityId);
      if (e && (e.type === 'project' || e.type === 'org')) names.push(e.name);
    }
  }
  if (matter.title) names.push(matter.title);
  return names;
}

/**
 * 确定性项目路由（零 LLM）：primary → canonical 别名 → 标题包含/相似。返回 spaceId+依据，或 null。
 * 纯函数（只读 DB），可单测。
 */
export function resolveProjectSpaceDeterministic(matter: RoutableMatter): ProjectRoute {
  if (matter.primarySpaceId) return { spaceId: matter.primarySpaceId, basis: 'primary' };

  // ② canonical 别名 → 权威 space（MVP19 org_project_taxonomy，确定性字面匹配）
  for (const name of projectNameCandidates(matter)) {
    const canonical = resolveProjectCanonical(name);
    const sid = getProjectAuthoritativeSpaceId(canonical);
    if (sid) return { spaceId: sid, basis: 'canonical' };
  }

  // ③ 标题路由（极保守，见上方常量注释）
  const title = (matter.title || '').trim();
  if (title) {
    const titleLower = title.toLowerCase();
    const spaces = listContextSpaces({ status: 'active' }).filter((s) => s.type === 'project');
    // (a) 独特名/别名作为子串出现：唯一命中才采纳；≥2 命中=歧义 → 不采纳（交给 AI 用全上下文判）
    const contained = spaces.filter((s) =>
      [s.name, ...parseAliases(s)].some(
        (c) => isDistinctiveName(c) && titleLower.includes(c.trim().toLowerCase())
      )
    );
    if (contained.length === 1) return { spaceId: contained[0].id, basis: 'title' };
    if (contained.length >= 2) return null;
    // (b) 无包含命中：要求很强的整体标题相似（短/顺带提及的项目名达不到，自然落到 AI 兜底）
    const scored = spaces
      .map((s) => {
        const cands = [s.name, ...parseAliases(s)].filter(Boolean);
        const sim = cands.reduce((m, c) => Math.max(m, titleSimilarity(title, c)), 0);
        return { sid: s.id, sim };
      })
      .filter((x) => x.sim >= STRONG_SIM_FLOOR)
      .sort((a, b) => b.sim - a.sim);
    if (scored.length === 1 || (scored.length >= 2 && scored[0].sim - scored[1].sim >= SIM_MARGIN)) {
      return { spaceId: scored[0].sid, basis: 'title' };
    }
  }
  return null;
}

// ---- ③ AI 兜底（缓存，gated） ----

// 进程内缓存（key=matterId，值含 null）。重启即清，足够。
const aiRouteCache = new Map<string, ProjectRoute>();

export function _clearProjectRouterCache(): void {
  aiRouteCache.clear();
}

type RouterDeps = { judge?: (msg: string) => Promise<string> };

async function defaultRouterJudge(msg: string): Promise<string> {
  const r = await runOneShot(msg, { agentName: 'aiisn-project-router', lane: 'investigation', priority: false });
  return r.text;
}

/** AI 兜底归类（仅当确定性落空时调用）。gated + 缓存。deps 可注入单测。 */
export async function resolveProjectSpaceAI(matter: RoutableMatter, deps: RouterDeps = {}): Promise<ProjectRoute> {
  if (!config.projectRoutingAiEnabled) return null;
  const key = matter.id;
  if (key && aiRouteCache.has(key)) return aiRouteCache.get(key)!;

  // 候选 = 有非空档案的 active project space（没档案的项目即便命中也没东西可拼，不必问）
  const candidates = listContextSpaces({ status: 'active' })
    .filter((s) => s.type === 'project' && profileNonEmpty(s.id))
    .map((s) => ({ id: s.id, name: s.name, aliases: parseAliases(s) }));
  if (candidates.length === 0) {
    if (key) aiRouteCache.set(key, null);
    return null;
  }

  let route: ProjectRoute = null;
  try {
    const judge = deps.judge ?? defaultRouterJudge;
    const text = await judge(buildProjectRouterMessage(matter, candidates));
    const sid = parseProjectRouterReply(text, new Set(candidates.map((c) => c.id)));
    if (sid) route = { spaceId: sid, basis: 'ai' };
  } catch {
    route = null; // 路由失败 → 不拼，绝不阻断
  }
  if (key) aiRouteCache.set(key, route);
  return route;
}

/** 完整路由：确定性优先，落空再 AI 兜底（gated）。 */
export async function resolveProjectSpaceWithAI(matter: RoutableMatter, deps: RouterDeps = {}): Promise<ProjectRoute> {
  const det = resolveProjectSpaceDeterministic(matter);
  if (det) return det;
  return resolveProjectSpaceAI(matter, deps);
}
