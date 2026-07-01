/**
 * MVP36 — 自主排查推理器的 prompt + 解析。
 *
 * 这是「后端中介式排查」的 LLM 侧：模型**不碰 shell、没有任何工具**，每轮只输出一个 JSON——
 * 要么请求执行若干**白名单只读工具**(action='investigate')，要么给出结论(action='conclude')。
 * 后端执行只读工具、把结果回喂，循环到模型 conclude 或到轮数上限。
 *
 * system prompt 经 opencode agent 文件物化(aiisn-investigate, 权限全 deny——纯文本进 JSON 出)。
 */
import { jsonrepair } from 'jsonrepair';

export const INVESTIGATE_SYSTEM_PROMPT = `你是「事项排查员」。系统给你一件正在跟进的事项(Matter)，以及它的"下一步"——其中有一部分需要去飞书各产品里**查证**才能判断进展(例如"确认评测集是否已发给鲁升纲""跟进某人排查进展")。

你**没有任何工具、不能执行任何动作、绝不发送任何消息或改任何东西**。你能做的只有一件事：每一轮**直接返回一个 JSON 对象作为你的回复文本**，告诉后端你想读取哪些信息；后端会用一组**只读**工具替你查，把结果回给你；你据此继续查或给出结论。

**严禁调用任何工具**（不要尝试 read / grep / bash / 文件读取 / 联网等任何 opencode 原生工具——你一个都没有，调用只会失败）。你**唯一**的表达方式就是把下面这个 JSON 当作回复正文输出。下面"可用的只读工具"是给你**写进 JSON 的 toolCalls 字段用的名字**，不是让你去调用——后端才负责执行。

每轮你只输出一个合法 JSON（不要 Markdown、不要多余文字），二选一：

A) 还需要查 → action="investigate"，给出 toolCalls（1-3 个，少而精；每个工具调用尽量一次问清，别一条一条试）：
{
  "action": "investigate",
  "reason": "<这一步想查清什么，≤40字>",
  "toolCalls": [
    { "tool": "<工具名>", "params": { ... }, "why": "<为什么查这个，≤30字>" }
  ]
}

B) 已能下结论 → action="conclude"：
{
  "action": "conclude",
  "conclusion": {
    "verdict": "resolved | progressed | blocked | unknown",
    "confidence": 0.0-1.0,
    "factSummary": "<查到的关键事实，一两句，给用户看>",
    "evidence": ["<支撑结论的具体证据：谁在何时说了什么 / 某文档某任务的状态，可带链接>"],
    "solvability": "can_close | can_produce_artifact | need_user | cant",
    "needFromUser": { "kind": "need_credential", "ask": "<一句话告诉用户你具体缺什么>" },
    "artifact": { "kind": "code_fix | task_spec | decision_brief", "title": "...", "body": "主体内容", "rootCause": "(code_fix)根因", "targetRef": "(code_fix)文件:行号", "verifyCmd": "(code_fix)验证命令", "assignee": "(task_spec)建议负责人,可选" },
    "recommendation": { "stance": "do|wait|escalate|drop|decide", "advice": "我建议你具体做什么(动作+对象)", "because": "一句理由,须引上面 evidence", "nextStep": "可选:一句话点明下一步是什么", "draft": "可选但强烈建议:直接起草好的成品全文(催办话术/回复/方案),让用户一键复制去用" }
  }
}

追查纪律（像侦探一样，不放过系统能拿到的任何线索——尽可能查全再下结论）：
- 🔍 **第一步永远先回源头**：<源头> 段给了这件事**最初出现在哪**（原对话 chatId / 原文档 token / 链接）。先去那儿看有没有新进展/回复/结论/状态变化——很多"进展"就躺在原群、原文档里。别一上来就凭摘要瞎搜关键词。
- 然后**系统性把每个源都查一遍，一个都别漏**（相关的一次并行问清，别一条条试）：
  ① **IM**：把 <matter> 里涉及的**每个人名 + 关键术语 + 别名/英文名**都搜一遍（search_im_messages，多组关键词）；相关的群/单聊读原文（read_chat_messages）。
  ② **待办**：list_my_tasks 看这件事对应的任务是否已办结。
  ③ **文档**：相关文档读正文看是否已更新/有结论（read_doc）。
  ④ **代码提交（很多结果就落在这里，务必查）**：只要这件事和某个项目/代码/功能/badcase 有关，就到**业务代码库**用 run_command 查提交——\`git -C <代码库路径> log --all --oneline --grep 关键词\`（找提交信息里提到它的 commit）、\`git -C <代码库路径> log -S 关键标识 --oneline\`（找改动了某段代码/字段的 commit）、必要时 \`git -C <代码库路径> show <commit>\` 看具体改动。很多"某功能做没做 / 某 bug 修没修 / 某方案落地没"的答案就在 commit 里。**代码库路径用 <已知代码库> 段 或 <项目档案> 段里给的绝对路径；千万别不带 -C 在当前目录 log——那是本工具自己的仓库、不是业务代码，查了也白查。**
  ⑤ **badcase/报错**：走 日志ID→traceID(bytedcli log)→trace(fornax-cli)→file:line/引入commit(rg·git)。
- ✅ **穷尽了才结论**：conclude 前先自问——"系统里还有哪个我够得到的源没查？源头回去看了吗？相关的代码提交查了吗？涉及的人名都搜过了吗？"。**只要还有没查的、够得到的线索，就继续 investigate**，别提前收工下 unknown。真查全了、确实没有，才 conclude。

判定纪律：
- verdict=resolved 只在**查到明确完成证据**时给（对方确认收到 / 任务已完成 / 文档已更新到位）；不确定就给 progressed 或 unknown，**宁可漏判完成也别误判完成**。
  · **按可逆性分档**（决定 AI 敢不敢自动办结）：对**你自己欠的、内部可逆**的事——你已完成的内部动作、已更新到位的文档、已建好的任务等——查到明确完成证据时给 resolved + solvability="can_close"，系统会在高置信时**自动办结**（留二档核实 + 一键重开兜底）。对**对外承诺 / 影响他人 / P0** 的事，即便像是完成了也**保守**给 progressed，让用户确认，别擅自替对方判定收尾。
- 查不到任何相关信息 → verdict="unknown"、confidence 低、factSummary 说明"未查到 X"。
- 证据要具体可追溯（引用真实消息/任务/文档），不要编。
- 控制成本：最多查几轮就要 conclude；同一信息别反复查。
- **代码/badcase 类别浅尝辄止**：在 IM 里看到"有人讨论过/已上报/在排查中"**不等于查清了**。这类事项"查清"的标准是**定位到根因**——trace 里的报错栈、具体 file:line、引入的 commit/release。
  · 已有或能从消息里捞到**日志ID/traceID** → 必须深挖：用 run_command 走 bytedcli（日志ID→traceID）→ fornax-cli（拉 trace 看报错栈）→ rg/git（在代码库定位 file:line 与引入 commit），把这些写进 evidence。别只搜了 IM 或 rg 个关键词就收工。
  · **找不到**这个 badcase 的日志ID/traceID（IM 里也没有） → **别退而求其次下 progressed**。正确结论是 verdict="blocked" + needFromUser{kind:"need_credential", ask:"要把这个 badcase 追到代码根因，我需要它的 traceID 或日志ID"}。把"该深挖、但缺凭据"诚实地交给用户求助，远比一个浅层"有进展"有用。
- **别只查、要往解决推一步**：conclude 时先自评 solvability（你能把这件事解到哪一步）：can_close（你已查到内部可逆且完成的证据，能直接判办结）｜can_produce_artifact（你能产出"最推进一步的可执行件"，填 artifact）｜need_user（缺具体物，填 needFromUser）｜cant（够不到）。
  · **can_produce_artifact** 按事项类型选 artifact.kind（只在你真有料时填，别硬凑）：
    - **code_fix**（代码 badcase 且你真在 trace/代码里定位到了 file:line）：title 一句话、rootCause 根因、targetRef **真实定位到的 文件:行号**（**严禁编造**，必须是你 rg/读代码看到的）、body 具体改法（改哪里·改成什么·为什么）、verifyCmd 验证命令。只是"知道大概在哪个模块"不算 → 那填 progressed 或 need_user。
    - **task_spec**（你查到某事**方案已确认采用/已拍板要做，但还没人建任务跟进**，如"TEA 方案已确认采用、要带 LogID 给邓贵羊"）：title=任务名、body=做什么·为什么·验收，assignee 建议负责人(可选)。让用户一键把它建成飞书任务。
    - **decision_brief**（**决策类**事项，信息已拉齐到能拍板）：title=决策点、body 结构化写【各方立场】【约束】【尚缺】【我的建议】。**不替用户拍板**，只把信息凝成一页让他决。
    · 共同要求：必须有 evidence 支撑（后端会校正，无证据不升卡）。能 code_fix 就别退而求其次。
- 🎯 **【最重要】给「直接建议」(recommendation)——这是用户三番五次要的"结果"，你只给事实=没给结果**：写完 factSummary 后**必做一步**：问自己"**基于这些事实，我会建议用户下一步做什么？**"，把答案写进 recommendation.advice。
  · **verdict=progressed 或 resolved 时，几乎一定要给 recommendation**——有进展/已完成就一定有"所以你接下来该…"。只有 blocked/unknown 且确实只能求助时才可不给（走 needFromUser）。
  · **建议必须是"动作"不是"事实复述"**："根因已明确""对方未交付""评审没召开""已定位X"全是**事实**，要紧跟"**所以我建议你〔催谁/问谁/改哪/推动什么/搁置/上抛〕**"。advice 含具体动作+对象，≤80 字。
  · 例：事实「评审没召开，4月对方说要支持，6月关联工单按"产品需求"关闭」→ 建议 advice:"找对方对齐这功能到底还推不推——4月说要、6月工单却按产品需求关了，方向有分歧" because:"4月确认支持但6月工单已关归因产品需求(见 evidence)" stance:"do" nextStep:"我已起草一句问对方的话术待你发"。
  · **because 必须引用上面 evidence 里的具体证据**。
  · 🎯 **stance=do 且建议是"催办/回复/问清/发消息"这类可起草的动作时，必须把 draft 字段也写出来**——**直接起草好可以发的成品全文**（自然口吻、点名对方、说清诉求，用户复制就能发），别只在 advice 里说"建议催一下"却不给话术。这是让用户"一键就能用"的关键。draft 里**绝不能写"我已发/已通知/已办"**——你不代发，发由用户点。
  · stance：do(去做)｜wait(先等/还在窗口内别催)｜escalate(上抛求助)｜drop(可不跟了/做减法)｜decide(该用户拍板)。
  · 实在**只能复述事实、给不出有动作的建议**才留空——但这应是少数；**别用"建议继续跟进"这种废话凑**（后端有防换壳硬门会丢掉、还拉低你的结果率）。

needFromUser（可选，**仅当 verdict 是 blocked/unknown 且你明确知道缺哪一件具体的事**才填；说不出具体物就别填，宁可不求助也别把"我也不知道为啥没查到"包装成求助）：
- "kind" 取一个：need_credential（缺 traceID/日志ID 才能继续追——很多在对方消息里，先自查，找不到才求助）｜need_info（缺一个可命名的关键事实：哪个版本/环境/对方是谁）｜need_decision（信息已齐需用户拍板，必须给 "options":["A","B"] 至少 2 项）｜need_outbound（需用户去发某条飞书消息，公司禁 AI 代发）｜owned_by_other（状态在别人名下、你查不到，须在 ask 里点名是谁）｜tool_gap（某系统你够不到只读入口）。
- "ask"：一句话、对用户说、点明缺的具体物，例如"要继续追这个 badcase，我需要那条 traceID/日志ID"。

可用的只读工具（只有这些，参数照给）：
{{TOOLS}}`;

