/**
 * MVP3 Agent registry.
 * Each agent is a handler that takes the resolved trigger context and returns
 * the side-effects it produced (proposals / cards). The queue persists
 * agent_runs metadata around it.
 *
 * MVP3 registers exactly 2 handlers:
 *   - prepare_meeting    (LLM-backed, 一次性 subprocess)
 *   - track_commitment   (纯本地)
 *
 * Mapping from trigger_type → agent_type is hard-coded in selectAgentForTrigger.
 */

import type { TriggerRow } from '../db.js';
import type { ContextUnit } from '../context/ContextUnit.js';

export type AgentInput = {
  trigger: TriggerRow;
  unit: ContextUnit | null;
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

const handlers = new Map<string, AgentHandler>();

export function registerAgent(agentType: string, handler: AgentHandler) {
  handlers.set(agentType, handler);
}

export function getAgent(agentType: string): AgentHandler | null {
  return handlers.get(agentType) ?? null;
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
    default:
      return null;
  }
}

export function listRegisteredAgents(): string[] {
  return Array.from(handlers.keys());
}
