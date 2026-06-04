// MVP14 Attention Engine — system prompt + user message + JSON 解析。
// JSON 容错风格抄自 triage/parseTriage.ts（jsonrepair + 块剥离）。
// LLM 角色：用户的注意力管家。输入 = 世界模型 + 近期信号 + 当前已在 live 的 attention，
// 输出 = ≤8 条 ranked AttentionItem（严格 JSON）。

import { jsonrepair } from 'jsonrepair';
import type { GlobalContextPacket } from '../context/agentContextAssembler.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import type { ContextLayerHint, ContextSource } from '../context/layerClassifier.js';
import type {
  AttentionItem,
  AttentionLLMItem,
  AttentionPriority,
  ProcessingOption,
  ProcessingExecutor,
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
13. （MVP15B）\`<myTopCollaborators>\` 是按 weight 排序的协作圈（top 12）。
    跟 \`<stakeholders>\` 不同：stakeholders 是 work_map 手动登记的相关人，
    myTopCollaborators 是 cooccurrence + work_map 兜底的 weight 排序。两者都用。
    a) 信号涉及 myTopCollaborators 里 weight ≥ 1.5 的人 → 默认至少 P2；
       weight ≥ 2.5 + 临期/阻塞 → P0/P1。
    b) \`type=reviewer_author\` 且证据显示对方在 review 我的产出（PR / 文档评审 / 决策） → 抬一档（review unblock 关键）。
    c) \`type=cross_team\` 表明跨团队对接 → priority 维持原档，但 \`why\` 里可以
       明确指出"跨团队"作为合理性解释。
    d) \`hint=co_owner\` 的人发起的 commitment 或决策 → 抬一档（他们对项目有共同决策权）。
    e) \`<myTopCollaborators>\` 里没有的人，按内容判 priority，不要因为"不在协作圈"就降级——
       新合作者也可能发紧急事。
    f) 当 trigger 信号涉及的人在 myTopCollaborators 里有 \`共项目=[...]\` 时，可以在
       \`why\` 里引用项目名解释 priority。
14. （MVP20）\`<commitments>\` 行尾可能带 \`[role=executor|requester|reviewer|observer]\` 标签，
    表示 self 在这一条具体 commitment 上的角色（unit 级，跟 stakeholder 的项目级角色正交）：
    a) \`role=executor\` —— 我自己要做的事。**所有 active executor commitment 都是 P0**。
       why/title 用"该交了 / 建议今天推进"类文案。只要它来自 \`src=triage\` 或 \`src=manual\`，
       且 status 仍 active，就应被当作需要监控的个人承诺：
         - priority 必须设为 P0，不因 dueAt 缺失、来源普通、协作者权重低而降级；
         - dueAt ≤24h 或已逾期 → P0，并建议立刻推进/同步；
         - dueAt 在 7 天内 → P0，并建议今天安排推进；
         - 没有 dueAt → P0，suggestedAction 要建议"补一个截止时间 / 主动同步进展"；
         - 若 recentEvents 中出现用户已完成/已发送/已同步的证据，可不出 item 或用 supersede 清理旧 item。
       对 executor commitment 的 suggestedAction 要给具体下一步建议，而不只是"关注一下"。
    b) \`role=requester\` —— **别人答应我做的事**，我是需求方，不是执行方。
       priority **上限 P2**，DDL 临期不作为升级理由。why/title 要明确说"你提的需求 X 还没动静"，
       不要写"你要做 X"。仅当以下任一条件满足才出 item，否则跳过：
         - \`<recentEvents>\` 里出现跟本 commitment entities（人/项目/文档）关联的近期事件；
         - commitment 自带 \`actionability=ask\` 或 \`act\`（intensity 信号）；
         - 距 commitment 创建时间已超过 (DDL - createdAt) × 0.5 仍无更新。
    c) \`role=reviewer\` —— 等我审/确认。priority **上限 P1**（不到 P0，避免审核
       拖到执行方等不及）。why/title 聚焦"等你审 <X>"。
    d) \`role=observer\` —— 我只是被 cc / mentioned，跟我没直接责任。priority **上限 P3**，
       归并进 daily digest，不单独提醒。**例外**：commitment.actionability='ask'
       → 升 P2（需要回应的强度信号；caveat：actionability 是强度阶梯不区分谁动，
       会有 FP，靠 attentionFeedback 收紧）。
    e) 标签缺失（self 不在 entities 或 role 未识别）→ 现状规则不变，按 P0-P3 原规则判，
       不要因为缺标签反向 downgrade。
    f) 注意：本规则只对 \`<commitments>\` 块生效。goal / uncertainty 不挂 role 标签（MVP20 范围）。
15. （MVP21）\`<commitments>\` / \`<goals>\` / \`<uncertainties>\` 行尾可能带 \`[src=...]\` 标签：
    a) \`src=work_map_seed\` —— 用户在 Bootstrap / Work Map 上主动登记的种子信息。
       视为"用户曾经认为重要的关注点"，**不**视为"当前一定还成立的事实"。
       若同 entities / 同标题在 \`<recentEvents>\` 或其它 \`src=triage\` 信号里有近期更新，
       priority 以 triage 那条为准；若只有 \`src=work_map_seed\`、没有近期事件支撑，
       priority 上限 P2，title/why 措辞用"你之前登记的 X 是否还重要"类提问句，
       不要写"X 该交了 / 今天必须 X"。
    b) \`src=triage\` —— 系统从近期事件中抽出的语义 unit。priority 判断不变。
    c) \`src=collector\` —— 原始事件直写，未经富化；通常只出现在 \`<recentEvents>\`，
       不应单独产出 attention item（按现有规则）。
    d) \`src=manual\` / \`src=card_action\` / \`src=agent_run\` / \`src=system_feedback\` ——
       用户或 agent 显式写入，按内容本身判断。
    e) 缺 \`[src=...]\` 标签 = 装配未注入或未知来源，按内容判断，不作来源加权。
【处理角度 processingOptions】（仅 priority='P0' 或 'P1' 的 item 才生成；P2/P3 一律省略此字段）
为高优 item 给出 2–3 个**彼此不重叠**的「处理角度」，描述这条可以怎么交给 AI 处理。每个角度：
  - \`label\`：≤6 字动词短语（如「起草回复」「梳理要点」「拟成待办」）；
  - \`id\`：小写蛇形稳定标识（如 'draft_reply' / 'summarize' / 'to_task'）；
  - \`directive\`：一句话，告诉**执行时的 AI** 具体做什么。约束：
      (1) **必须是自包含的自然语言，严禁出现 \`S#\` 引用编号或任何 id**（执行时拿不到 packet）；
      (2) 默认只产草稿 / 做分析 / 整理，**不发送、不写库**——除非该角度用了 executor='create_task'（见下）。
  - \`executor\`：可选，取值 'claude_topic'（默认，把 directive 交给右侧 AI 出草稿/分析）
      或 'create_task'（该角度点击后**直接在飞书创建一条任务**，适合「拟成待办 / 加入任务」这类角度；
      仍会弹确认框，directive 用作任务的处理意图说明）。最多 1 个角度用 'create_task'。
  角度之间差异要清晰；凑不出第二个有区分度的角度，给 1 个也行，不要硬造。
  用 \`recommendedAgent\` 当线索但不被它限制；可结合其他承诺 / 用户偏好给跨卡片角度。

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
      "supersedeIds": [],
      "processingOptions": [
        { "id": "draft_reply", "label": "起草回复", "directive": "基于我当前进度，起草一条可直接发出的回复，仅草稿。" },
        { "id": "summarize", "label": "梳理要点", "directive": "把这条对话/事件浓缩成 3 条要点供我快速决策。" },
        { "id": "to_task", "label": "拟成待办", "directive": "本周交付 API 给李四：明确截止与验收点。", "executor": "create_task" }
      ]
    }
  ]
}
（P2/P3 的 item 不要带 processingOptions 字段。）

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

  // MVP15B §6.3: myTopCollaborators (协作圈 top 12 by weight)
  blocks.push(renderMyTopCollaborators(packet.myTopCollaborators));

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

/** MVP21 S1 §4.2 — 渲染时同时支持挂了 selfRoleOnUnit / _layerHint 的派生字段。 */
type RenderableUnit = ContextUnit & {
  selfRoleOnUnit?: 'executor' | 'requester' | 'reviewer' | 'observer' | null;
  _layerHint?: ContextLayerHint;
};

function renderUnitsBlock(
  tag: string,
  units: RenderableUnit[],
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

// MVP21 S1 §4.2: 行尾除 [role=...] 外，再追加 [src=...] 标签——`_layerHint.source`
// 派生字段在 agentContextAssembler 装配 commitments/goals/uncertainties 时挂的。
// inducer / unknown / 缺失 hint 时不输出标签。
const SRC_TAG_WHITELIST: ReadonlySet<ContextSource> = new Set<ContextSource>([
  'work_map_seed',
  'triage',
  'collector',
  'manual',
  'card_action',
  'agent_run',
  'system_feedback',
]);

// MVP20 §M4: 行尾可能追加 [role=requester] 等 self-role 标签——派生字段在
// agentContextAssembler 装配 commitments 时挂的（CommitmentInPacket）。
function renderUnitOneLine(
  u: RenderableUnit,
  opts: RenderUnitsOpts
): string {
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
  // MVP20 §M4: self 在这条 unit 上的角色（仅 commitment 派生，goal/uncertainty 不挂）
  if (u.selfRoleOnUnit) {
    parts.push(`[role=${u.selfRoleOnUnit}]`);
  }
  // MVP21 S1 §4.2: 来源标签（只对白名单 source 输出，让 LLM 区分用户登记 / triage / collector 等）
  if (u._layerHint && SRC_TAG_WHITELIST.has(u._layerHint.source)) {
    parts.push(`[src=${u._layerHint.source}]`);
  }
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

/**
 * MVP15B §6.3 — myTopCollaborators：协作圈 top 12 by weight，
 * 跟 stakeholders 区别：stakeholders 是 work_map 手动登记，myTopCollaborators
 * 是 cooccurrence + work_map 兜底，weight 排序、含 collabType / decisionRoleHint。
 */
function renderMyTopCollaborators(
  items: GlobalContextPacket['myTopCollaborators']
): string {
  if (!items || items.length === 0) return '<myTopCollaborators/>';
  const lines: string[] = [
    `<myTopCollaborators count="${items.length}" sortedByWeight>`,
  ];
  for (const c of items) {
    const tagParts: string[] = [`w=${c.weight.toFixed(2)}`];
    if (c.orgRole) tagParts.push(`orgRole=${c.orgRole}`);
    if (c.business) tagParts.push(`biz=${c.business}`);
    if (c.functionLabel) tagParts.push(`fn=${c.functionLabel}`);
    if (c.collabType) tagParts.push(`type=${c.collabType}`);
    if (c.decisionRoleHint) tagParts.push(`hint=${c.decisionRoleHint}`);
    const tag = tagParts.length ? ` [${tagParts.join(' ')}]` : '';
    const sharedSummary =
      c.sharedProjectCanonicalNames.length > 0
        ? ` -- 共项目=[${c.sharedProjectCanonicalNames.slice(0, 3).join(', ')}]`
        : '';
    lines.push(`- ${c.name}${tag}${sharedSummary}`);
  }
  lines.push('</myTopCollaborators>');
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

// MVP23：处理角度防御解析。坏/空 → undefined（落库 null → 卡片单按钮）。
// 任何异常只丢这个字段，绝不让 item 解析失败。
const REF_TOKEN_IN_TEXT = /\bS\d+\b/; // directive 误含 S# 引用编号 → 丢弃（resolveAttentionRefs 不处理该字段）
function coerceProcessingOptions(raw: unknown): ProcessingOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProcessingOption[] = [];
  const seenIds = new Set<string>();
  let createTaskUsed = false; // 最多 1 个角度用 create_task
  for (const v of raw) {
    if (out.length >= 3) break; // 最多 3 个（前端：前 2 直出，第 3 收进「⋯更多」）
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const idRaw = typeof o.id === 'string' ? o.id.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') : '';
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, 8) : '';
    const directive = typeof o.directive === 'string' ? o.directive.trim().slice(0, 200) : '';
    if (!idRaw || !label || !directive) continue;
    if (REF_TOKEN_IN_TEXT.test(directive)) continue; // 防 S# 泄漏
    if (seenIds.has(idRaw)) continue;
    let executor: ProcessingExecutor | undefined;
    if (o.executor === 'create_task' && !createTaskUsed) {
      executor = 'create_task';
      createTaskUsed = true;
    }
    seenIds.add(idRaw);
    out.push(executor ? { id: idRaw, label, directive, executor } : { id: idRaw, label, directive });
  }
  return out.length ? out : undefined;
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
    // MVP23：仅当 LLM 给了有效角度才带上；P2/P3 或缺失 → undefined → 单按钮
    processingOptions: coerceProcessingOptions(o.processingOptions),
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
