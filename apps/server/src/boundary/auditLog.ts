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
  | 'attention_preference_added'
  | 'lark_task_created'
  | 'lark_task_failed'
  | 'im_reply_sent'                     // MVP34：AI 代发飞书 IM 回复
  | 'im_reply_failed'
  | 'lark_doc_created'                  // MVP35：AI 新建飞书文档草稿
  | 'lark_doc_failed'
  | 'investigation_written_back'        // MVP36：AI 自主排查结论回写 matter
  | 'chat_conclusion_written_back'      // MVP46：ask_agent 对话结论回写 matter
  | 'playbook_user_upsert'              // MVP37：用户编写/编辑 playbook
  | 'playbook_approved'
  | 'playbook_active_set'
  | 'project_profile_set'                // MVP38：用户设置项目排查档案
  | 'problem_class_edited'               // MVP51：用户校正问题类（升权威）
  | 'problem_class_approved'
  | 'investigation_clis_edited'          // MVP53：用户在前端改自主排查只读 CLI 白名单
  | 'matter_auto_resolved'               // MVP55：AI 自主办结（高置信、可逆）——独立审计便于复查
  | 'matter_artifact_raised'             // MVP74：AI 替你产出修复方案交付件（hasTargetRef 可审）——"已产出件"度量口径
  | 'investigation_recommended'          // MVP75：AI 给你一条达标的直接建议（结果率北极星分子）
  | 'notify_pushed'                      // MVP77：结果/求助已推送到用户飞书（bot DM，幂等键在 payload）
  | 'notify_failed'                      // MVP77：推送失败留底（通道问题不阻断业务路径）
  | 'notify_reply_handled'               // MVP78：用户在飞书 bot 会话的回复已被处理（回填/命令/引导，mode 在 payload）
  | 'backlog_sweep_proposed'             // MVP78：积压大扫除清单已生成并发飞书（等用户一句话确认，绝不自动清）
  | 'backlog_swept'                      // MVP78：用户确认后批量清理的单件记录（matterId+verdict 可审可恢复）
  | 'backlog_sweep_restored'             // MVP78：用户「恢复 <关键词>」找回误清事项
  | 'consult_asked'                      // MVP79：有人 IM 请你做事 → AI 已收集信息发飞书征询你怎么办
  | 'consult_choice';                    // MVP79：你的处理选择（起草/先查/忽略/自由指示）——习惯学习的原料

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
