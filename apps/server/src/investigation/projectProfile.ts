/**
 * MVP38 — 项目排查档案召回：给定一件事项，取它所属项目(Space)的「排查档案」
 * （用户写的额外 context + 做事方法：代码库路径、trace 怎么拿、术语、常见排查套路）。
 * 注入自主排查 / 「让 AI 处理」的 prompt，让 AI 知道这个项目该去哪查、怎么查。
 */
import { getContextSpace } from '../db.js';

/** 取某事项所属项目的排查档案文本（无则 null）。matter 需带 primarySpaceId。 */
export function getProjectProfileForMatter(matter: { primarySpaceId?: string | null }): string | null {
  if (!matter.primarySpaceId) return null;
  const space = getContextSpace(matter.primarySpaceId);
  const profile = space?.investigation_profile?.trim();
  return profile || null;
}
