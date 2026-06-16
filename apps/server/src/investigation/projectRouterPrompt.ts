/**
 * MVP50 — 项目归类器（AI 兜底路由）的 prompt 与解析。叶子模块（仅依赖 jsonrepair），
 * 供 projectRouter.ts 与 opencode/agents.ts 共用，避免 agents↔backgroundRuntime 循环依赖。
 *
 * 模型只输出一个 JSON：{"spaceId":"<候选id>"} 或 {"spaceId":null}。只能从给定候选 id 里选。
 */
import { jsonrepair } from 'jsonrepair';

export const PROJECT_ROUTER_SYSTEM = `你是「项目归类器」。系统给你一件正在跟进的事项(标题+摘要)，以及一组候选项目(每个有 id、名称、别名/关键词)。
判断这件事**真正属于哪个项目**。只输出一个合法 JSON（不要多余文字、不要 Markdown）：
{ "spaceId": "<候选项目的 id>" }  —— 确实属于某候选项目
或 { "spaceId": null }            —— 都不属于

判定纪律（重要）：
- **即使只有一个候选项目**，若这件事并不属于它（只是顺带提到、或八竿子打不着），也必须返回 {"spaceId":null}。不要因为"只有一个候选"就勉强归类。
- 标题里"提到"某项目名 ≠ 这件事"属于"该项目（如"把 A 集成进 B"多半属于 B 而非 A）。拿不准就给 null，**宁可漏判也别错配**（错配会把别的项目的资料喂给 AI，更糟）。
- **只能从候选里选 id，绝不能编造**。

例：候选只有 [id=sp_chat 名称=Chatbot]，事项"订单链路里 Chatbot 调用超时"——这属于订单/履约，不属于 Chatbot → {"spaceId":null}。`;

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
