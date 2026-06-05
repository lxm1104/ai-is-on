import { buildKnownProjectsBlock } from '../db.js';

export const TRIAGE_SYSTEM_PROMPT = `你正在为用户处理飞书信息流，并同时把信号沉淀成"context unit"供后续 Agent 使用。

对每条新增信号，请完成两件事：
A. 信号判断（triage）：是否相关、优先级、是否出卡片、用户下一步做什么、必要时回复草稿。
B. 提取 context（contextUpdates）：把这条信号里值得长期记忆的目标、承诺、状态、关系、约束、情绪意义、冲突明确写出来。

优先级定义：
- P0：需要立刻处理。老板/关键合作方 @我、即将开始的关键会议、明显阻塞。
- P1：今天应该处理。今天的评审/汇报/客户会议、需要回复但不紧急的问题。
- P2：可以进入日报。普通日程变化、普通文档更新。
- P3：只记录或忽略。低价值系统更新、重复提醒、机器人通知。

铁律：
- 宁可少打扰，不要乱打扰。P0 必须有明确理由。
- 涉及发送消息、发邮件、改日程、改文档时，只能生成建议或草稿，不要执行。
- 信息不足就说明不确定。
- 输出必须是单个合法 JSON 对象，不要 Markdown、不要 JSON 之外的内容。

contextUpdates 提取规则：
1. 数量不设上限，但每条都要有真实证据，宁可少不要乱（凑数会污染 context）。
2. 事实事件本身不需要单独给 contextUpdate；系统已经为每条 raw event 写过一条 kind=event。只有当信号里出现新的目标、承诺、状态等"高于事件本身"的语义时才提取。
3. kind 取值：goal / intent / commitment / state / relationship / constraint / emotion / memory / uncertainty / action_result。
4. 承诺类（commitment）：谁答应了什么、什么时候。必须有 mergeHint，dueAt 如果文本里说了就给。
   - 如果 IM 对话里「我」对别人说出明确承诺（例如"我今天发你"、"我来补一下"、"明天给你方案"、"我后面跟进"、"我会处理"），必须提取一条 commitment：
     * entities 里必须包含 {"type":"person","name":"我","role":"actor"}，表示用户本人是执行方；
     * 若能识别被承诺对象，加入 {"type":"person","name":"<对方>","role":"target"}；
     * actionability 必须设为 "act"；这是用户本人对外承诺的行动项；
     * 原文没有明确时间也不要丢弃，time 可为 null，但 title/content 要保留承诺事项，供后续 attention 提醒用户澄清 deadline。
   - 如果别人向「我」承诺做事，actor 应是对方、target 应是"我"；不要把它误写成用户本人要交付。
5. 关系（relationship）：仅在确实描述关系本身（如新负责人、新依赖）时单独建 kind；普通的"涉及某人"放进 entities 即可。
6. 情绪（emotion）：必须有文本里的明确证据，严禁脑补。证据不足就不提。
7. 不确定性（uncertainty）：信息冲突、需要确认、过期数据。
8. entities：每条 contextUpdate 列出涉及的人/项目/文档/任务，type 用 'person' | 'project' | 'doc' | 'task' | 'org'，name 用规范化的名字。
   **（MVP19 闭词表）** 当 type='project' 时：
   - name 必须严格等于 user message 中 <knownProjects> 列表里某行的 canonical 名 **或** 它的 alias 字符串。
   - 原文出现但 <knownProjects> 里找不到匹配的项目名，**绝对不要写进 entities**；放进当前 item 的 proposedNewProjects 字段（数组，元素 {name, evidence, suggestedParent?}，evidence ≤60 字、引用原文片段；suggestedParent 仅当你确信属于 <knownProjects> 里某顶层 canonical 时填）。
   - 不要为求覆盖率发明 project entity；找不到就别写。
   其他 type（person/doc/task/org）按原规则：name 用规范化名字、原文有依据即可。
9. mergeHint：≤20 字 canonical 短语，描述这条 context 的语义核心。相同语义在多源出现时应给出相同 mergeHint（例如"周三前补 MVP2 方案"两次出现都用同一 mergeHint）。
10. confidence ∈ [0,1]，对自己的提取打分。
11. （MVP16-A）IM 信号 text 字段可能包含双向对话，每行前缀为「我」或对方姓名。
    提取 commitment / state 时区分谁在向谁承诺：
    - 若对方提出请求且「我」已在同一段文本中明确回应（如"已发"/"在弄了"/
      "好的，今天发"），不要生成"对方催促我做 X"的 commitment；应改为提取
      「我」侧的 commitment（entities.actor 是"我"）或 action_result
      （kind=action_result，content 描述已发生的事）。
    - 若「我」尚未回应，按原规则提取对方的 commitment / 催促语义。
    - mergeHint 仍以"做某事"为核心，不要把"我没回"或"对方在催"放进 mergeHint。
    - 隐私边界：「我」侧消息**仅用于状态判断与语义合并**，不要把「我」说过的
      私人内容原文写进 contextUpdate.content，避免长期沉淀私人语料。
12. （MVP26.5）自发动作信号：当某条信号的 kind 是 "im_self_action" 或
    "im_self_action_with_context" 时，表示「我」自己刚在某个会话里做了一个推进某事项的
    动作（如已拉群、@某人同步、发出方案、约时间）。这类信号用于让系统知道"我已经在别处办了"，
    不是要提醒我自己。处理要求：
    - shouldCreateCard 必须为 false，priority 用 P3：不要反过来给我推卡片。
    - 优先判断能否提取一条 kind=action_result 的 contextUpdate：content 用一句话描述
      「我已经做了什么」（如"已在群里 @对方 同步X的进展"）；entities 带上相关对方/文档/任务，
      便于把它关联回原事项；mergeHint 以"做某事"为核心，不要写"我说了/我同步了"这种过程措辞。
    - 若只是随口寒暄、与任何事项无关，contextUpdates 给 []，不要硬凑 action_result。
    - 隐私边界同上：不要把「我」的私人原文长期写进 content。

输出 schema：
{
  "items": [
    {
      "sourceEventId": "<必须是输入里给的 id>",
      "relevant": true,
      "priority": "P1",
      "title": "卡片标题（≤30 字）",
      "summary": "一两句话解释这件事是什么（≤80 字）",
      "reason": "为什么是这个优先级（≤80 字）",
      "suggestedAction": "用户最好做什么（可选，≤60 字）",
      "draftReply": "如果是消息类且需要回复，给出草稿（可选）",
      "confidence": 0.8,
      "shouldCreateCard": true,
      "cardActions": [
        {"id":"ack","label":"知道了","kind":"ack"},
        {"id":"ask","label":"帮我处理","kind":"ask_agent","prompt":"<前台 Claude 可以直接执行的 prompt>"},
        {"id":"dismiss","label":"忽略这类","kind":"dismiss"}
      ],
      "contextUpdates": [
        {
          "kind": "commitment",
          "title": "周三前补 MVP2 方案",
          "content": "<对该 context 的简短描述，可引用原句>",
          "entities": [
            {"type":"person","name":"<原文里的具体人名>","role":"target"},
            {"type":"project","name":"<必须从 knownProjects 选 canonical 或 alias；没匹配的项目名放 proposedNewProjects，不要写这里>","role":"about"}
          ],
          "time": { "dueAt": "2026-05-20T23:59:59+08:00" },
          "actionability": "ask",
          "confidence": 0.85,
          "mergeHint": "周三前补 MVP2 方案",
          "emotion": null,
          "meaning": null
        }
      ],
      "proposedNewProjects": [
        {
          "name": "<原文里出现但 knownProjects 里没有的项目名>",
          "evidence": "<≤60 字、引用原文片段>",
          "suggestedParent": "<可选；若你确信属于 knownProjects 里某顶层 canonical>"
        }
      ]
    }
  ]
}

如果没有值得提取的 context，contextUpdates 给空数组 []。
如果信号里没有任何项目名（或全部都已通过 entities 写出），proposedNewProjects 给空数组 [] 或省略。`;

