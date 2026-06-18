/**
 * MVP71 — 确定性「需要你」分类器（引擎层兜底，零 LLM 调用）。
 *
 * 背景（证据优先，已对真实库核实）：MVP69 升「需要你帮忙」求助卡 100% 依赖 LLM 在 conclude 时主动填
 * needFromUser——实测模型几乎从不填（全库 0 次）。本仓库铁律「凡靠 LLM 守的纪律都要在引擎层加确定性兜底」。
 * 本模块在 LLM 没给合法 needFromUser 时，用 matter_entities 角色 + 标题模式确定性推导，**高精度优先**
 * （signal 不明确就返回 undefined、绝不升卡）。
 *
 * self 身份碎裂处理：self 配置实体 name 是占位符，真实姓名只在 attributes.larkLocalizedName；且 matter
 * 里执行人常写成独立未别名实体（刘昕明/我）。getSelfEntityIds 构造稳健 self 集（含同名+口语自指+别名），
 * 并用 larkOpenId 防同名他人误纳。
 */
import { getSetting, getContextEntityById, listContextEntitiesByName, listEntityIdsAliasedTo } from '../db.js';
import { resolveAliased } from '../context/entityResolver.js';
import { parsePersonAttributesFromRow } from '../context/personAttributes.js';
import type { Matter } from '../matter/matterTypes.js';
import type { NeedFromUser } from './investigationPrompt.js';

const SELF_ENTITY_SETTING_KEY = 'self_person_entity_id';

// ---- self 身份集（模块级缓存；settings/实体表低频变化，提供 invalidate 供测试/变更后刷新）----
let selfSetCache: { set: Set<string>; selfId: string } | null = null;
export function invalidateSelfEntityCache(): void {
  selfSetCache = null;
}

/**
 * 稳健 self 身份集：{ resolveAliased(self) } ∪ { alias_of==self } ∪
 *   { type=person 且 name===self.larkLocalizedName 且 (无 openid 或 openid==self.openid) } ∪
 *   { type=person 且 name==='我' }。
 * 关键：localizedName 取自 attributes.larkLocalizedName（**不是** entity.name，那是占位符）。
 * openid 防撞名守卫：同名候选若自带与 self 不同的 openid → 判为同名他人，剔除。
 */
export function getSelfEntityIds(): Set<string> {
  const selfRaw = getSetting(SELF_ENTITY_SETTING_KEY);
  if (!selfRaw) return new Set();
  const selfId = resolveAliased(selfRaw);
  if (selfSetCache && selfSetCache.selfId === selfId) return selfSetCache.set;

  const out = new Set<string>([selfId]);
  const selfRow = getContextEntityById(selfId);
  const selfAttrs = selfRow ? parsePersonAttributesFromRow(selfRow) : null;
  const selfOpenId = selfAttrs?.larkOpenId;
  const localizedName = selfAttrs?.larkLocalizedName?.trim();

  for (const id of listEntityIdsAliasedTo(selfId)) out.add(resolveAliased(id));

  if (localizedName) {
    for (const p of listContextEntitiesByName(localizedName, 'person')) {
      const pa = parsePersonAttributesFromRow(p);
      // 候选自带 openid 且与 self 不同 → 同名他人，剔除；openid 为空（如纯文本提及实体）才按名纳入。
      if (pa?.larkOpenId && selfOpenId && pa.larkOpenId !== selfOpenId) continue;
      out.add(resolveAliased(p.id));
    }
  }
  for (const p of listContextEntitiesByName('我', 'person')) out.add(resolveAliased(p.id));

  selfSetCache = { set: out, selfId };
  return out;
}

export function isSelf(entityId: string, selfSet: Set<string>): boolean {
  return selfSet.has(resolveAliased(entityId));
}

