/**
 * MVP3 Agent registry → MVP8.1 升级为带 slice 声明。
 *
 * 现在 register 两种形式：
 *  1) registerAgent(type, handler)                       —— 旧路径，slices=[], packet 不装配
 *  2) registerAgent(type, { handler, packetSliceVersion, slices }) —— 新路径
 *
 * MVP8.1 内 track_commitment / prepare_meeting / sync_draft 改成新路径；
 * caring / daily_digest 留在旧路径，MVP8.2 一并迁。
 */

import type { TriggerRow } from '../db.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import type {
  AgentContextPacket,
  PacketSlice,
} from '../context/agentContextAssembler.js';

export type AgentInput = {
  trigger: TriggerRow;
  unit: ContextUnit | null;
  /** MVP8.2 起对所有内置 agent 必填。slices=[] 的 agent 也会收到一个骨架 packet。 */
  packet: AgentContextPacket;
  /** runQueue 透传；agent 写 action_proposals 必须填 agent_run_id。 */
  agentRunId: string;
};

export type AgentOutput = {
  /** Human-readable summary for logs / UI. */
  summary: string;
  /** action_proposal ids produced by this run (0..n). */
  proposalIds: string[];
  /** Card ids produced (typically projected from proposals). */
  cardIds: string[];
  /** Optional structured result payload, persisted to agent_runs.output_json. */
  data?: Record<string, unknown>;
};

export type AgentHandler = (input: AgentInput) => Promise<AgentOutput>;

export type RegisteredAgent = {
  handler: AgentHandler;
  /** ≥1；agent 自己声明，slice 字段定义变化时 ++。 */
  packetSliceVersion: number;
  /** 空数组 = 不装配 packet（旧路径）。 */
  slices: PacketSlice[];
};

const registry = new Map<string, RegisteredAgent>();

/**
 * MVP8.2 起统一走 RegisteredAgent 形式；不再接受裸 handler。
 * slices=[] 仍允许（caring / daily_digest 这类不需要 focal context 的 agent）。
 */
export function registerAgent(agentType: string, spec: RegisteredAgent): void {
  registry.set(agentType, spec);
}

export function getAgent(agentType: string): AgentHandler | null {
  return registry.get(agentType)?.handler ?? null;
}

export function getRegisteredAgent(agentType: string): RegisteredAgent | null {
  return registry.get(agentType) ?? null;
}

export function selectAgentForTrigger(triggerType: string): string | null {
  switch (triggerType) {
    case 'commitment_due':
      return 'track_commitment';
    case 'meeting_prepare':
      return 'prepare_meeting';
    case 'check_in_due':
      return 'caring';
    case 'context_divergence':
      return 'sync_draft';
    case 'daily_digest_due':
      return 'daily_digest';
    // doc_comment_attention 派单已废 — docCommentAgent 删除（MVP14 Step3.5）。
    // trigger 仍可能被写出来，但无 agent 接管时 AgentRunQueue 会跳过。
    case 'meeting_artifact_ready':
      return 'recap_action_items';
    default:
      return null;
  }
}

export function listRegisteredAgents(): string[] {
  return Array.from(registry.keys());
}
