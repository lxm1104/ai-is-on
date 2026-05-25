import { randomUUID } from 'node:crypto';
import { type AuditLogRow, insertAuditLog, listAuditLogs } from '../db.js';

export type AuditAction =
  | 'card_blocked'
  | 'card_softened'
  | 'card_batched_into_digest'
  | 'rule_learned'
  | 'rule_deactivated'
  | 'auto_resolved'
  | 'correction_applied'                // MVP10.0
  | 'correction_reverted'               // MVP10.0
  | 'action_items_confirmed'            // MVP11.1
  | 'action_items_declined'             // MVP11.1
  // MVP14 Step 4：attention 反馈通道
  | 'attention_dismissed_with_learn'
  | 'attention_space_corrected'
  | 'attention_entity_demoted'
  | 'attention_preference_added';

export function writeAudit(input: {
  action: AuditAction;
  reason: string;
  cardId?: string;
  agentRunId?: string;
  ruleId?: string;
  payload?: Record<string, unknown>;
}): void {
  const row: AuditLogRow = {
    id: randomUUID(),
    agent_run_id: input.agentRunId ?? null,
    card_id: input.cardId ?? null,
    rule_id: input.ruleId ?? null,
    action: input.action,
    reason: input.reason,
    payload_json: input.payload ? JSON.stringify(input.payload) : null,
    created_at: new Date().toISOString(),
  };
  insertAuditLog(row);
}

export function listRecentAudits(limit = 200): AuditLogRow[] {
  return listAuditLogs(limit);
}
