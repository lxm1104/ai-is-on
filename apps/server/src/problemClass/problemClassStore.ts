/**
 * MVP51 — 问题类台账存取。表自建（db.exec IF NOT EXISTS），不动 db.ts（避开并行会话热点文件）。
 * problem_class_members：每个 matter 一行（upsert on matter_id）；problem_classes：蒸馏出的类台账。
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import {
  isAuthoritativeClass,
  RESOLVED_HINT_RE,
  type ProblemClass,
  type ProblemClassMember,
  type ProblemClassOrigin,
  type ProblemClassStatus,
  type ClassAnalysis,
  type ClassAnalysisStatus,
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
// MVP54：修复生命周期列（对已存在的表幂等加列）
try {
  db.exec(`ALTER TABLE problem_classes ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`);
} catch {
  // 列已存在
}
// MVP56：系统性分析列（幂等加列）
for (const ddl of [
  `ALTER TABLE problem_classes ADD COLUMN analysis_json TEXT`,
  `ALTER TABLE problem_classes ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE problem_classes ADD COLUMN analyzed_at TEXT`,
]) {
  try {
    db.exec(ddl);
  } catch {
    // 列已存在
  }
}

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
  status: string | null;
  analysis_json: string | null;
  analysis_status: string | null;
  analyzed_at: string | null;
  created_at: string;
  updated_at: string;
};
function rowToClass(r: ClassRow): ProblemClass {
  let analysis: ClassAnalysis | null = null;
  if (r.analysis_json) {
    try {
      analysis = JSON.parse(r.analysis_json) as ClassAnalysis;
    } catch {}
  }
  return {
    id: r.id,
    spaceId: r.space_id,
    label: r.label,
    rootCause: r.root_cause,
    origin: (r.origin as ProblemClassOrigin) ?? 'distilled',
    approved: r.approved === 1,
    memberCount: r.member_count,
    systemic: r.systemic === 1,
    status: (r.status as ProblemClassStatus) ?? 'open',
    analysis,
    analysisStatus: (r.analysis_status as ClassAnalysisStatus) ?? 'none',
    analyzedAt: r.analyzed_at,
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
    status: 'open',
    analysis_json: null,
    analysis_status: 'none',
    analyzed_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO problem_classes (id, space_id, label, root_cause, origin, approved, member_count, systemic, status, analysis_json, analysis_status, analyzed_at, created_at, updated_at)
     VALUES (@id,@space_id,@label,@root_cause,@origin,@approved,@member_count,@systemic,@status,@analysis_json,@analysis_status,@analyzed_at,@created_at,@updated_at)`
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

/** MVP54：设置一个问题类的修复状态（open/fixing/resolved）。 */
export function setProblemClassStatus(id: string, status: ProblemClassStatus, now = new Date().toISOString()): ProblemClass | null {
  if (!getProblemClass(id)) return null;
  db.prepare(`UPDATE problem_classes SET status=?, updated_at=? WHERE id=?`).run(status, now, id);
  return getProblemClass(id);
}

/** MVP56：写入系统性分析结论 → 标「待审阅」（绝不自动落地，等用户审）。 */
export function setClassAnalysis(id: string, analysis: ClassAnalysis, now = new Date().toISOString()): ProblemClass | null {
  if (!getProblemClass(id)) return null;
  db.prepare(`UPDATE problem_classes SET analysis_json=?, analysis_status='pending_review', analyzed_at=?, updated_at=? WHERE id=?`).run(
    JSON.stringify(analysis),
    now,
    now,
    id
  );
  return getProblemClass(id);
}

/** MVP56：用户审阅过该类分析。 */
export function markClassAnalysisReviewed(id: string, now = new Date().toISOString()): ProblemClass | null {
  if (!getProblemClass(id)) return null;
  db.prepare(`UPDATE problem_classes SET analysis_status='reviewed', updated_at=? WHERE id=?`).run(now, id);
  return getProblemClass(id);
}

/** MVP56：取一个类的成员（诊断文本 + 各自最近一次排查轨迹结论），供系统性分析综合。 */
export function getClassMembersForAnalysis(
  classId: string
): Array<{ matterId: string; diagnosticText: string; traceOutcome: string | null }> {
  const members = db
    .prepare(`SELECT matter_id, diagnostic_text FROM problem_class_members WHERE class_id=? AND status='assigned' ORDER BY created_at DESC LIMIT 12`)
    .all(classId) as Array<{ matter_id: string; diagnostic_text: string }>;
  return members.map((m) => {
    const t = db
      .prepare(`SELECT outcome FROM task_traces WHERE matter_id=? AND source='investigation' ORDER BY created_at DESC LIMIT 1`)
      .get(m.matter_id) as { outcome: string | null } | undefined;
    return { matterId: m.matter_id, diagnosticText: m.diagnostic_text, traceOutcome: t?.outcome ?? null };
  });
}