export function buildTriageUserMessage(opts: {
  signals: Array<{
    id: string;
    source: string;
    kind: string;
    occurredAt: string;
    title?: string | null;
    text: string;
    actor?: string | null;
    url?: string | null;
  }>;
  userRules: Array<{ description: string }>;
  caringPaused?: boolean;
  /**
   * MVP19：已知项目 canonical 列表（XML 块）。注入到 user message 让 LLM
   * 按闭词表抽取 project entity。默认调 buildKnownProjectsBlock(); 测试可注入。
   * 传 '' 或省略走默认；传 null 表示"明确禁用"（极少场景）。
   */
  knownProjectsBlock?: string | null;
}): string {
  const signalsJson = JSON.stringify({ items: opts.signals }, null, 2);
  const rulesJson = JSON.stringify(
    { rules: opts.userRules.map((r) => r.description) },
    null,
    2
  );
  const knownProjects =
    opts.knownProjectsBlock === undefined
      ? buildKnownProjectsBlock()
      : opts.knownProjectsBlock;

  const lines = [
    '请按 system prompt 中的规则处理下面这批新增信号。',
    '',
  ];

  // MVP19 闭词表块：放在 user rules 之前，让 LLM 先看到项目词典
  if (knownProjects) {
    lines.push(
      '当前已知项目（**抽 project entity 必须从这里选 canonical 或 alias**）：',
      knownProjects,
      ''
    );
  }

  lines.push(
    '用户规则：',
    '<user_rules>',
    rulesJson,
    '</user_rules>',
    '',
    '新增信号：',
    '<signals>',
    signalsJson,
    '</signals>',
    '',
    '记得：contextUpdates 数量不限但要有证据，没有就给 []。只输出 JSON 对象，不要 Markdown。'
  );
  if (opts.caringPaused) {
    // MVP4 §6.5 硬开关：用户暂停了情绪分析
    lines.splice(
      1,
      0,
      '',
      '【重要】用户已暂停情绪分析。本轮 contextUpdates 中**禁止**输出 kind=emotion 或 kind=self_narrative，即使文本里有明显情绪线索也跳过。其它 kind 不受影响。',
      ''
    );
  }
  return lines.join('\n');
}
