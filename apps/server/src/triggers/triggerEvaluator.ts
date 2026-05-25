import { randomUUID } from 'node:crypto';
import {
  type TriggerRow,
  getSetting,
  listContextUnits,
  tryInsertTrigger,
} from '../db.js';
import type { ContextUnit } from '../context/ContextUnit.js';
import {
  type ChangeContext,
  shrinkChangeContextForPayload,
} from '../context/changeContext.js';
import { getContextUnitById } from '../context/contextStore.js';
import { computeSpacePriority } from '../context/agentContextAssembler.js';
import { listSpacesForTarget, listSpaceLinks } from '../db.js';
import { resolveOrCreateEntity } from '../context/entityResolver.js';
import { isCaringPaused } from '../caring/caringSettings.js';
import { detectAllDivergences } from '../spaces/divergenceDetector.js';
import { decodeSemanticTags } from '../context/semanticTags.js';

/**
 * MVP3 §5.3: 只实现 2 类。
 * - commitment_due: 承诺 dueAt-now < 24h，或已逾期 ≤7d。
 * - meeting_prepare: 重要会议（关键字 / 关联高优先级 commitment）30-60 分钟内开始。
 *
 * Evaluator 是**纯函数**：给一条 unit / 一个 now，返回 TriggerDraft[]。
 * 落库 + idempotency 由 `evaluateAndPersist` / scheduler 负责。
 */

export type TriggerType =
  | 'commitment_due'
  | 'meeting_prepare'
  | 'check_in_due'
  | 'context_divergence'
  | 'daily_digest_due'
  | 'doc_comment_attention'
  | 'meeting_artifact_ready';

const DIGEST_HOUR_LOCAL = Number(process.env.DIGEST_HOUR_LOCAL ?? 18);
const DIGEST_COOLDOWN_MS = 18 * 3600_000;

const CHECK_IN_HOUR_LOCAL = 12; // 中午 12 点
const CHECK_IN_COOLDOWN_MS = 12 * 3600_000;

export type TriggerDraft = {
  triggerType: TriggerType;
  contextUnitId: string;
  dueAt?: string;             // 何时该处理（用于 pull worker 排序）
  dueAtBucket?: string;       // idempotency: 同一 bucket 不重复
  reasoning: string;
  payload: Record<string, unknown>;
};

const MEETING_KEYWORDS = ['评审', '汇报', '客户', '1on1', '1:1', '面试', '述职', '同步', '决策'];

const COMMITMENT_DUE_LEAD_MS = 24 * 3600_000;          // <24h 内的承诺
const COMMITMENT_DUE_OVERDUE_MS = 7 * 24 * 3600_000;   // 逾期 ≤7d 仍触发
const MEETING_PREPARE_MIN_MS = 30 * 60_000;            // 提前 30 min
const MEETING_PREPARE_MAX_MS = 60 * 60_000;            // 60 min 前到 30 min 前之间触发

/** Decide trigger drafts for a single ContextUnit, given a wall-clock now. */
export function evaluateUnit(unit: ContextUnit, now: number): TriggerDraft[] {
  const drafts: TriggerDraft[] = [];
  if (unit.status !== 'active') return drafts;
  if (unit.kind === 'commitment') {
    const cd = checkCommitmentDue(unit, now);
    if (cd) drafts.push(cd);
  }
  if (unit.kind === 'event') {
    const mp = checkMeetingPrepare(unit, now);
    if (mp) drafts.push(mp);
    // MVP14 Step3.5：docCommentAgent 已删，doc_comment_attention 不再派单。
    // 文档评论由 enrichment 写为 context_units，由 attention engine 全局推理是否露出。
    // MVP11.1：会议纪要 ready
    const ma = checkMeetingArtifactReady(unit);
    if (ma) drafts.push(ma);
  }
  return drafts;
}

/**
 * MVP11.1 meeting_artifact_ready：
 * - semanticTags.signal_kind === 'meeting_artifact'
 * - bucket = `<minute_token>:<content_hash_bucket>`
 *   同一 minute 同一内容只触发一次；transcript / summary 更新 → bucket 变 → 再触发一次
 */
