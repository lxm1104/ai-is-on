/**
 * MVP20 §3 / §M2: SelfRoleOnUnit 派生函数。
 *
 * 回答：「self 在这条 commitment / goal / uncertainty unit 上是什么角色？」
 *
 * 数据来源：[context_unit_entities.role](../db.ts) ——triage 抽取时 LLM 已经为每个
 * person entity 标了 raw role（actor / target / about / ...）。本模块把这些
 * raw role 按 §3.2 归一表桶进 4 类 SelfRoleOnUnit。
 *
 * 跟现有 [personProjectInducer](./personProjectInducer.ts) 的关系：
 *   - personProjectInducer：跨 unit 聚合，回答"我在这个项目里整体什么角色"（owner/driver/...）
 *   - 本模块：单 unit，回答"我对这一条具体 commitment 是什么角色"（executor/requester/...）
 *   - 两者粒度不同；混在一起正是 MVP20 修复的 bug 源头
 *
 * self 识别走双路：
 *   A. resolveAliased(entity_id) === selfCanonicalId  —— alias 链命中
 *   B. entity.name === '我'                            —— triage LLM 字面输出兜底
 *      （见方案 §8.1 R1：larkOrgCollector 落 self 时没把 "我" merge 进 alias）
 *
 * 详细设计：docs/MVP20-Commitment用户角色识别与差异化提醒技术方案.md
 */

import { db } from '../db.js';
import { resolveAliased } from './entityResolver.js';

export type SelfRoleOnUnit =
  | 'executor' // 我是这条 unit 的执行方（要做事的人）
  | 'requester' // 我是这条 unit 的提出方/需求方（发起人，但执行不是我）
  | 'reviewer' // 我是这条 unit 的审阅方（决定行不行，但执行不是我）
  | 'observer'; // 我只是被通知/被抄送/被提及，跟我没直接行动责任

// 归一表：见 §3.2。覆盖 personProjectInducer 现有 ACTOR_LIKE(22) + ABOUT_LIKE(16) 全集。
// 关键修正：
//   - target 归 REQUESTER（不是 OBSERVER）：self=target 语义是"别人答应我做某事"
//   - organizer/coordinator/speaker 归 EXECUTOR：主动驱动者
//   - gatekeeper 归 REVIEWER（决定能不能通过）
const EXECUTOR_ROLES = new Set([
  'actor', 'author', 'owner', 'assignee', 'handler', 'fixer',
  'developer', 'editor', 'tester', 'verifier', 'evaluator', 'responder',
  'organizer', 'coordinator', 'speaker',
]);

const REQUESTER_ROLES = new Set([
  'requester', 'reporter', 'proposer', 'initiator', 'source', 'target',
]);

const REVIEWER_ROLES = new Set([
  'reviewer', 'decision_maker', 'confirmer', 'gatekeeper',
]);

const OBSERVER_ROLES = new Set([
  'about', 'subject', 'mentioned', 'cc', 'observer', 'participant',
  'peer', 'forwarder', 'counterpart', 'concerned_party',
  'blocker_source', 'stakeholder', 'involved', 'explainer',
]);

/**
 * 把 context_unit_entities.role 里的字符串归一到 SelfRoleOnUnit。
 * 未识别 role → null（调用方决定 fallback）。
 * 大小写不敏感。
 */
export function mapToSelfRole(rawRole: string): SelfRoleOnUnit | null {
  if (!rawRole) return null;
  const r = rawRole.toLowerCase().trim();
  if (EXECUTOR_ROLES.has(r)) return 'executor';
  if (REQUESTER_ROLES.has(r)) return 'requester';
  if (REVIEWER_ROLES.has(r)) return 'reviewer';
  if (OBSERVER_ROLES.has(r)) return 'observer';
  return null;
}

/** 多角色冲突时取最强：executor > requester > reviewer > observer */
const ROLE_PRIORITY: Record<SelfRoleOnUnit, number> = {
  executor: 4,
  requester: 3,
  reviewer: 2,
  observer: 1,
};

/**
 * 批量取多个 unit 上 self 的角色，避免 N+1。
 *
 * 实现要点：
 *   - SQL 一次取所有 (unitId × person entity) 行，JS 端再判 self 命中
 *   - 双路或：A 路 resolveAliased / B 路 name='我' 兜底
 *   - 同 unit 上 self 多次出现按 ROLE_PRIORITY 取最强
 *   - selfCanonicalId='' / null 时返回全 null Map（settings 未设置 self_person_entity_id）
 *
 * @param unitIds 要查的 unit id 数组（来自 packet.commitments[].id 等）
 * @param selfCanonicalId 已经 resolveAliased 过的 self entity id
 * @returns Map<unitId, SelfRoleOnUnit | null>，所有 unitIds 都有键
 */
export function computeSelfRolesOnUnits(
  unitIds: string[],
  selfCanonicalId: string
): Map<string, SelfRoleOnUnit | null> {
  const acc = new Map<string, SelfRoleOnUnit | null>();
  for (const uid of unitIds) acc.set(uid, null);
  if (unitIds.length === 0) return acc;

  // selfCanonicalId 为空时仍然跑 SQL —— B 路（name='我'）仍可命中
  const placeholders = unitIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         cue.context_unit_id AS uid,
         cue.role            AS role,
         cue.entity_id       AS eid,
         e.name              AS ename
       FROM context_unit_entities cue
       JOIN context_entities e ON e.id = cue.entity_id
       WHERE cue.context_unit_id IN (${placeholders})
         AND e.type = 'person'`
    )
    .all(...unitIds) as Array<{
    uid: string;
    role: string;
    eid: string;
    ename: string;
  }>;

  for (const { uid, role, eid, ename } of rows) {
    // A 路：alias 链解析后等于 self（仅在 selfCanonicalId 非空时尝试）
    const matchA =
      !!selfCanonicalId && resolveAliased(eid) === selfCanonicalId;
    // B 路：name='我' 兜底（triage 大概率字面输出）
    const matchB = ename === '我';
    if (!matchA && !matchB) continue;

    const mapped = mapToSelfRole(role);
    if (!mapped) continue;

    const prev = acc.get(uid) ?? null;
    if (!prev || ROLE_PRIORITY[mapped] > ROLE_PRIORITY[prev]) {
      acc.set(uid, mapped);
    }
  }
  return acc;
}

/**
 * 单 unit 版本：测试用 / commitmentAgent handler 调用用（见 §M5.1）。
 * 底层走 computeSelfRolesOnUnits 批量实现。
 */
export function computeSelfRoleOnUnit(
  unitId: string,
  selfCanonicalId: string
): SelfRoleOnUnit | null {
  return (
    computeSelfRolesOnUnits([unitId], selfCanonicalId).get(unitId) ?? null
  );
}

/** 测试可见性 / 外部消费者可能用到的常量，按需 export */
export const __internal = {
  EXECUTOR_ROLES,
  REQUESTER_ROLES,
  REVIEWER_ROLES,
  OBSERVER_ROLES,
  ROLE_PRIORITY,
};