export type ToolCallRequest = { tool: string; params: Record<string, unknown>; why?: string };

// MVP69：AI 卡住时结构化说明"缺哪一件具体的事"——用来升「需要你帮忙」求助卡。仅 blocked/unknown 读。
export type NeedKind =
  | 'need_credential' // 缺 traceID/日志ID 才能 run_command 追
  | 'need_info' // 缺一个可命名的关键事实（哪个版本/环境/对方是谁）
  | 'need_decision' // 信息已齐，需你拍板（options≥2）
  | 'need_outbound' // 需对外发飞书消息推进（公司禁 AI 代发）
  | 'owned_by_other' // 状态在他人名下，list_my_tasks 看不到（须 name 出是谁）
  | 'tool_gap'; // 某系统 AI 够不到只读入口
export const NEED_KINDS = new Set<NeedKind>([
  'need_credential', 'need_info', 'need_decision', 'need_outbound', 'owned_by_other', 'tool_gap',
]);
export type NeedFromUser = {
  kind: NeedKind;
  ask: string; // 给用户看的一句话："要继续追，我需要那条 traceID"
  options?: string[]; // 仅 need_decision：拍板选项（长度≥2 才合法）
};
/** 升求助卡前置：kind 在枚举 + ask 非空 + kind 专属结构校验（不靠 confidence 单维度——它度量 verdict 把握）。 */
export function isValidNeedFromUser(n: NeedFromUser | undefined | null): n is NeedFromUser {
  if (!n || typeof n !== 'object') return false;
  if (!NEED_KINDS.has(n.kind)) return false;
  if (typeof n.ask !== 'string' || !n.ask.trim()) return false;
  if (n.kind === 'need_decision' && !(Array.isArray(n.options) && n.options.length >= 2)) return false;
  return true;
}

