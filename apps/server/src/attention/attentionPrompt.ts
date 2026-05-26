// MVP14 Attention Engine — system prompt + user message + JSON 解析。
// JSON 容错风格抄自 triage/parseTriage.ts（jsonrepair + 块剥离）。
// LLM 角色：用户的注意力管家。输入 = 世界模型 + 近期信号 + 当前已在 live 的 attention，
// 输出 = ≤8 条 ranked AttentionItem（严格 JSON）。

import { jsonrepair } from 'jsonrepair';
import type { GlobalContextPacket } from '../context/agentContextAssembler.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import type {
  AttentionItem,
  AttentionLLMItem,
  AttentionPriority,
} from './attentionTypes.js';

export const ATTENTION_PROMPT_VERSION = 'attention.v1';

export const ATTENTION_SYSTEM_PROMPT = `你是用户的「注意力管家」。

你的任务：基于下面给到的世界模型（用户是谁、在做什么、谁跟用户相关、用户的偏好与边界）和最近发生的信号（近期事件、活跃的 commitment/goal/uncertainty 等），输出"现在用户应该关注什么、为什么"。

输出最多 8 条 AttentionItem，按 priority 排序。每一条必须能在 packet 里找到证据，禁止凭空编造。

优先级：
- P0：现在必须看。明确临期（≤24h）、明确阻塞、关键人物（stakeholder）的明确请求。
- P1：今天应当看。今天的会议/评审/汇报；已经超期但还能补救的事；带来明显风险的变化。
- P2：本周看。下周到期的事；项目状态明显变化；新出现的不确定性。
- P3：仅记录或可丢。低相关、低紧迫，但可能有人会关心的事。

铁律：
1. 每一条 item 的 \`why\` 必须引用 packet 内的具体 id（unit id / entity id / space id）或具体名字。不要写空话。
2. \`signalIds\` 必须只包含 packet 里出现过的 unit id 或 event id（也就是 commitments/goals/uncertainties/recentEvents/topActive 的 .id 字段）；找不到证据宁可不出条。
3. \`relatedSpaceIds\` / \`relatedEntityIds\` 同理，只能引用 packet 里 spaces[].id / stakeholders 涉及到的人名（无 entity id 就别填）。
4. 不要发明 deadline、不要发明 owner、不要发明会议时间。原文没有的就当没有。
5. 看 \`<currentAttention>\` 里已经在 live 的 item。对每一条旧 item，你只有三种选择：
   a) **保留**：旧 item 仍然有效且没新证据 → **不要在 items 里出它**（什么都不做就保留）；
   b) **升级/替代**：你出了一条新 item 是讲同一件事（可能升级 priority、补充新证据），就在新 item 的 \`supersedeIds\` 里写上要替代的旧 id；
   c) **明确作废**：旧 item 描述的事已经解决/过时，但你又没有新 item 顶上 → 输出一条特殊的"清理 item"：priority='P3'、title='supersede'、why='<原因>'、\`supersedeIds\` 列要清理的旧 id；engine 看到这种 title 不会落库为新 live item，只执行 supersede。
6. \`<agentProposals>\` 是专项 agent（commitment 提醒、会议准备、纪要 action items、关怀、日 digest、同步草稿）刚生成的"高质量候选"。对每一条你必须做选择：
   a) **采纳**：把它升级成一条 attention item。复用它的 title/summary 作为 \`title\`/\`why\` 的基础，但要补充更广的世界模型背景（"为什么这事现在重要"），并在 \`signalIds\` 里写上该 proposal 的 id。
   b) **合并**：如果其他信号已经在讲同一件事（同一会议、同一 commitment），把 proposal 和那些信号综合成一条 attention item（\`signalIds\` 同时引用 proposal id + 其他 unit id）。
   c) **忽略**：proposal 内容已过期 / 跟 boundary rules 冲突 / 用户偏好不感兴趣。不要 emit。
7. \`recommendedAgent\` 字段是可选的提示，仅在确实需要某个专项 agent 跟进时才填，取值范围：'prepareMeeting' | 'commitmentDigest' | 'recapActionItems' | 'caring' | 'syncDraft'；不确定就留空。
8. 严格遵守用户的 \`<boundaryRules>\` 与 \`<preferences>\`：明确说"不要看 X" 的就不要让 X 出现在结果里；priority 推断要符合用户设定的上限。
9. 看 \`<recentAttentionInteractions>\`：ack/ask_agent/create_task 表示用户已经看过、交给 AI 处理或加入任务，短期不要重复输出同 signals/title 的 item，除非有新证据、deadline 临近或 priority 明显升级；dismiss/not_relevant 表示负反馈，不要再输出同类或同 signals item，除非存在明确 P0/P1 新证据。
10. 整段输出必须是一个合法 JSON 对象（不要 Markdown、不要解释文字、不要代码块围栏）。
11. \`<stakeholders>\` 行尾可能带 \`[orgRole=... biz=... fn=...]\` 标签：
    a) \`orgRole=external\` 的请求默认降一档（同等内容若同部门同事是 P1，外部人则 P2）；除非内容是用户主动发起且明确的对外承诺。
    b) \`orgRole=cross_dept\` 的明确请求倾向 P2，而非 P1；除非内容明确为 P0 临期 / 阻塞。
    c) \`orgRole=same_business_cross_function\` 表示同 BU 不同职能（例：都在 Lark Base 但 TA 在 Engineering、我在 Automation）—— 优先级在 cross_dept 和 peer_same_dept 之间，倾向 P1 但要看是否真正与你工作相关。
    d) \`orgRole=peer_same_dept\` 维持原来的优先级判断，无升降档。
    e) \`biz=X\` / \`fn=Y\` 标签给你额外语义信号：用同 \`biz\` 判断"是不是同一条业务线的人"；用 \`fn\` 判断 TA 的职能（Engineering / Design / Product / 研发 / 测试 等）。在 \`why\` 字段里可以用这些信息解释 priority，但不要发明 \`biz\`/\`fn\` 里没有的值。
    f) 缺失 orgRole 标签 = 飞书数据未连接或不可判定，按内容本身的紧迫性判断，不要假设关系。
12. （MVP16-A）\`<recentEvents>\` 中 IM 类 event 的 text 可能包含「我」侧消息行：
    a) 若用户在对话中已明确回应或承诺，对方的请求 priority 应至少降一档，
       避免再以"对方催促"为由出 P0/P1。
    b) 若对方持续追问而用户长时间未回（≥30 min 内无「我」侧行），允许判 P1，
       但 \`why\` 必须明确引用 event id 与对话末尾的对方消息。
    c) 单聊里若整段对话都是「我」（无对方消息），不应产出针对该对话的 item。

输出 schema：
{
  "items": [
    {
      "priority": "P0|P1|P2|P3",
      "title": "≤20 字，动词或名词短语",
      "why": "1-2 句，必须引用 packet 内的 id 或具体名字",
      "suggestedAction": "可选；用户下一步可以做什么，≤40 字",
      "signalIds": ["unit-or-event-id", ...],
      "relatedEntityIds": [],
      "relatedSpaceIds": [],
      "recommendedAgent": null,
      "expiresAt": null,
      "supersedeIds": []
    }
  ]
}

如果用户当前没有任何值得关注的事（信号、commitments 全空），输出 { "items": [] }。`;