/** MVP55：某 matter 归属的问题类 id（assigned）。 */
export function getClassIdForMatter(matterId: string): string | null {
  const r = db.prepare(`SELECT class_id FROM problem_class_members WHERE matter_id=? AND status='assigned'`).get(matterId) as
    | { class_id: string | null }
    | undefined;
  return r?.class_id ?? null;
}

/** MVP55：该问题类的全部 assigned 成员对应的 matter 是否都已 resolved（无成员则 false）。 */
export function allMemberMattersResolved(classId: string): boolean {
  const members = db.prepare(`SELECT matter_id FROM problem_class_members WHERE class_id=? AND status='assigned'`).all(classId) as Array<{ matter_id: string }>;
  if (members.length === 0) return false;
  for (const m of members) {
    const row = db.prepare(`SELECT status FROM matters WHERE id=?`).get(m.matter_id) as { status: string } | undefined;
    if (!row || row.status !== 'resolved') return false;
  }
  return true;
}

/**
 * P1-4 级联护栏：办结 matterId 是否会让其所在「多成员」问题类的全部成员变 resolved（本 matter 是最后一个未办结成员）
 * → 触发 syncClassStatusForResolvedMatter 把整类（含他人名下成员）静默翻牌。用于把"会翻整类"的 AI 自动办结降级为人确认。
 * 单成员类返回 willComplete=false（翻牌只涉及它自己，无跨成员风险）。返回 classLabel 供回执/提案披露。
 */
export function classCompletionImpactOfResolving(matterId: string): { willComplete: boolean; classId?: string; classLabel?: string } {
  const classId = getClassIdForMatter(matterId);
  if (!classId) return { willComplete: false };
  const cls = db.prepare(`SELECT status, label FROM problem_classes WHERE id=?`).get(classId) as { status: string; label: string } | undefined;
  if (!cls || cls.status === 'resolved') return { willComplete: false };
  const members = db.prepare(`SELECT matter_id FROM problem_class_members WHERE class_id=? AND status='assigned'`).all(classId) as Array<{ matter_id: string }>;
  if (members.length <= 1) return { willComplete: false };
  for (const m of members) {
    if (m.matter_id === matterId) continue;
    const row = db.prepare(`SELECT status FROM matters WHERE id=?`).get(m.matter_id) as { status: string } | undefined;
    if (!row || row.status !== 'resolved') return { willComplete: false }; // 还有别的成员没办结 → 本次不会翻整类
  }
  return { willComplete: true, classId, classLabel: cls.label };
}

/** 台账视图：每个类 + 它的成员摘要 + AI 疑似已修复提示（成员诊断文本里出现"已修复/合入 release"等）。 */
export function listLedger(
  spaceId?: string | null
): Array<ProblemClass & { members: Array<{ matterId: string; diagnosticText: string }>; aiResolvedHint: boolean }> {
  const classes = spaceId === undefined ? listAllClasses() : listClassesForSpace(spaceId);
  return classes.map((c) => {
    const members = (db
      .prepare(`SELECT matter_id, diagnostic_text FROM problem_class_members WHERE class_id=? AND status='assigned' ORDER BY created_at DESC LIMIT 8`)
      .all(c.id) as Array<{ matter_id: string; diagnostic_text: string }>).map((m) => ({ matterId: m.matter_id, diagnosticText: m.diagnostic_text }));
    // AI 疑似已修复：任一成员的诊断/排查轨迹结论里出现"已修复/合入 release"等（仅 open 时提示）
    const traceOutcomes = (db
      .prepare(
        `SELECT outcome FROM task_traces WHERE source='investigation' AND outcome IS NOT NULL
           AND matter_id IN (SELECT matter_id FROM problem_class_members WHERE class_id=? AND status='assigned')`
      )
      .all(c.id) as Array<{ outcome: string }>).map((r) => r.outcome);
    const aiResolvedHint =
      c.status === 'open' &&
      (members.some((m) => RESOLVED_HINT_RE.test(m.diagnosticText)) || traceOutcomes.some((o) => RESOLVED_HINT_RE.test(o)));
    return { ...c, members, aiResolvedHint };
  });
}
