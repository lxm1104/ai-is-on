/**
 * Opencode agent registry.
 *
 * 我们用 opencode CLI 代替 Claude Code 作为 LLM 后端。opencode `run` 不支持
 * `--append-system-prompt`，系统 prompt 只能通过 agent 文件提供。所以服务端
 * 启动时把每个调用点的 system prompt 物化成 .opencode/agent/<name>.md，
 * 调用时再 `--agent <name>` 选用。
 *
 * 单一注册表 = 单一事实源；改 prompt 改这里 / 改原 *Prompt.ts，重启服务即同步。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

import { buildSelfProfilePrompt } from '../context/selfProfile.js';
import { buildToneProfilePrompt } from '../context/toneProfile.js';
import { SYSTEM_PROMPT as CHAT_SYSTEM_PROMPT } from '../claude/prompts.js';
import { TRIAGE_SYSTEM_PROMPT } from '../triage/triagePrompt.js';
import { CARING_SYSTEM_PROMPT } from '../caring/caringPrompt.js';
import { ATTENTION_SYSTEM_PROMPT } from '../attention/attentionPrompt.js';
import { WORK_MAP_DRAFT_SYSTEM_PROMPT } from '../bootstrap/workMapDraftPrompt.js';

import { PREPARE_MEETING_SYSTEM_PROMPT } from '../agents/prepareMeetingAgent.js';
import { SYNC_DRAFT_SYSTEM_PROMPT } from '../agents/syncDraftAgent.js';
import { RECAP_SYSTEM_PROMPT } from '../agents/recapActionItemsAgent.js';
import { RANKER_SYSTEM_PROMPT } from '../spaces/llmChatAffinityRanker.js';
import { DEPT_TAXONOMY_SYSTEM_PROMPT } from '../util/departmentTaxonomyPrompt.js';
import { PROJECT_TAXONOMY_SYSTEM_PROMPT } from '../util/projectTaxonomyPrompt.js';
import { PROJECT_PHASE_SYSTEM_PROMPT } from '../util/projectPhasePrompt.js';
import { DECISION_AUTHORITY_SYSTEM_PROMPT } from '../util/decisionAuthorityPrompt.js';
import { COLLAB_TYPE_SYSTEM_PROMPT } from '../util/collabTypePrompt.js';
import { MATTER_REDUCE_SYSTEM_PROMPT } from '../matter/matterReducerPrompt.js';
import { CHAT_CONCLUSION_SYSTEM_PROMPT } from '../matter/chatConclusionPrompt.js';
import { MATTER_VERIFY_SYSTEM_PROMPT } from '../matter/matterVerifyPrompt.js';
import { INVESTIGATE_SYSTEM_PROMPT, renderToolsDoc } from '../investigation/investigationPrompt.js';
import { PLAYBOOK_DISTILL_SYSTEM_PROMPT } from '../playbook/playbookDistillPrompt.js';
import { PROJECT_ROUTER_SYSTEM } from '../investigation/projectRouterPrompt.js';
import { PROBLEM_CLASS_DISTILL_SYSTEM } from '../problemClass/problemClassDistillPrompt.js';
import { PROBLEM_CLASS_ANALYZE_SYSTEM } from '../problemClass/problemClassAnalyzePrompt.js';
import { listReadTools } from '../investigation/readTools.js';

export type OpencodeAgentName =
  | 'aiisn-chat'
  | 'aiisn-triage'
  | 'aiisn-caring'
  | 'aiisn-attention'
  | 'aiisn-work-map'
  | 'aiisn-prepare-meeting'
  | 'aiisn-sync-draft'
  | 'aiisn-recap'
  | 'aiisn-ranker'
  | 'aiisn-dept-taxonomy'
  | 'aiisn-project-taxonomy'
  | 'aiisn-project-phase'
  | 'aiisn-decision-authority'
  | 'aiisn-collab-type'
  | 'aiisn-matter-reducer'
  | 'aiisn-chat-conclusion'
  | 'aiisn-matter-verify'
  | 'aiisn-investigate'
  | 'aiisn-playbook-distill'
  | 'aiisn-project-router'
  | 'aiisn-problem-class-distill'
  | 'aiisn-problem-class-analyze';

type Permission = 'allow' | 'ask' | 'deny';
type AgentDef = {
  name: OpencodeAgentName;
  description: string;
  /** Per-tool permission map. Tools omitted default to allow. */
  permission: Partial<Record<'bash' | 'edit' | 'write' | 'webfetch' | 'read', Permission>>;
  prompt: string;
};

