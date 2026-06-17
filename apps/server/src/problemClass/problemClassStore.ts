/**
 * MVP51 — 问题类台账存取。表自建（db.exec IF NOT EXISTS），不动 db.ts（避开并行会话热点文件）。
 * problem_class_members：每个 matter 一行（upsert on matter_id）；problem_classes：蒸馏出的类台账。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import {
  isAuthoritativeClass,
  type ProblemClass,
  type ProblemClassMember,
  type ProblemClassOrigin,
  type MemberStatus,
} from './problemClassTypes.js';

db.exec(`
CREATE TABLE IF NOT EXISTS problem_class_members (
  matter_id TEXT PRIMARY KEY,
  space_id TEXT,
  symptom_bucket TEXT NOT NULL,
  diagnostic_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  class_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pcm_space_status ON problem_class_members (space_id, status);
CREATE INDEX IF NOT EXISTS idx_pcm_class ON problem_class_members (class_id);
CREATE TABLE IF NOT EXISTS problem_classes (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  label TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'distilled',
  approved INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  systemic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_space ON problem_classes (space_id);
`);

type MemberRow = {
  matter_id: string;
  space_id: string | null;
  symptom_bucket: string;
  diagnostic_text: string;
  evidence_json: string;
  confidence: number;
  class_id: string | null;
  status: string;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
};

function rowToMember(r: MemberRow): ProblemClassMember {
  let evidence: string[] = [];
  try {
    evidence = JSON.parse(r.evidence_json);
  } catch {}
  return {
    matterId: r.matter_id,
    spaceId: r.space_id,
    symptomBucket: r.symptom_bucket,
    diagnosticText: r.diagnostic_text,
    evidence,
    confidence: r.confidence,
    classId: r.class_id,
    status: r.status as MemberStatus,
    rejectReason: r.reject_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** upsert 一条成员（按 matter_id）。已 assigned 的成员重投时保留其 class/status（避免再投churn）。 */
export function upsertMember(input: {
  matterId: string;
  spaceId: string | null;
  symptomBucket: string;
  diagnosticText: string;
  evidence: string[];
  confidence: number;
  now?: string;
}): { member: ProblemClassMember; isNew: boolean } {
  const now = input.now ?? new Date().toISOString();
  const existing = db.prepare(`SELECT * FROM problem_class_members WHERE matter_id = ?`).get(input.matterId) as
    | MemberRow
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE problem_class_members SET space_id=@space_id, symptom_bucket=@symptom_bucket,
         diagnostic_text=@diagnostic_text, evidence_json=@evidence_json, confidence=@confidence, updated_at=@updated_at
       WHERE matter_id=@matter_id`
    ).run({
      matter_id: input.matterId,
      space_id: input.spaceId,
      symptom_bucket: input.symptomBucket,
      diagnostic_text: input.diagnosticText.slice(0, 400),
      evidence_json: JSON.stringify(input.evidence.slice(0, 4)),
      confidence: input.confidence,
      updated_at: now,
    });
    return { member: rowToMember(db.prepare(`SELECT * FROM problem_class_members WHERE matter_id=?`).get(input.matterId) as MemberRow), isNew: false };
  }
  const row: MemberRow = {
    matter_id: input.matterId,
    space_id: input.spaceId,
    symptom_bucket: input.symptomBucket,
    diagnostic_text: input.diagnosticText.slice(0, 400),
    evidence_json: JSON.stringify(input.evidence.slice(0, 4)),
    confidence: input.confidence,
    class_id: null,
    status: 'pending',
    reject_reason: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO problem_class_members (matter_id, space_id, symptom_bucket, diagnostic_text, evidence_json, confidence, class_id, status, reject_reason, created_at, updated_at)
     VALUES (@matter_id,@space_id,@symptom_bucket,@diagnostic_text,@evidence_json,@confidence,@class_id,@status,@reject_reason,@created_at,@updated_at)`
  ).run(row);
  return { member: rowToMember(row), isNew: true };
}