// MVP74：从"查"到"解决"——AI 自评能解到哪一步 + 产出"最推进一步的可执行件"。
export type Solvability = 'can_close' | 'can_produce_artifact' | 'need_user' | 'cant';
// P1-6：交付件不止代码修复——也支持 task_spec（已确认采用X→该建的任务）/ decision_brief（决策类→信息包+建议）。
export type ArtifactKind = 'code_fix' | 'task_spec' | 'decision_brief';
export type InvestigationArtifact = {
  kind: ArtifactKind;
  title: string;
  body: string; // 通用主体：code_fix=改法草案 / task_spec=任务描述(做什么·为什么) / decision_brief=立场·约束·缺口·建议
  rootCause?: string; // code_fix：一句话根因
  targetRef?: string; // code_fix：file:line（必填，多个用分号隔）—— 后端校正硬门，不得编造
  verifyCmd?: string; // code_fix：验证命令（只读）
  assignee?: string; // task_spec：建议负责人（可选）
};
export const ARTIFACT_KINDS = new Set<ArtifactKind>(['code_fix', 'task_spec', 'decision_brief']);
// 后端校正硬门：code_fix 的 targetRef 必须含至少一处真正的 file:line 形态（如 src/foo.ts:42）。
// MVP74 审查 P2：挡住 LLM 自评虚高时编造的"大概在 formula 模块/没行号"这类非定位文本，与 prompt「严禁编造、必须是真定位到的 文件:行号」对齐。
const FILE_LINE_RE = /[^\s:;]+:\d+/;
/** 升「交付卡」前置硬门：kind 合法 + title/body 非空；code_fix 额外要求 targetRef 是真 file:line + rootCause 非空。 */
export function isValidArtifact(a: InvestigationArtifact | undefined | null): a is InvestigationArtifact {
  if (!a || typeof a !== 'object') return false;
  if (!ARTIFACT_KINDS.has(a.kind)) return false;
  if (typeof a.title !== 'string' || !a.title.trim()) return false;
  if (typeof a.body !== 'string' || !a.body.trim()) return false;
  if (a.kind === 'code_fix') {
    if (typeof a.targetRef !== 'string' || !FILE_LINE_RE.test(a.targetRef)) return false;
    if (typeof a.rootCause !== 'string' || !a.rootCause.trim()) return false;
  }
  return true;
}

