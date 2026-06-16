/**
 * MVP50 — 项目归类器（AI 兜底路由）的 prompt 与解析。叶子模块（仅依赖 jsonrepair），
 * 供 projectRouter.ts 与 opencode/agents.ts 共用，避免 agents↔backgroundRuntime 循环依赖。
 *
 * 模型只输出一个 JSON：{"spaceId":"<候选id>"} 或 {"spaceId":null}。只能从给定候选 id 里选。
 */
import { jsonrepair } from 'jsonrepair';

export const PROJECT_ROUTER_SYSTEM = `你是「项目归类器」。系统给你一件正在跟进的事项(标题+摘要)，以及一组候选项目(每个有 id、名称、别名/关键词)。
判断这件事**属于哪个项目**。只输出一个合法 JSON（不要多余文字、不要 Markdown）：
{ "spaceId": "<候选项目的 id>" }  —— 命中某项目
或 { "spaceId": null }            —— 都不属于（拿不准就给 null，宁缺毋错）
**只能从候选里选 id，绝不能编造**。`;

export function buildProjectRouterMessage(
  matter: { title?: string; currentSummary?: string },
  candidates: Array<{ id: string; name: string; aliases: string[] }>
): string {
  const lines = [
    '<事项>',
    `标题：${matter.title || '(无)'}`,
    `摘要：${(matter.currentSummary || '').slice(0, 300) || '(无)'}`,
    '</事项>',
    '',
    '<候选项目>',
    ...candidates.map((c) => `- id=${c.id} 名称=${c.name}${c.aliases.length ? ` 别名=${c.aliases.join('/')}` : ''}`),
    '</候选项目>',
    '',
    '输出 JSON：{"spaceId":"<id>"} 或 {"spaceId":null}',
  ];
  return lines.join('\n');
}

/** 解析归类器回复，只接受候选集合内的 id；其余一律 null。导出供单测。 */
export function parseProjectRouterReply(text: string, validIds: Set<string>): string | null {
  let obj: unknown = null;
  try {
    obj = JSON.parse(text);
  } catch {
    try {
      obj = JSON.parse(jsonrepair(text));
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          obj = JSON.parse(jsonrepair(m[0]));
        } catch {
          obj = null;
        }
      }
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const sid = (obj as { spaceId?: unknown }).spaceId;
  return typeof sid === 'string' && validIds.has(sid) ? sid : null;
}
