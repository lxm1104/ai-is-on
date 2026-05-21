/**
 * MVP7 §4.2 Work Map 草稿数据结构。
 * 这是用户在 WorkMapPanel 中编辑 / 后端 confirm 时接收的 plain JSON 形态。
 * 写库走 workMapWriter，落到既有 ContextUnit / Space / BoundaryRule，**零新表**。
 */

import type { Priority, TriggerType } from '../boundary/BoundaryRule.js';

export type WorkProfileDraft = {
  /** "产品经理" / "技术 lead" / 自由文本 */
  roleTitle?: string;
  teamName?: string;
  /** 每条会写一条 kind=state, mergeHint=work_map:responsibility:<slug>。 */
  responsibilities: string[];
};

export type ProjectMapDraft = {
  /** Space name; 与 context_spaces(type='project', name) UNIQUE 对齐。 */
  name: string;
  description?: string;
  /** 1-3 句的本周/本阶段目标。每条写一条 kind=goal, mergeHint=work_map:goal:<slug>。 */
  goals: string[];
  /** 权威文档；每个 URL 注册 entity{type:'doc', name:url} 并 link 到 Space。 */
  authoritativeDocs: string[];
  /** 近期 deadline / 承诺；mergeHint=work_map:commitment:<slug>。 */
  upcomingDeadlines: Array<{ title: string; dueAt?: string }>;
  /** 担心 / 风险；kind=uncertainty, mergeHint=work_map:risk:<slug>。 */
  risks: string[];
};

export type StakeholderDraft = {
  /** 必填：协作者姓名（用作 entity name）。 */
  name: string;
  /** 自由文本：他在干嘛 / 怎么协作。 */
  note?: string;
};

export type BoundarySeedDraft = {
  /** 人话描述，仅用于 audit log，不参与 hash。 */
  description: string;
  /** 结构化字段；至少要有一个非空字段，否则视为 noise 不写入。 */
  triggerType?: TriggerType[];
  priorityAtMost?: Priority;
  source?: Array<'calendar' | 'im' | 'mail' | 'drive' | 'manual' | 'agent'>;
  /** 默认 'record'（推到 daily digest）。 */
  allowedAction?: 'record' | 'notify' | 'draft' | 'execute_reversible';
};

export type WorkMapDraft = {
  profile: WorkProfileDraft;
  projects: ProjectMapDraft[];
  stakeholders: StakeholderDraft[];
  preferences: string[];
  boundaries: BoundarySeedDraft[];
};

export type WorkMapWriteSummary = {
  unitsWritten: number;
  unitsUpdated: number;
  spacesWritten: number;
  rulesWritten: number;
  rulesTouched: number;
  bootstrapCompletedAt: string;
};