// MVP75：从"过程/事实"到"结果"——每次 conclude 尽量给一条**直接建议/意见**（不止罕见代码 artifact）。
export type RecoStance = 'do' | 'wait' | 'escalate' | 'drop' | 'decide';
export const RECO_STANCES = new Set<RecoStance>(['do', 'wait', 'escalate', 'drop', 'decide']);
export type Recommendation = {
  stance: RecoStance; // 倾向：去做 / 先等 / 上抛求助 / 可不跟了 / 该你拍板
  advice: string; // 对用户的直接建议（含动作+对象），≤80 字
  because: string; // 一句理由，须引证据
  nextStep?: string; // 可选：一句话点明下一步是什么（如"发给丘晓骁的催办"）
  draft?: string; // 关键：AI 替用户**直接起草好的成品**（催办话术/回复/方案全文），让用户一键复制去用——绝不是"已发"
};
const RECO_MIN_NEW_TOKENS = 2; // 增量信息门阈值：advice 须含 fact/evidence 之外的新词
// 完成态/代执行动词 → 否决（AI 不代发不自动改，建议只能是"待你做"）。
const RECO_DONE_RE = /已发(送)?|已改|已修改|已办(结)?|已删除|已通知|已提交|已发送/;
// stance=do/escalate 的建议须含动作动词（词法只作"必要否决"，非充分）。
const RECO_ACTION_RE = /(发|催|问|约|提|改|建|删|关|开|查|推|确认|对齐|上抛|升级|搁置|放弃|拆|合并|回复|起草|指派|跟进|联系|拉群|找)/;
function recoTokens(s: string): string[] {
  return s
    .replace(/^(我建议你?|你可以|建议|倾向|我倾向|所以)/, '')
    .replace(/[\s，。、；：,.:;!？?“”"'（）()【】]/g, '')
    .split('')
    .filter(Boolean);
}
function newTokenCount(advice: string, factSummary: string, evidence: string[]): number {
  const known = new Set(recoTokens(factSummary + evidence.join('')));
  const adv = recoTokens(advice);
  const seen = new Set<string>();
  let n = 0;
  for (const t of adv) {
    if (!known.has(t) && !seen.has(t)) { n += 1; seen.add(t); }
  }
  return n;
}
/** because 是否实质引用了某条 evidence（有足够字符重合），而非凭空。 */
function citesEvidence(because: string, evidence: string[]): boolean {
  if (!evidence.length) return false; // 无证据则无法引证据 → 不算达标（诚实出口是 needhelp）
  const b = new Set(recoTokens(because));
  if (b.size === 0) return false;
  for (const e of evidence) {
    const ev = new Set(recoTokens(e));
    let overlap = 0;
    for (const t of b) if (ev.has(t)) overlap += 1;
    if (overlap >= 2) return true;
  }
  return false;
}
/**
 * 防换壳硬门（决定成败）：建议必须有**增量信息** + **引证据** + 非完成态谎报。
 * 代码门不承诺判出"有信息含量"，只挡掉 事实复述/泛泛跟进/完成态谎报；真换壳率靠人工抽检。
 */
export function gradeRecommendation(rec: Recommendation | undefined | null, factSummary: string, evidence: string[]): boolean {
  if (!rec || typeof rec !== 'object' || !RECO_STANCES.has(rec.stance)) return false;
  if (typeof rec.advice !== 'string' || !rec.advice.trim()) return false;
  if (typeof rec.because !== 'string' || !rec.because.trim()) return false;
  if (RECO_DONE_RE.test(rec.advice)) return false; // ① 否决完成态/代执行
  if (newTokenCount(rec.advice, factSummary || '', evidence || [])  < RECO_MIN_NEW_TOKENS) return false; // ② 增量信息门
  if (!citesEvidence(rec.because, evidence || [])) return false; // ③ because 引证据
  if ((rec.stance === 'do' || rec.stance === 'escalate') && !RECO_ACTION_RE.test(rec.advice)) return false; // ④ do/escalate 须有动作
  return true;
}

export type InvestigationConclusion = {
  verdict: 'resolved' | 'progressed' | 'blocked' | 'unknown';
  confidence: number;
  factSummary: string;
  evidence: string[];
  needFromUser?: NeedFromUser; // MVP69：仅 blocked/unknown 时可能有
  solvability?: Solvability; // MVP74：AI 自评能解到哪一步
  artifact?: InvestigationArtifact; // MVP74：最推进一步的可执行件（仅 can_produce_artifact 时）
  recommendation?: Recommendation; // MVP75：直接的建议/意见（结果层）
};
export type InvestigationStep =
  | { action: 'investigate'; reason?: string; toolCalls: ToolCallRequest[] }
  | { action: 'conclude'; conclusion: InvestigationConclusion };

export function renderToolsDoc(
  tools: Array<{ name: string; description: string; paramsHint: string }>
): string {
  return tools.map((t) => `- ${t.name}: ${t.description}\n    参数: ${t.paramsHint}`).join('\n');
}

export function buildInvestigateUserMessage(opts: {
  matterTitle: string;
  matterType: string;
  currentSummary: string;
  nextAction: string;
  entities: Array<{ type: string; name: string; role?: string }>;
  findings: string[]; // 已查到的（前几轮工具结果摘要）
  round: number;
  maxRounds: number;
  playbookHint?: string; // MVP37 召回：这类任务已学/用户教过的做法，优先照此排查
  projectProfile?: string; // MVP38 项目排查档案：代码库路径/trace 方法/术语等
  userBackfills?: string[]; // MVP71 KEYSTONE：用户经求助卡补给该 matter 的内容（traceID/对方回复/真实状态）
  originHint?: string; // 追查链路：这件事最初出现在哪（源头对话/文档/链接 + 最初内容）
  knownCodeRepos?: string[]; // 追查链路：已知业务代码库绝对路径（git log 去这些仓，别在本工具目录 log）
  problemClassHint?: string; // 追查链路：所属问题类的已知根因 + 已解决的兄弟事项（先看现成线索）
}): string {
  const lines = [
    '<matter>',
    `标题：${opts.matterTitle}`,
    `类型：${opts.matterType}`,
    `当前摘要：${opts.currentSummary || '（无）'}`,
    `需排查的下一步：${opts.nextAction}`,
    opts.entities.length
      ? `涉及：${opts.entities.map((e) => `${e.type}:${e.name}${e.role ? `(${e.role})` : ''}`).join(', ')}`
      : '',
    '</matter>',
  ];
  // 追查链路：这件事**最初出现在哪**。第一步永远先回源头看有没有新进展/回复/结论，再往外扩。
  if (opts.originHint && opts.round === 1) {
    lines.push('', '<源头（第一步先回这里查）>', opts.originHint, '</源头>');
  }
  // 追查链路：已知业务代码库路径——查代码提交时 git log **只在这些真实业务仓里查**，别在当前目录（那是本工具自己的仓库）。
  if (opts.knownCodeRepos && opts.knownCodeRepos.length && opts.round === 1) {
    lines.push('', '<已知代码库（git log 查提交去这些路径，别在当前目录 log）>', ...opts.knownCodeRepos.map((r) => `- ${r}`), '</已知代码库>');
  }
  // 追查链路：所属问题类的已知根因 + 已解决兄弟事项——系统早已归纳，先看这些现成线索（可能同一个 fix 已覆盖），别从零重推。
  if (opts.problemClassHint && opts.round === 1) {
    lines.push('', opts.problemClassHint);
  }
  // MVP71 KEYSTONE：用户此前就这件事**通过「需要你帮忙」求助卡补过信息**（贴的 traceID / 对方的回复 / 真实状态）。
  // 这是你上次卡住后用户专门补给你的——务必据此重新判断，别再得出和上次一样的"查不到"。置顶且强语气。
  if (opts.userBackfills && opts.userBackfills.length) {
    lines.push(
      '',
      '<用户补充（你上次卡住，用户专门补给你的关键信息——务必据此重新判断）>',
      ...opts.userBackfills.slice(0, 5).map((b, i) => `[补充${i + 1}] ${b.replace(/\s+/g, ' ').trim().slice(0, 500)}`),
      '据此处理：若用户已告知对方确认完成/已办结 → verdict=resolved；给了 traceID/日志ID → 用 run_command 接着追；',
      '给了关键事实 → 结合它重新查证。**不要无视用户补充再下"查不到"。**',
      '</用户补充>'
    );
  }
  // MVP64 ⑥：决策类事项——不替用户拍板，而是用只读工具拉齐"决策信息包"。
  if (opts.matterType === 'decision') {
    lines.push(
      '',
      '<决策信息包指引>',
      '这是一个待拍板的决策。请用只读工具(IM 搜索/相关文档)去拉齐三样：',
      '① 各方立场——谁倾向哪个方案、理由；② 约束——deadline/资源/技术/合规等硬限制；③ 缺口——还缺哪些信息才能拍板。',
      'conclude 时 verdict 用 progressed；factSummary 一句话概括这个"决策信息包"；',
      'evidence 分条列：以「立场/约束/缺口」前缀标注每条并附来源(谁在何时何处说的)。**不要替用户做决定**，只把决策所需信息摆齐。',
      '</决策信息包指引>'
    );
  }
  if (opts.projectProfile) {
    lines.push(
      '',
      '<项目背景与排查方法>',
      '（用户为该项目登记的额外信息与做事方法。除飞书只读工具外，你还能用 run_command 跑本地**只读**命令：',
      '按档案给出的代码库路径用 rg/grep/git 查代码、用 fornax-cli 按 traceID 拿 trace 详情，再据此定位。',
      '代码类 badcase 若已有 traceID/日志ID：尽量追到底——① fornax-cli 拿 trace 定位报错组件/栈；',
      '② rg 在代码库定位到具体 file:line；③ git log/blame 找引入它的 commit 或 release。把 file:line 与 commit 写进 evidence（证据优先，别停在泛泛"疑似某模块"）。',
      '只读：写/删/发布/凭证类命令会被拒绝；命令在你指定的 cwd 下执行、不能越出允许目录。',
      '若档案提到的来源连 run_command 也够不到，再在结论里告诉用户去哪查什么。）',
      opts.projectProfile,
      '</项目背景与排查方法>'
    );
  }
  if (opts.playbookHint) {
    lines.push('', '<已知做法>', opts.playbookHint, '</已知做法>');
  }
  lines.push(
    '',
    `这是第 ${opts.round}/${opts.maxRounds} 轮${opts.round >= opts.maxRounds ? '（最后一轮，请直接 conclude）' : ''}。`
  );
  if (opts.findings.length) {
    lines.push('', '<已查到>', ...opts.findings.map((f, i) => `[${i + 1}] ${f}`), '</已查到>');
  } else {
    lines.push('', '（还没查任何东西）');
  }
  // MVP76：破格式最常见的表现是模型把"我接下来想查X"写成散文而不发 JSON（实测 r3 narrate
  // "我先搜一下相关 commit" → 整轮报废、证据被弃）。把"只输出 JSON、想继续查就把它写进 toolCalls"
  // 这条铁律放在模型开口前的最后一句，最大化遵从。
  lines.push(
    '',
    '⚠️ 只输出**一个** JSON 对象，前后不许有任何文字/解释/思考散文。',
    '想继续查（哪怕只是"再搜个 commit"）就发 {"action":"investigate","toolCalls":[…]}，别用散文说你要查什么；查够了才发 {"action":"conclude", …}。'
  );
  return lines.join('\n');
}

// ---- 解析 ----

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  return null;
}

/** 括号配平：抠出文本里所有顶层 {...} 片段（应对模型在 JSON 前后夹了说理散文）。 */
function balancedObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

function extractJson(s: string): Record<string, unknown> {
  // 1. 整串**严格** JSON.parse（纯 JSON 回复的快路径）。不在这步用 jsonrepair——它对"散文夹 JSON"
  //    会把整段散文"修"成一个乱对象，反而短路掉下面的精准抠取（实测 bug）。
  try {
    const w = JSON.parse(s);
    if (w && typeof w === 'object') return w as Record<string, unknown>;
  } catch {}
  // 2. 代码围栏
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1]);
    if (inside && typeof inside === 'object') return inside as Record<string, unknown>;
  }
  // 3. 模型常在 JSON 前后夹说理散文（"我先并行查 IM 和代码…{json}…"）→ 配平抠出每个 {...}，
  //    优先取含 action/toolCalls/conclusion 的那个（对每个**孤立片段**用 jsonrepair 是安全的）。
  const objs = balancedObjects(s);
  let fallback: Record<string, unknown> | null = null;
  for (const o of objs) {
    const parsed = tryParse(o);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if ('action' in obj || 'toolCalls' in obj || 'conclusion' in obj) return obj;
      if (!fallback) fallback = obj;
    }
  }
  if (fallback) return fallback;
  // 4. 兜底：整串 jsonrepair / 首尾大括号
  const repaired = tryParse(s);
  if (repaired && typeof repaired === 'object') return repaired as Record<string, unknown>;
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = tryParse(s.slice(first, last + 1));
    if (sliced && typeof sliced === 'object') return sliced as Record<string, unknown>;
  }
  throw new Error(`investigate 输出非合法 JSON: ${s.slice(0, 160)}`);
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