function checkMeetingArtifactReady(unit: ContextUnit): TriggerDraft | null {
  const { tags } = decodeSemanticTags(unit.meaning);
  if (tags.signal_kind !== 'meeting_artifact') return null;
  const minuteToken = typeof tags.minute_token === 'string' ? tags.minute_token : undefined;
  const bucket =
    typeof tags.content_hash_bucket === 'string' ? tags.content_hash_bucket : undefined;
  if (!minuteToken || !bucket) return null;
  return {
    triggerType: 'meeting_artifact_ready',
    contextUnitId: unit.id,
    dueAtBucket: `${minuteToken}:${bucket}`,
    reasoning: `会议纪要 ${minuteToken} 首次到位（或内容更新）`,
    payload: {
      minuteToken,
      contentHashBucket: bucket,
      hasActionItems: tags.has_action_items === true,
      truncated: tags.truncated === true,
    },
  };
}

// MVP14 Step3.5：checkDocCommentAttention 已删除 — docCommentAgent 不再注册。
// 评论事件本身仍由 enrichment 落成 context_units（kind=event with semanticTags），
// attention engine 在 packet 里看到，按需推到顶部。

function checkCommitmentDue(unit: ContextUnit, now: number): TriggerDraft | null {
  const dueIso = unit.time?.dueAt;
  if (!dueIso) return null;
  const due = new Date(dueIso).getTime();
  if (!Number.isFinite(due)) return null;
  const diff = due - now;                                 // 正=未到期，负=逾期
  if (diff > COMMITMENT_DUE_LEAD_MS) return null;        // 超过 24h 不触发
  if (diff < -COMMITMENT_DUE_OVERDUE_MS) return null;    // 逾期超过 1 周放弃
  const isOverdue = diff < 0;
  const hours = Math.round(Math.abs(diff) / 3600_000);
  const reasoning = isOverdue
    ? `承诺已逾期约 ${hours}h（${unit.title}），检查是否完成或追问`
    : `承诺还有 ${hours}h 到期（${unit.title}），准备提醒`;
  return {
    triggerType: 'commitment_due',
    contextUnitId: unit.id,
    dueAt: dueIso,
    dueAtBucket: bucketByDay(dueIso),
    reasoning,
    payload: {
      commitmentTitle: unit.title,
      dueAt: dueIso,
      overdue: isOverdue,
      hoursAbs: hours,
      entities: unit.entities.map((e) => ({ type: e.type, name: e.name })),
    },
  };
}

function checkMeetingPrepare(unit: ContextUnit, now: number): TriggerDraft | null {
  const startIso = unit.time?.startsAt ?? unit.time?.occurredAt;
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return null;
  const diff = start - now;
  // 必须是未来 30-60 min 内开始（窗口期）
  if (diff < MEETING_PREPARE_MIN_MS || diff > MEETING_PREPARE_MAX_MS) return null;

  // 重要性判断：标题包含关键字 OR scope==='work' 且 actor 存在（保守）
  const text = `${unit.title} ${unit.content}`.toLowerCase();
  const keywordMatch = MEETING_KEYWORDS.some((k) => unit.title.includes(k) || text.includes(k));
  if (!keywordMatch) {
    // MVP3 暂只对带关键字的会议触发；其余按方案 §5.3 留给 MVP3.x
    return null;
  }
  const hours = Math.round(diff / 60_000);
  // MVP8.1 §5.5.1：当会议关联到 active goal 的 Space，附加 spacePriority hint。
  // assembler 会重新计算一遍以补充 docs / name，这里只是给"非 packet 路径"留个回退。
  const spacePriority = inferSpacePriorityForUnit(unit);
  return {
    triggerType: 'meeting_prepare',
    contextUnitId: unit.id,
    dueAt: startIso,
    dueAtBucket: bucketByHour(startIso),
    reasoning: `会议 ${hours} 分钟后开始（${unit.title}），准备会前摘要${
      spacePriority && spacePriority !== 'normal' ? `（Space=${spacePriority}）` : ''
    }`,
    payload: {
      meetingTitle: unit.title,
      startsAt: startIso,
      minutesUntil: hours,
      entities: unit.entities.map((e) => ({ type: e.type, name: e.name })),
      spacePriorityHint: spacePriority,
    },
  };
}