// --------------------------------------------------------------------------
// User message builder
// --------------------------------------------------------------------------

export type BuildAttentionUserMessageOpts = {
  /** 当前还在 live 状态的 attention items；用于让 LLM dedupe / supersede。 */
  currentLive?: AttentionItem[];
};

export function buildAttentionUserMessage(
  packet: GlobalContextPacket,
  opts: BuildAttentionUserMessageOpts = {}
): string {
  const blocks: string[] = [];

  blocks.push(`<meta generatedAt="${packet.generatedAt}" bootstrapped="${packet.bootstrapped}"/>`);

  // subject
  if (packet.subject) {
    blocks.push(renderSubject(packet.subject));
  } else if (packet.bootstrapped) {
    blocks.push('<subject>(用户已 bootstrap 但 Work Map 还没填角色)</subject>');
  } else {
    blocks.push('<subject>(尚未 bootstrap，世界模型最小)</subject>');
  }

  // spaces
  blocks.push(renderSpaces(packet.spaces));

  // commitments / goals / uncertainties — 都是 ContextUnit[]，统一格式
  blocks.push(
    renderUnitsBlock(
      'commitments',
      packet.commitments,
      '用户的承诺、待办（按相关性 + due 近度排序）'
    )
  );
  blocks.push(renderUnitsBlock('goals', packet.goals, '用户的目标'));
  blocks.push(
    renderUnitsBlock('uncertainties', packet.uncertainties, '用户的不确定性/未决问题')
  );

  // recentEvents（近 24h）
  blocks.push(
    renderUnitsBlock('recentEvents', packet.recentEvents, '近 24h 的事件（按时间倒序）', {
      showTime: true,
    })
  );

  // topActive — 各种 kind 的活跃 unit
  blocks.push(
    renderUnitsBlock(
      'topActive',
      packet.topActive,
      '其他高分活跃 context（kind 多样：state / relationship / preference / decision 等）'
    )
  );

  // stakeholders
  blocks.push(renderStakeholders(packet.stakeholders));

  // preferences
  if (packet.preferences.length) {
    blocks.push(
      `<preferences>\n${packet.preferences.map((p) => `- ${p}`).join('\n')}\n</preferences>`
    );
  } else {
    blocks.push('<preferences/>');
  }

  // boundary rules
  if (packet.boundaryRules.length) {
    const lines = packet.boundaryRules
      .map((r) => `- [${r.id}] scope=${r.scope} ${r.description}`)
      .join('\n');
    blocks.push(`<boundaryRules>\n${lines}\n</boundaryRules>`);
  } else {
    blocks.push('<boundaryRules/>');
  }

  // recent attention interactions — 用户刚刚如何处理过 attention item
  if (packet.attentionInteractions.length) {
    const lines = packet.attentionInteractions
      .map((i) => {
        const signals = i.signalIds.length
          ? ` (signals: ${i.signalIds.slice(0, 4).join(', ')})`
          : '';
        return `- [${i.action}] ${i.priority} ${i.title}${signals}`;
      })
      .join('\n');
    blocks.push(
      `<recentAttentionInteractions count="${packet.attentionInteractions.length}">\n${lines}\n</recentAttentionInteractions>`
    );
  } else {
    blocks.push('<recentAttentionInteractions/>');
  }

  // agent proposals — 专项 agent 写的候选（commitment/meeting/recap/...）
  if (packet.agentProposals.length) {
    const lines = packet.agentProposals
      .map((p) => {
        const head = `- [${p.id}] (${p.agentType}, ${p.priority}) ${p.title}`;
        const sumLine = p.summary
          ? `  · ${p.summary.replace(/\s+/g, ' ').slice(0, 140)}`
          : '';
        const actLine = p.suggestedAction
          ? `  · 建议：${p.suggestedAction.slice(0, 80)}`
          : '';
        return [head, sumLine, actLine].filter(Boolean).join('\n');
      })
      .join('\n');
    blocks.push(`<agentProposals count="${packet.agentProposals.length}">\n${lines}\n</agentProposals>`);
  } else {
    blocks.push('<agentProposals/>');
  }

  // currentAttention
  const live = opts.currentLive ?? [];
  if (live.length === 0) {
    blocks.push('<currentAttention/>');
  } else {
    const lines = live
      .map(
        (it) =>
          `- [${it.id}] ${it.priority} ${it.title}` +
          (it.signalIds.length ? ` (signals: ${it.signalIds.slice(0, 3).join(', ')})` : '')
      )
      .join('\n');
    blocks.push(`<currentAttention>\n${lines}\n</currentAttention>`);
  }

  blocks.push(
    `<budget tokenEstimate="${packet.tokenEstimate}" inputHash="${packet.inputHash}"/>`
  );

  blocks.push('请基于以上信息输出 JSON（schema 见 system prompt）。只输出 JSON，不要任何额外文字。');

  return blocks.join('\n\n');
}