const VERDICTS = new Set(['resolved', 'progressed', 'blocked', 'unknown']);

/** MVP69：防御式解析 needFromUser，非法即降级 undefined（绝不让脏数据穿透到升卡）。 */
function parseNeedFromUser(raw: unknown): NeedFromUser | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const kind = o.kind as NeedKind;
  if (!NEED_KINDS.has(kind)) return undefined;
  const ask = typeof o.ask === 'string' ? o.ask.trim() : '';
  if (!ask) return undefined;
  const options = Array.isArray(o.options)
    ? o.options.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 6)
    : undefined;
  const n: NeedFromUser = { kind, ask: ask.slice(0, 280), options };
  return isValidNeedFromUser(n) ? n : undefined;
}

const SOLVABILITIES = new Set<Solvability>(['can_close', 'can_produce_artifact', 'need_user', 'cant']);
function parseSolvability(raw: unknown): Solvability | undefined {
  return typeof raw === 'string' && SOLVABILITIES.has(raw as Solvability) ? (raw as Solvability) : undefined;
}
/** MVP74：防御式解析 artifact，非法即降级 undefined（绝不让脏数据穿透到升卡）。P1-6：多 kind。 */
function parseArtifact(raw: unknown): InvestigationArtifact | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const s = (k: string, n: number) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, n) : '');
  const kind = o.kind as ArtifactKind;
  if (!ARTIFACT_KINDS.has(kind)) return undefined;
  const a: InvestigationArtifact = {
    kind,
    title: s('title', 120),
    body: s('body', 2000), // 与卡正文展示/复制对齐（审查 P2），不留"解析留长、展示截短"的静默丢尾
    rootCause: s('rootCause', 400) || undefined,
    targetRef: s('targetRef', 300) || undefined,
    verifyCmd: s('verifyCmd', 300) || undefined,
    assignee: s('assignee', 60) || undefined,
  };
  return isValidArtifact(a) ? a : undefined;
}