// ---- 具名他人判定（owned_by_other 用）----
const PRONOUNS = new Set(['我', '你', '他', '她', '对方', '大家', '各位', '他们', '她们']);
/** 是否一个"具名的、非我的真人"。主过滤 type=person；名长 2-12；排除代词；防御性挡 URL/任务 id。 */
export function isNamedOtherPerson(
  entity: { id: string; name: string; type: string },
  selfSet: Set<string>
): boolean {
  if (entity.type !== 'person') return false;
  if (isSelf(entity.id, selfSet)) return false;
  const n = (entity.name ?? '').trim();
  if (n.length < 2 || n.length > 12) return false;
  if (PRONOUNS.has(n)) return false;
  if (/[:/@]|https?:|lark_task|feishu|larkoffice|meego/i.test(n)) return false;
  return true;
}

// ---- A 类：你欠的承诺（dangling 用）----
// 仅匹配「（对{2-6字人名}承诺）」括注真实写法；挡 反对/针对/面对/对接/对齐…承诺 这类误命中。
const SELF_COMMIT_RE = /[（(]对([^）)]{2,6})承诺[）)]/;
export function isSelfCommitmentByTitle(title: string): boolean {
  const m = SELF_COMMIT_RE.exec(title || '');
  if (!m) return false;
  if (/^(对接|对齐)/.test(m[1])) return false;
  return true;
}

/**
 * 是否"你欠的承诺"（A 类，走 dangling）。三信号高精度（任一中即是）：
 *  ① 标题「（对X承诺）」括注；② executor ∈ selfSet；③ owner_entity_id ∈ selfSet。
 */
export function isSelfCommitment(
  matter: Pick<Matter, 'title' | 'ownerEntityId'>,
  executorEntityIds: string[],
  selfSet: Set<string>
): boolean {
  if (isSelfCommitmentByTitle(matter.title)) return true;
  if (executorEntityIds.some((id) => isSelf(id, selfSet))) return true;
  if (matter.ownerEntityId && isSelf(matter.ownerEntityId, selfSet)) return true;
  return false;
}

// ---- B 类：进展在具名他人名下（owned_by_other，走 needhelp）----
export const MAX_OWNED_BY_OTHER_EXECUTORS = 2;

/**
 * 兜底推导 needFromUser（仅当 LLM 没给合法的）。当前只产 owned_by_other（B 类），高精度门：
 *  - verdict ∈ {unknown, blocked} 且 conf>0（conf=0 静默，降噪红线）；
 *  - executor 里有 1~2 个具名他人（≥3 视为群/评审事项，静默）；
 *  - 我不是 executor；且我是 requester（只有"我委派出去"的才归我催，纯旁观群事项不升）。
 * 其余（含 A 类自承诺）返回 undefined——A 类由 dangling 静态扫描兜。
 */
export function deriveNeedFromUser(
  conclusion: { verdict: string; confidence: number },
  ctx: { entities: Array<{ id: string; name: string; type: string; role: string }>; selfSet: Set<string> }
): NeedFromUser | undefined {
  if (conclusion.verdict !== 'unknown' && conclusion.verdict !== 'blocked') return undefined;
  if (conclusion.confidence <= 0) return undefined;

  const execs = ctx.entities.filter((e) => e.role === 'executor');
  const execOthers = execs.filter((e) => isNamedOtherPerson(e, ctx.selfSet));
  const iAmExecutor = execs.some((e) => isSelf(e.id, ctx.selfSet));
  const iAmRequester = ctx.entities.some((e) => e.role === 'requester' && isSelf(e.id, ctx.selfSet));

  if (
    execOthers.length >= 1 &&
    execOthers.length <= MAX_OWNED_BY_OTHER_EXECUTORS &&
    !iAmExecutor &&
    iAmRequester
  ) {
    const who = execOthers.map((e) => e.name).slice(0, 2).join('、');
    // 措辞对齐确实可用的 inline 回填路径（你告诉我对方进展 → KEYSTONE 把它喂回重查 → AI 据此 conclude）。
    // 不过度承诺"帮你起草去问"（draft 在系统卡上下文薄，留作后续）。
    return {
      kind: 'owned_by_other',
      ask: `这件事的进展在 ${who} 名下、我查不到。如果你已经知道结果，直接告诉我（比如"${who}说已完成/还在做"），我据此把它接着办了。`,
    };
  }
  return undefined;
}