// --------------------------------------------------------------------------
// renderers
// --------------------------------------------------------------------------

function renderSubject(s: NonNullable<GlobalContextPacket['subject']>): string {
  const parts: string[] = ['<subject>'];
  if (s.roleTitle) parts.push(`角色：${s.roleTitle}`);
  if (s.teamName) parts.push(`团队：${s.teamName}`);
  if (s.responsibilities.length) {
    parts.push(`职责：\n${s.responsibilities.map((r) => `- ${r}`).join('\n')}`);
  }
  if (s.preferences.length) {
    parts.push(`偏好：\n${s.preferences.map((p) => `- ${p}`).join('\n')}`);
  }
  parts.push('</subject>');
  return parts.join('\n');
}

function renderSpaces(spaces: GlobalContextPacket['spaces']): string {
  if (spaces.length === 0) return '<spaces/>';
  const lines: string[] = ['<spaces>'];
  for (const s of spaces) {
    const docs = s.docs.length ? ` docs=${s.docs.length}` : '';
    lines.push(`- [${s.id}] ${s.name} (${s.type}, priority=${s.priority}${docs})`);
    if (s.commitmentTitles.length) {
      lines.push(`  · 关联 commitment：${s.commitmentTitles.join('；')}`);
    }
    if (s.goalTitles.length) {
      lines.push(`  · 关联 goal：${s.goalTitles.join('；')}`);
    }
  }
  lines.push('</spaces>');
  return lines.join('\n');
}

type RenderUnitsOpts = {
  showTime?: boolean;
};

function renderUnitsBlock(
  tag: string,
  units: ContextUnit[],
  caption: string,
  opts: RenderUnitsOpts = {}
): string {
  if (units.length === 0) return `<${tag} count="0"/>`;
  const lines: string[] = [`<${tag} count="${units.length}"><!-- ${caption} -->`];
  for (const u of units) {
    lines.push(renderUnitOneLine(u, opts));
  }
  lines.push(`</${tag}>`);
  return lines.join('\n');
}