/** 取某 space 下 pending（待归类）成员，最新优先。spaceId 为 null 用 IS NULL 匹配全局。 */
export function listPendingMembers(spaceId: string | null, limit = 12): ProblemClassMember[] {
  const sql = spaceId
    ? `SELECT * FROM problem_class_members WHERE space_id=? AND status='pending' ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM problem_class_members WHERE space_id IS NULL AND status='pending' ORDER BY created_at DESC LIMIT ?`;
  const rows = (spaceId ? db.prepare(sql).all(spaceId, limit) : db.prepare(sql).all(limit)) as MemberRow[];
  return rows.map(rowToMember);
}

export function countPendingMembers(spaceId: string | null): number {
  const sql = spaceId
    ? `SELECT COUNT(*) AS n FROM problem_class_members WHERE space_id=? AND status='pending'`
    : `SELECT COUNT(*) AS n FROM problem_class_members WHERE space_id IS NULL AND status='pending'`;
  const r = (spaceId ? db.prepare(sql).get(spaceId) : db.prepare(sql).get()) as { n: number };
  return r.n;
}

/** 找出有 pending 成员的各 space（含 null）。 */
export function listSpacesWithPending(): Array<string | null> {
  const rows = db
    .prepare(`SELECT DISTINCT space_id FROM problem_class_members WHERE status='pending'`)
    .all() as Array<{ space_id: string | null }>;
  return rows.map((r) => r.space_id);
}

export function setMemberAssigned(matterId: string, classId: string, now = new Date().toISOString()): void {
  db.prepare(`UPDATE problem_class_members SET class_id=?, status='assigned', reject_reason=NULL, updated_at=? WHERE matter_id=?`).run(classId, now, matterId);
}
export function setMemberRejected(matterId: string, reason: string | null, now = new Date().toISOString()): void {
  db.prepare(`UPDATE problem_class_members SET status='rejected', reject_reason=?, updated_at=? WHERE matter_id=?`).run(reason ?? null, now, matterId);
}

// ---- classes ----