function inferSpacePriorityForUnit(
  unit: ContextUnit
): 'critical' | 'high' | 'normal' | null {
  let best: 'critical' | 'high' | 'normal' = 'normal';
  const seen = new Set<string>();
  for (const e of unit.entities ?? []) {
    try {
      const ent = resolveOrCreateEntity(e.type, e.name);
      const links = listSpacesForTarget('entity', ent.id);
      for (const l of links) {
        if (seen.has(l.space_id)) continue;
        seen.add(l.space_id);
        const allLinks = listSpaceLinks(l.space_id);
        const p = computeSpacePriority(allLinks);
        if (p === 'critical') return 'critical';
        if (p === 'high' && best === 'normal') best = 'high';
      }
    } catch {}
  }
  return seen.size === 0 ? null : best;
}

function bucketByDay(iso: string): string {
  try {
    return iso.slice(0, 10); // YYYY-MM-DD
  } catch {
    return iso;
  }
}

function bucketByHour(iso: string): string {
  try {
    return iso.slice(0, 13); // YYYY-MM-DDTHH
  } catch {
    return iso;
  }
}

// MVP8.0 §5.2: triggers.payload_json 整体 cap = 4 KB。
const TRIGGER_PAYLOAD_MAX_BYTES = 4096;

/**
 * Persist a TriggerDraft. Returns the trigger id, or null if idempotency clashed.
 * 序列化时若 payload 过大 → 对 changeContext.before.title/meaning 截断。
 */
export function persistTrigger(draft: TriggerDraft): string | null {
  const now = new Date().toISOString();
  let payloadJson = JSON.stringify(draft.payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > TRIGGER_PAYLOAD_MAX_BYTES) {
    const cc = (draft.payload as { changeContext?: ChangeContext }).changeContext;
    if (cc?.before) {
      const shrunk = shrinkChangeContextForPayload(cc);
      const next = { ...draft.payload, changeContext: shrunk };
      payloadJson = JSON.stringify(next);
    }
    if (Buffer.byteLength(payloadJson, 'utf8') > TRIGGER_PAYLOAD_MAX_BYTES) {
      // 实在装不下：丢掉 before snapshot，保留 changedFields 元信息
      const cc2 = (draft.payload as { changeContext?: ChangeContext }).changeContext;
      const stripped = cc2 ? { isUpdate: cc2.isUpdate, changedFields: cc2.changedFields } : undefined;
      const next = { ...draft.payload, changeContext: stripped };
      payloadJson = JSON.stringify(next);
    }
  }
  const row: TriggerRow = {
    id: randomUUID(),
    trigger_type: draft.triggerType,
    context_unit_id: draft.contextUnitId,
    payload_json: payloadJson,
    status: 'pending',
    due_at: draft.dueAt ?? null,
    due_at_bucket: draft.dueAtBucket ?? null,
    reasoning: draft.reasoning,
    created_at: now,
    updated_at: now,
  };
  return tryInsertTrigger(row) ? row.id : null;
}

/**
 * Push path: contextStore upsert hook calls this. Synchronous & cheap.
 * Returns the created trigger ids (may be empty).
 *
 * MVP8.0 §5.2: changeContext 是 upsert 时算出的字段级 diff，evaluator 把它原样
 * 塞进每个 draft.payload.changeContext。无 trigger draft 时 diff 自然丢失。
 */