/** MVP75：防御式解析 recommendation，非法/缺字段一律 undefined（向后兼容：无 rec 退回纯事实）。 */
function parseRecommendation(raw: unknown): Recommendation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const stance = o.stance as RecoStance;
  if (!RECO_STANCES.has(stance)) return undefined;
  const s = (k: string, n: number) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, n) : '');
  const advice = s('advice', 120);
  const because = s('because', 200);
  if (!advice || !because) return undefined;
  return { stance, advice, because, nextStep: s('nextStep', 120) || undefined, draft: s('draft', 1200) || undefined };
}

/** 解析一步；非法或缺字段时按保守降级（解析失败→当作 unknown 结论，由调用方决定）。 */
export function parseInvestigationStep(text: string): InvestigationStep {
  const obj = extractJson(text);
  const action = typeof obj.action === 'string' ? obj.action : undefined;

  if (action === 'conclude' || obj.conclusion) {
    const c = (obj.conclusion ?? {}) as Record<string, unknown>;
    const verdictRaw = typeof c.verdict === 'string' ? c.verdict : 'unknown';
    return {
      action: 'conclude',
      conclusion: {
        verdict: (VERDICTS.has(verdictRaw) ? verdictRaw : 'unknown') as InvestigationConclusion['verdict'],
        confidence: clamp01(c.confidence),
        factSummary: typeof c.factSummary === 'string' ? c.factSummary : '',
        evidence: Array.isArray(c.evidence) ? c.evidence.filter((x) => typeof x === 'string') : [],
        needFromUser: parseNeedFromUser(c.needFromUser), // MVP69：非法/缺失 → undefined，严格向后兼容
        solvability: parseSolvability(c.solvability), // MVP74
        artifact: parseArtifact(c.artifact), // MVP74：非法→undefined，绝不脏数据穿透
        recommendation: parseRecommendation(c.recommendation), // MVP75：直接建议（结果层）
      },
    };
  }

  // investigate
  const rawCalls = Array.isArray(obj.toolCalls) ? obj.toolCalls : [];
  const toolCalls: ToolCallRequest[] = rawCalls
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const tool = typeof o.tool === 'string' ? o.tool : '';
      const params = o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : {};
      const why = typeof o.why === 'string' ? o.why : undefined;
      return { tool, params, why };
    })
    .filter((c) => c.tool);
  if (toolCalls.length === 0) {
    // 既不是合法 conclude 也没有有效 toolCalls → 降级为 unknown 结论，避免空转
    return {
      action: 'conclude',
      conclusion: { verdict: 'unknown', confidence: 0, factSummary: '排查器未给出有效动作', evidence: [] },
    };
  }
  return {
    action: 'investigate',
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    toolCalls: toolCalls.slice(0, 3), // 每轮最多 3 个工具，控成本
  };
}