// 所有后台 agent 都允许 bash（lark-cli 调用走它），写操作一律 deny；
// 主聊天额外开 webfetch 用于补充公开互联网信息。
const READ_ONLY: AgentDef['permission'] = {
  bash: 'allow',
  edit: 'deny',
  write: 'deny',
};

const AGENTS: readonly AgentDef[] = [
  {
    name: 'aiisn-chat',
    description: 'AI is ON 主聊天 runtime',
    permission: { ...READ_ONLY, webfetch: 'allow' },
    prompt: CHAT_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-triage',
    description: 'AI is ON triage 后台分诊',
    permission: READ_ONLY,
    prompt: TRIAGE_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-caring',
    description: 'AI is ON 陪伴层 agent',
    permission: READ_ONLY,
    prompt: CARING_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-attention',
    description: 'AI is ON attention engine',
    permission: READ_ONLY,
    prompt: ATTENTION_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-work-map',
    description: 'AI is ON work map draft',
    permission: READ_ONLY,
    prompt: WORK_MAP_DRAFT_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-prepare-meeting',
    description: 'AI is ON prepare-meeting agent',
    permission: READ_ONLY,
    prompt: PREPARE_MEETING_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-sync-draft',
    description: 'AI is ON sync-draft agent',
    permission: READ_ONLY,
    prompt: SYNC_DRAFT_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-recap',
    description: 'AI is ON recap action-items agent',
    permission: READ_ONLY,
    prompt: RECAP_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-ranker',
    description: 'AI is ON MVP13 chat_affinity LLM ranker',
    permission: READ_ONLY,
    prompt: RANKER_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-dept-taxonomy',
    description: 'AI is ON MVP15 部门名 → business + functionPath 解析',
    permission: READ_ONLY,
    prompt: DEPT_TAXONOMY_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-project-taxonomy',
    description: 'AI is ON MVP15A project entity 名 → cluster 聚类去重',
    permission: READ_ONLY,
    prompt: PROJECT_TAXONOMY_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-project-phase',
    description: 'AI is ON MVP15B project 阶段 + 健康度判定',
    permission: READ_ONLY,
    prompt: PROJECT_PHASE_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-decision-authority',
    description: 'AI is ON MVP15B 推断某人对某项目的决策权重',
    permission: READ_ONLY,
    prompt: DECISION_AUTHORITY_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-collab-type',
    description: 'AI is ON MVP15B 推断两人协作关系类型',
    permission: READ_ONLY,
    prompt: COLLAB_TYPE_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-matter-reducer',
    description: 'AI is ON MVP27 Matter Reducer 事项状态判定',
    permission: READ_ONLY,
    prompt: MATTER_REDUCE_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-chat-conclusion',
    description: 'AI is ON MVP31 ask_agent 对话结论 → 事项状态提案抽取',
    permission: READ_ONLY,
    prompt: CHAT_CONCLUSION_SYSTEM_PROMPT,
  },
  {
    name: 'aiisn-matter-verify',
    description: 'AI is ON MVP32 mark_done 办结核实判定',
    permission: READ_ONLY,
    prompt: MATTER_VERIFY_SYSTEM_PROMPT,
  },
  {
    // MVP36 排查推理器：纯文本进 JSON 出，不碰任何工具（连 shell 都没有）——
    // 它只输出"想读什么"的结构化请求，由后端用白名单只读工具执行。硬边界比 prompt 软约束更强。
    name: 'aiisn-investigate',
    description: 'AI is ON MVP36 自主排查推理器（后端中介式只读取数）',
    // 全工具 deny（含 read）——模型不得用任何 opencode 原生工具（实测它偶尔想 tool-call
    // 本地 read/grep，既偏离 JSON 协议、又有读本地文件系统的风险、还会拖慢 runOneShot）。
    // 它唯一的输出方式是返回纯 JSON 文本，由后端用白名单只读工具执行。
    permission: { bash: 'deny', edit: 'deny', write: 'deny', webfetch: 'deny', read: 'deny' },
    prompt: INVESTIGATE_SYSTEM_PROMPT.replace(
      '{{TOOLS}}',
      renderToolsDoc(listReadTools())
    ),
  },
  {
    name: 'aiisn-playbook-distill',
    description: 'AI is ON MVP37 流程蒸馏器（同类轨迹 → 标准 playbook 草稿）',
    permission: READ_ONLY,
    prompt: PLAYBOOK_DISTILL_SYSTEM_PROMPT,
  },
  {
    // MVP50 项目归类器：把"这件事属于哪个项目"判清，从而拼对项目档案。纯文本进 JSON 出，全工具 deny。
    name: 'aiisn-project-router',
    description: 'AI is ON MVP50 项目归类器（事项 → 候选项目 id，确定性兜底用）',
    permission: { bash: 'deny', edit: 'deny', write: 'deny', webfetch: 'deny', read: 'deny' },
    prompt: PROJECT_ROUTER_SYSTEM,
  },
  {
    // MVP51 问题归类器：把已诊断事项按根因汇总成"问题类"台账。纯文本进 JSON 出，全工具 deny。
    name: 'aiisn-problem-class-distill',
    description: 'AI is ON MVP51 问题归类器（诊断事项 → 按根因归到问题类）',
    permission: { bash: 'deny', edit: 'deny', write: 'deny', webfetch: 'deny', read: 'deny' },
    prompt: PROBLEM_CLASS_DISTILL_SYSTEM,
  },
  {
    // MVP56 系统性分析师：综合一个问题类的多条 case → 系统性根因/解法（结论交用户审阅）。纯文本进 JSON 出。
    name: 'aiisn-problem-class-analyze',
    description: 'AI is ON MVP56 系统性问题分析师（问题类 → 系统性根因+解法，待审阅）',
    permission: { bash: 'deny', edit: 'deny', write: 'deny', webfetch: 'deny', read: 'deny' },
    prompt: PROBLEM_CLASS_ANALYZE_SYSTEM,
  },
];