export function evaluateAndPersistForUnit(
  unit: ContextUnit,
  now: number = Date.now(),
  changeContext?: ChangeContext
): string[] {
  const drafts = evaluateUnit(unit, now);
  const ids: string[] = [];
  for (const d of drafts) {
    if (changeContext) {
      d.payload = { ...d.payload, changeContext };
    }
    const id = persistTrigger(d);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Pull path: scheduler invokes this periodically. Scans active ContextUnits
 * that have a dueAt / startsAt in [now, now + lead_time] and evaluates each.
 */
export function evaluateActiveUnitsForPullPath(now: number = Date.now()): string[] {
  const ids: string[] = [];
  // 拉取最近写入且仍 active 的 unit，让 evaluator 重新看（含 commitment + calendar event）
  const candidates = listContextUnits({ limit: 200, status: 'active' });
  for (const row of candidates) {
    const unit = getContextUnitById(row.id);
    if (!unit) continue;
    const drafts = evaluateUnit(unit, now);
    for (const d of drafts) {
      const id = persistTrigger(d);
      if (id) ids.push(id);
    }
  }
  // MVP4.1 check_in_due — 不依赖任何 unit，纯基于"中午 12 点 + 已有 personal context + last_checkin_at>12h ago"
  const cd = evaluateCheckIn(now);
  if (cd) {
    const id = persistTrigger(cd);
    if (id) ids.push(id);
  }
  // MVP6.1 daily_digest_due — 18:00 local 之后，距上次 digest > 18h，合并近 24h P2/P3 卡片
  const dd = evaluateDailyDigest(now);
  if (dd) {
    const id = persistTrigger(dd);
    if (id) ids.push(id);
  }
  // MVP5.1 context_divergence — 扫所有 Space，给每条 divergence finding 写一个 trigger
  try {
    const findings = detectAllDivergences(now);
    for (const f of findings) {
      const draft: TriggerDraft = {
        triggerType: 'context_divergence',
        contextUnitId: f.contextUnitId,
        dueAt: undefined,
        dueAtBucket: `${f.kind}-${new Date(now).toISOString().slice(0, 10)}`,
        reasoning: f.reasoning,
        payload: {
          divergenceKind: f.kind,
          spaceId: f.spaceId,
          spaceName: f.spaceName,
          ...f.payload,
        },
      };
      const id = persistTrigger(draft);
      if (id) ids.push(id);
    }
  } catch (err) {
    console.warn(
      '[triggers] divergence scan failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
  return ids;
}

/**
 * MVP4.1: check_in_due。规则：
 * - 当前是本地中午 12:00 之后（同一日）
 * - settings.last_checkin_at 为空，或距 now > 12h
 * - 用户没暂停情绪分析
 * - 系统有至少 1 条 personal scope ContextUnit（避免在空 db 上触发）
 *
 * idempotency: due_at_bucket=YYYY-MM-DD，确保一天只触发一次。
 * 没有具体 context_unit_id 时用占位 'system' 让 UNIQUE 索引正常工作（SQLite NULL 不视为相等）。
 */
export function evaluateCheckIn(now: number): TriggerDraft | null {
  if (isCaringPaused()) return null;
  const d = new Date(now);
  if (d.getHours() < CHECK_IN_HOUR_LOCAL) return null;
  const last = getSetting('last_checkin_at');
  if (last) {
    const lastMs = new Date(last).getTime();
    if (Number.isFinite(lastMs) && now - lastMs < CHECK_IN_COOLDOWN_MS) return null;
  }
  // 至少要有点 personal context 可以聊
  const personalRows = listContextUnits({ status: 'active', limit: 200 }).filter(
    (r) => r.scope === 'personal'
  );
  if (personalRows.length === 0) return null;

  const dayBucket = d.toISOString().slice(0, 10);
  return {
    triggerType: 'check_in_due',
    contextUnitId: 'system',                        // 占位
    dueAt: d.toISOString(),
    dueAtBucket: dayBucket,
    reasoning: `中午 12 点后，过去 12h 没 check-in，且有 ${personalRows.length} 条 personal context`,
    payload: {
      personalUnitCount: personalRows.length,
      hourLocal: d.getHours(),
    },
  };
}

/** MVP6.1 daily_digest_due. 18:00 local 之后，每日最多一次。 */
export function evaluateDailyDigest(now: number): TriggerDraft | null {
  const d = new Date(now);
  if (d.getHours() < DIGEST_HOUR_LOCAL) return null;
  const last = getSetting('last_digest_at');
  if (last) {
    const lastMs = new Date(last).getTime();
    if (Number.isFinite(lastMs) && now - lastMs < DIGEST_COOLDOWN_MS) return null;
  }
  const dayBucket = d.toISOString().slice(0, 10);
  return {
    triggerType: 'daily_digest_due',
    contextUnitId: 'system',
    dueAt: d.toISOString(),
    dueAtBucket: dayBucket,
    reasoning: `${DIGEST_HOUR_LOCAL} 点后，距上次日报 > 18h，准备合并 P2/P3`,
    payload: { hourLocal: d.getHours() },
  };
}