function renderUnitOneLine(u: ContextUnit, opts: RenderUnitsOpts): string {
  const parts: string[] = [`- [${u.id}] (${u.kind})`];
  parts.push(u.title);
  if (opts.showTime && u.time?.occurredAt) {
    parts.push(`@${formatTime(u.time.occurredAt)}`);
  } else if (u.time?.dueAt) {
    parts.push(`due ${formatTime(u.time.dueAt)}`);
  } else if (u.time?.startsAt) {
    parts.push(`starts ${formatTime(u.time.startsAt)}`);
  }
  // 实体（最多 3 个，过滤掉 chat / app routing-only entity）
  const ents = (u.entities ?? [])
    .filter((e) => e.type !== 'chat' && e.type !== 'app' && e.role !== 'container')
    .slice(0, 3)
    .map((e) => `${e.type}:${e.name}`);
  if (ents.length) parts.push(`{${ents.join(', ')}}`);
  if (u.meaning && u.meaning.length <= 60) parts.push(`-- ${u.meaning}`);
  return parts.join(' ');
}

function renderStakeholders(stake: GlobalContextPacket['stakeholders']): string {
  if (stake.length === 0) return '<stakeholders/>';
  const lines: string[] = ['<stakeholders>'];
  for (const s of stake) {
    const note = s.note ? ` -- ${s.note}` : '';
    // MVP15 §4 (revision)：行尾标签携带 orgRole + business + functionLabel；缺哪个跳哪个。
    const tagParts: string[] = [];
    if (s.orgRole) tagParts.push(`orgRole=${s.orgRole}`);
    if (s.business) tagParts.push(`biz=${s.business}`);
    if (s.functionLabel) tagParts.push(`fn=${s.functionLabel}`);
    const tag = tagParts.length ? ` [${tagParts.join(' ')}]` : '';
    lines.push(`- ${s.name}${tag}${note}`);
  }
  lines.push('</stakeholders>');
  return lines.join('\n');
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

// --------------------------------------------------------------------------
// JSON 解析（容错风格抄自 triage/parseTriage.ts）
// --------------------------------------------------------------------------

const ALLOWED_PRIORITIES = new Set<string>(['P0', 'P1', 'P2', 'P3']);
const ALLOWED_AGENTS = new Set<string>([
  'prepareMeeting',
  'commitmentDigest',
  'recapActionItems',
  'docComment',
  'caring',
  'syncDraft',
]);

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  return null;
}

function extractJson(s: string): unknown {
  const whole = tryParse(s);
  if (whole !== null) return whole;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1]);
    if (inside !== null) return inside;
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    const sliced = tryParse(slice);
    if (sliced !== null) return sliced;
  }
  throw new Error(`attention 输出不是合法 JSON: ${s.slice(0, 200)}`);
}

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

function coerceItem(raw: unknown): AttentionLLMItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const why = typeof o.why === 'string' ? o.why.trim() : '';
  if (!title || !why) return null;
  const priorityRaw = typeof o.priority === 'string' ? o.priority.toUpperCase() : 'P2';
  const priority = (ALLOWED_PRIORITIES.has(priorityRaw) ? priorityRaw : 'P2') as AttentionPriority;
  const suggestedAction =
    typeof o.suggestedAction === 'string' && o.suggestedAction.trim()
      ? o.suggestedAction.trim()
      : undefined;
  const recommendedAgentRaw =
    typeof o.recommendedAgent === 'string' ? o.recommendedAgent.trim() : '';
  const recommendedAgent = ALLOWED_AGENTS.has(recommendedAgentRaw)
    ? recommendedAgentRaw
    : undefined;
  const expiresAtRaw = typeof o.expiresAt === 'string' ? o.expiresAt.trim() : '';
  const expiresAt = expiresAtRaw && !Number.isNaN(Date.parse(expiresAtRaw))
    ? expiresAtRaw
    : undefined;
  return {
    priority,
    title,
    why,
    suggestedAction,
    signalIds: coerceStringArray(o.signalIds),
    relatedEntityIds: coerceStringArray(o.relatedEntityIds),
    relatedSpaceIds: coerceStringArray(o.relatedSpaceIds),
    recommendedAgent,
    expiresAt,
    supersedeIds: coerceStringArray(o.supersedeIds),
  };
}

export function parseAttentionOutput(text: string): AttentionLLMItem[] {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object') {
    throw new Error('attention 输出不是对象');
  }
  const items = (obj as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new Error('attention 输出缺少 items 数组');
  }
  const out: AttentionLLMItem[] = [];
  for (const raw of items) {
    const it = coerceItem(raw);
    if (it) out.push(it);
    if (out.length >= 8) break; // hard cap
  }
  return out;
}
