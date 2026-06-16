/**
 * MVP38 — 项目排查档案召回：给定一件事项，取它所属项目(Space)的「排查档案」
 * （用户写的额外 context + 做事方法：代码库路径、trace 怎么拿、术语、常见排查套路）。
 * 注入自主排查 / 「让 AI 处理」的 prompt，让 AI 知道这个项目该去哪查、怎么查。
 *
 * MVP50：项目归属从"只看 primarySpaceId"升级为三档路由（见 projectRouter.ts）——
 * 修掉"事项没归到项目就静默拿不到档案"的断点。提供 sync（确定性，零 LLM）与 async（含 AI 兜底）两版。
 */
import { getContextSpace } from '../db.js';
import {
  resolveProjectSpaceDeterministic,
  resolveProjectSpaceWithAI,
  type RoutableMatter,
} from './projectRouter.js';

function profileOfSpace(spaceId: string | null | undefined): string | null {
  if (!spaceId) return null;
  const profile = getContextSpace(spaceId)?.investigation_profile?.trim();
  return profile || null;
}

/**
 * 取某事项所属项目的排查档案文本（无则 null）。**仅看 primarySpaceId**（向后兼容 MVP38）。
 * 新代码优先用下面两个带路由兜底的版本。
 */
export function getProjectProfileForMatter(matter: { primarySpaceId?: string | null }): string | null {
  return profileOfSpace(matter.primarySpaceId ?? null);
}

/** sync：确定性路由（primarySpaceId → canonical 别名 → 标题包含/相似），零 LLM。用于同步 prompt 构造处。 */
export function getProjectProfileForMatterDeterministic(matter: RoutableMatter): string | null {
  return profileOfSpace(resolveProjectSpaceDeterministic(matter)?.spaceId);
}

/** async：确定性优先 + AI 兜底（gated/缓存）。用于已是 async 的自主排查派发等路径。 */
export async function resolveProjectProfileForMatter(matter: RoutableMatter): Promise<string | null> {
  const route = await resolveProjectSpaceWithAI(matter);
  return profileOfSpace(route?.spaceId);
}