type ClassRow = {
  id: string;
  space_id: string | null;
  label: string;
  root_cause: string;
  origin: string;
  approved: number;
  member_count: number;
  systemic: number;
  created_at: string;
  updated_at: string;
};
function rowToClass(r: ClassRow): ProblemClass {
  return {
    id: r.id,
    spaceId: r.space_id,
    label: r.label,
    rootCause: r.root_cause,
    origin: (r.origin as ProblemClassOrigin) ?? 'distilled',
    approved: r.approved === 1,
    memberCount: r.member_count,
    systemic: r.systemic === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getProblemClass(id: string): ProblemClass | null {
  const r = db.prepare(`SELECT * FROM problem_classes WHERE id=?`).get(id) as ClassRow | undefined;
  return r ? rowToClass(r) : null;
}

export function listClassesForSpace(spaceId: string | null): ProblemClass[] {
  const sql = spaceId ? `SELECT * FROM problem_classes WHERE space_id=? ORDER BY updated_at DESC` : `SELECT * FROM problem_classes WHERE space_id IS NULL ORDER BY updated_at DESC`;
  const rows = (spaceId ? db.prepare(sql).all(spaceId) : db.prepare(sql).all()) as ClassRow[];
  return rows.map(rowToClass);
}

export function listAllClasses(): ProblemClass[] {
  return (db.prepare(`SELECT * FROM problem_classes ORDER BY member_count DESC, updated_at DESC`).all() as ClassRow[]).map(rowToClass);
}

/** 蒸馏新建一个 suggest 档类（LLM 开的新类）。 */
export function createDistilledClass(input: { spaceId: string | null; label: string; rootCause: string; now?: string }): ProblemClass {
  const now = input.now ?? new Date().toISOString();
  const row: ClassRow = {
    id: randomUUID(),
    space_id: input.spaceId,
    label: input.label.slice(0, 40),
    root_cause: input.rootCause.slice(0, 400),
    origin: 'distilled',
    approved: 0,
    member_count: 0,
    systemic: 0,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO problem_classes (id, space_id, label, root_cause, origin, approved, member_count, systemic, created_at, updated_at)
     VALUES (@id,@space_id,@label,@root_cause,@origin,@approved,@member_count,@systemic,@created_at,@updated_at)`
  ).run(row);
  return rowToClass(row);
}

/** 重算某类的成员数 + systemic 标记（≥3 个 assigned 成员视为系统性）。distilled 类可顺带刷新根因（避让权威版）。 */
export function refreshClass(classId: string, opts: { rootCause?: string; label?: string; now?: string } = {}): ProblemClass | null {
  const existing = getProblemClass(classId);
  if (!existing) return null;
  const now = opts.now ?? new Date().toISOString();
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM problem_class_members WHERE class_id=? AND status='assigned'`).get(classId) as { n: number }).n;
  const systemic = cnt >= 3 ? 1 : 0;
  // 只在非权威（distilled & 未批准）时允许蒸馏刷新文案；权威版只更新计数。
  const canRewrite = !isAuthoritativeClass(existing) && (opts.rootCause || opts.label);
  if (canRewrite) {
    db.prepare(`UPDATE problem_classes SET label=@label, root_cause=@root_cause, member_count=@n, systemic=@systemic, updated_at=@now WHERE id=@id`).run({
      id: classId,
      label: (opts.label ?? existing.label).slice(0, 40),
      root_cause: (opts.rootCause ?? existing.rootCause).slice(0, 400),
      n: cnt,
      systemic,
      now,
    });
  } else {
    db.prepare(`UPDATE problem_classes SET member_count=?, systemic=?, updated_at=? WHERE id=?`).run(cnt, systemic, now, classId);
  }
  return getProblemClass(classId);
}

/** 用户编辑一个类的标签/根因 → 升为权威版（origin=user, approved=1），自发蒸馏不再覆盖。 */
export function userEditClass(id: string, input: { label?: string; rootCause?: string; now?: string }): ProblemClass | null {
  const existing = getProblemClass(id);
  if (!existing) return null;
  const now = input.now ?? new Date().toISOString();
  db.prepare(
    `UPDATE problem_classes SET label=@label, root_cause=@root_cause, origin='user', approved=1, updated_at=@now WHERE id=@id`
  ).run({
    id,
    label: (input.label ?? existing.label).slice(0, 40),
    root_cause: (input.rootCause ?? existing.rootCause).slice(0, 400),
    now,
  });
  return getProblemClass(id);
}

/** 批准一个蒸馏草稿类 → 升权威（approved=1），不再被自发蒸馏覆盖根因文案。 */
export function approveClass(id: string, now = new Date().toISOString()): ProblemClass | null {
  if (!getProblemClass(id)) return null;
  db.prepare(`UPDATE problem_classes SET approved=1, updated_at=? WHERE id=?`).run(now, id);
  return getProblemClass(id);
}

/** 台账视图：每个类 + 它的成员摘要。 */
export function listLedger(spaceId?: string | null): Array<ProblemClass & { members: Array<{ matterId: string; diagnosticText: string }> }> {
  const classes = spaceId === undefined ? listAllClasses() : listClassesForSpace(spaceId);
  return classes.map((c) => {
    const members = (db
      .prepare(`SELECT matter_id, diagnostic_text FROM problem_class_members WHERE class_id=? AND status='assigned' ORDER BY created_at DESC LIMIT 8`)
      .all(c.id) as Array<{ matter_id: string; diagnostic_text: string }>).map((m) => ({ matterId: m.matter_id, diagnosticText: m.diagnostic_text }));
    return { ...c, members };
  });
}
