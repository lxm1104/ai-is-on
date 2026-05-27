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
  | 'aiisn-collab-type';

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

/** Boot 时调用：把所有 agent 同步到磁盘，覆盖式写入以保持 prompt 与代码一致。 */
export function syncOpencodeAgents(): void {
  fs.mkdirSync(config.opencodeAgentDir, { recursive: true });
  for (const def of AGENTS) {
    const file = path.join(config.opencodeAgentDir, `${def.name}.md`);
    fs.writeFileSync(file, renderAgentFile(def), 'utf8');
  }
}