function renderAgentFile(def: AgentDef): string {
  // opencode agent 文件：YAML frontmatter + body 作为 system prompt。
  // model 在 frontmatter 给出默认值；runOneShot 调用时再用 -m 覆盖（含 fallback）。
  const permLines: string[] = ['permission:'];
  for (const [k, v] of Object.entries(def.permission)) {
    permLines.push(`  ${k}: ${v}`);
  }
  return [
    '---',
    `description: ${JSON.stringify(def.description)}`,
    'mode: primary',
    `model: ${config.opencodeModel}`,
    ...permLines,
    '---',
    '',
    def.prompt,
    '',
  ].join('\n');
}

// 「模仿」模块：会替我产出对外文字的 agent 注入"我的说话风格"画像。
// MVP 先覆盖主聊天和同步草稿这两个最直接的用户可感知点。
const TONE_CONSUMERS: ReadonlySet<OpencodeAgentName> = new Set<OpencodeAgentName>([
  'aiisn-chat',
  'aiisn-sync-draft',
]);

/** Boot 时调用：把所有 agent 同步到磁盘，覆盖式写入以保持 prompt 与代码一致。 */
export function syncOpencodeAgents(): void {
  fs.mkdirSync(config.opencodeAgentDir, { recursive: true });

  // 主聊天额外把"我"（当前用户本人）的身份画像拼进 system prompt，
  // 让模型读飞书日历/消息/邮件时能判断哪个是我。取不到则为 ''（不拼）。
  let selfProfile = '';
  try {
    selfProfile = buildSelfProfilePrompt();
  } catch (err) {
    console.warn(
      '[opencode] buildSelfProfilePrompt failed, chat agent will lack self identity:',
      err instanceof Error ? err.message : String(err)
    );
  }

  // 「模仿」：我的说话风格画像（静态种子 + 用户编辑覆盖）。取不到则为 ''。
  let toneProfile = '';
  try {
    toneProfile = buildToneProfilePrompt();
  } catch (err) {
    console.warn(
      '[opencode] buildToneProfilePrompt failed, agents will lack tone imitation:',
      err instanceof Error ? err.message : String(err)
    );
  }

  for (const def of AGENTS) {
    let prompt = def.prompt;
    if (def.name === 'aiisn-chat' && selfProfile) {
      prompt = `${prompt}\n\n${selfProfile}`;
    }
    if (toneProfile && TONE_CONSUMERS.has(def.name)) {
      prompt = `${prompt}\n\n${toneProfile}`;
    }
    const file = path.join(config.opencodeAgentDir, `${def.name}.md`);
    fs.writeFileSync(file, renderAgentFile({ ...def, prompt }), 'utf8');
  }
}
