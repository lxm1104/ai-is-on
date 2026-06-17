/**
 * MVP51 — 问题类聚合服务：诊断结论 → 成员；攒够 → LLM 按根因归类（LLM 拥有类身份）。
 *
 * 触发：自主排查回写后 fire-and-forget ingestConclusion()，失败静默（纯增量，不碰主流程）。
 * 蒸馏：每 space 攒够 ≥2 条 pending 诊断成员 → 一次 one-shot，把它们归到已有类 / 开新类 / reject。
 * 省 token：确定性只做"诊断门 + 症状预分桶 + 攒批"，LLM 只在攒够时打一次、只喂最新 K 条。
 */
import { db, getContextSpace } from '../db.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { config } from '../config.js';
import { deriveSymptomBucket, isDiagnostic, stripSummaryPrefix } from './problemClassTypes.js';
import {
  upsertMember,
  listPendingMembers,
  countPendingMembers,
  listSpacesWithPending,
  setMemberAssigned,
  setMemberRejected,
  createDistilledClass,
  listClassesForSpace,
  refreshClass,
  getClassIdForMatter,
  allMemberMattersResolved,
  getProblemClass,
  setProblemClassStatus,
  getClassMembersForAnalysis,
  setClassAnalysis,
} from './problemClassStore.js';
import {
  PROBLEM_CLASS_DISTILL_SYSTEM,
  buildProblemClassMessage,
  parseProblemClassOutput,
} from './problemClassDistillPrompt.js';
import {
  PROBLEM_CLASS_ANALYZE_SYSTEM,
  buildClassAnalyzeMessage,
  parseClassAnalysis,
} from './problemClassAnalyzePrompt.js';

const MIN_MEMBERS = 2; // 攒够这么多 pending 诊断成员才归类（≥3 成员的类自动标 systemic）
const BATCH_K = 12; // 单次最多喂这么多 pending 成员，控 token
const MEMBER_MIN_CONF = 0.6;

export type IngestInput = {
  matterId: string;
  spaceId: string | null;
  text: string; // 诊断/根因文本（investigation factSummary 或 matter currentSummary）
  evidence?: string[];
  confidence?: number;
};

export type DistillDeps = { judge?: (system: string, user: string) => Promise<string> };

async function defaultJudge(system: string, user: string): Promise<string> {
  const r = await runOneShot(user, { agentName: 'aiisn-problem-class-distill', systemPrompt: system, lane: 'investigation' });
  return r.text;
}

/** 把一条诊断结论吸纳为问题类成员（过诊断门 + 症状预分桶 + upsert）。返回是否吸纳。 */
export function ingestMember(input: IngestInput): boolean {
  if (!config.problemClassEnabled) return false;
  const text = (input.text || '').trim();
  if (!isDiagnostic(text)) return false;
  if ((input.confidence ?? 0.6) < MEMBER_MIN_CONF) return false;
  upsertMember({
    matterId: input.matterId,
    spaceId: input.spaceId,
    symptomBucket: deriveSymptomBucket(text),
    diagnosticText: text,
    evidence: input.evidence ?? [],
    confidence: input.confidence ?? 0.6,
  });
  return true;
}

/** 触发器：自主排查回写后调用（fire-and-forget）。吸纳成员，再尝试该 space 的蒸馏。 */
export async function ingestConclusion(input: IngestInput, deps: DistillDeps = {}): Promise<void> {
  if (!ingestMember(input)) return;
  try {
    await maybeDistillForSpace(input.spaceId, deps);
  } catch (err) {
    console.warn('[problem-class] 蒸馏失败:', err instanceof Error ? err.message : String(err));
  }
}

/** 某 space 攒够 pending 成员 → 一次 LLM 按根因归类。返回是否产出/更新了类。 */
export async function maybeDistillForSpace(spaceId: string | null, deps: DistillDeps = {}): Promise<boolean> {
  if (!config.problemClassEnabled) return false;
  if (countPendingMembers(spaceId) < MIN_MEMBERS) return false;

  const pending = listPendingMembers(spaceId, BATCH_K);
  if (pending.length < MIN_MEMBERS) return false;
  const existingClasses = listClassesForSpace(spaceId);
  const profile = spaceId ? getContextSpace(spaceId)?.investigation_profile ?? null : null;

  const judge = deps.judge ?? defaultJudge;
  const user = buildProblemClassMessage({
    members: pending.map((m) => ({ matterId: m.matterId, symptomBucket: m.symptomBucket, diagnosticText: m.diagnosticText, evidence: m.evidence })),
    existingClasses: existingClasses.map((c) => ({ id: c.id, label: c.label, rootCause: c.rootCause })),
    projectProfile: profile,
  });

  let assignments;
  try {
    const text = await judge(PROBLEM_CLASS_DISTILL_SYSTEM, user);
    assignments = parseProblemClassOutput(text, new Set(pending.map((m) => m.matterId)), new Set(existingClasses.map((c) => c.id)));
  } catch (err) {
    console.warn('[problem-class] judge 失败:', err instanceof Error ? err.message : String(err));
    return false;
  }
  if (!assignments.length) return false;

  const newClassByLabel = new Map<string, string>(); // 同批同标签的新类只建一次
  const touched = new Set<string>();
  let changed = false;
  for (const a of assignments) {
    if (a.reject) {
      setMemberRejected(a.matterId, a.reason ?? null);
      changed = true;
      continue;
    }
    if (a.classId) {
      setMemberAssigned(a.matterId, a.classId);
      touched.add(a.classId);
      changed = true;
      continue;
    }
    if (a.newClass) {
      const key = a.newClass.label.trim().toLowerCase();
      let cid = newClassByLabel.get(key);
      if (!cid) {
        const cls = createDistilledClass({ spaceId, label: a.newClass.label, rootCause: a.newClass.rootCause });
        cid = cls.id;
        newClassByLabel.set(key, cid);
      }
      setMemberAssigned(a.matterId, cid);
      touched.add(cid);
      changed = true;
    }
  }
  // 刷新被触达的类（计数 + systemic；distilled 类顺带把根因刷新成本批 LLM 给的最新文案，避让权威版）
  for (const cid of touched) {
    const fromNew = [...newClassByLabel.values()].includes(cid);
    if (fromNew) {
      const nc = assignments.find((a) => a.newClass && newClassByLabel.get(a.newClass.label.trim().toLowerCase()) === cid)?.newClass;
      refreshClass(cid, { rootCause: nc?.rootCause, label: nc?.label });
    } else {
      refreshClass(cid);
    }
  }
  // MVP56：刚成 systemic 的类 → fire-and-forget 出一份系统性分析（maybeAnalyzeClass 内部判 systemic + 未分析 + gated）
  for (const cid of touched) void maybeAnalyzeClass(cid, deps).catch(() => {});
  if (changed) console.log(`[problem-class] space=${spaceId ?? '全局'} 归类 ${assignments.length} 条，新类 ${newClassByLabel.size} 个`);
  return changed;
}

// ---- MVP56：问题类系统性分析（综合多 case → 系统性根因+解法，结论待用户审阅，绝不自动执行） ----

export type AnalyzeDeps = { judge?: (system: string, user: string) => Promise<string> };

async function defaultAnalyzeJudge(system: string, user: string, priority: boolean): Promise<string> {
  const r = await runOneShot(user, { agentName: 'aiisn-problem-class-analyze', systemPrompt: system, lane: 'investigation', priority });
  return r.text;
}

/** 对一个问题类做系统性分析，写入「待审阅」结论。返回是否产出。用户手点(priority)/自动触发都走它。 */
export async function analyzeClass(classId: string, deps: AnalyzeDeps = {}, opts: { priority?: boolean } = {}): Promise<boolean> {
  if (!config.problemClassEnabled) return false;
  const cls = getProblemClass(classId);
  if (!cls) return false;
  const members = getClassMembersForAnalysis(classId);
  if (members.length < 1) return false;
  const profile = cls.spaceId ? getContextSpace(cls.spaceId)?.investigation_profile ?? null : null;
  const judge = deps.judge ?? ((s: string, u: string) => defaultAnalyzeJudge(s, u, opts.priority ?? false));
  let parsed;
  try {
    const text = await judge(
      PROBLEM_CLASS_ANALYZE_SYSTEM,
      buildClassAnalyzeMessage({ label: cls.label, rootCause: cls.rootCause, members, projectProfile: profile })
    );
    parsed = parseClassAnalysis(text);
  } catch (err) {
    console.warn('[problem-class] 系统性分析失败:', err instanceof Error ? err.message : String(err));
    return false;
  }
  if (!parsed) return false;
  setClassAnalysis(classId, parsed); // → analysis_status='pending_review'，等用户审
  console.log(`[problem-class] 已对「${cls.label}」产出系统性分析（待审阅）`);
  return true;
}

/** 自动触发：类成 systemic（≥3）且尚无分析时，fire-and-forget 出一份系统性分析（gated）。 */
export async function maybeAnalyzeClass(classId: string, deps: AnalyzeDeps = {}): Promise<boolean> {
  if (!config.problemClassAutoAnalyzeEnabled) return false;
  const cls = getProblemClass(classId);
  if (!cls || !cls.systemic) return false;
  if (cls.analysisStatus !== 'none') return false; // 已分析（待审/已审）不重复自动跑
  return analyzeClass(classId, deps);
}

/** MVP55：某 matter 办结后，若其问题类的全部成员都已 resolved → 自动把该类标记已修复（可逆，用户能重开）。 */
export function syncClassStatusForResolvedMatter(matterId: string): void {
  if (!config.problemClassEnabled) return;
  const classId = getClassIdForMatter(matterId);
  if (!classId) return;
  const cls = getProblemClass(classId);
  if (!cls || cls.status === 'resolved') return;
  if (allMemberMattersResolved(classId)) {
    setProblemClassStatus(classId, 'resolved');
    console.log(`[problem-class] 全部成员已办结 → 自动标记问题类「${cls.label}」已修复`);
  }
}

/** 扫所有有 pending 的 space 各蒸馏一次（启动 backfill 后/调试用）。 */
export async function distillAllPending(deps: DistillDeps = {}): Promise<number> {
  let n = 0;
  for (const sid of listSpacesWithPending()) {
    if (await maybeDistillForSpace(sid, deps)) n += 1;
  }
  return n;
}

// ---- 一次性 backfill：把已有 matters 里携带诊断/根因的摘要补成成员（day-1 内容） ----

type MatterDiagRow = { id: string; primary_space_id: string | null; current_summary: string | null; confidence: number | null };

/** 扫 matters 表，把带诊断信号的 current_summary 吸纳为成员。返回吸纳数。 */
export function backfillMembersFromMatters(): number {
  if (!config.problemClassEnabled) return 0;
  const rows = db
    .prepare(
      `SELECT id, primary_space_id, current_summary, confidence FROM matters
        WHERE current_summary IS NOT NULL AND current_summary != ''
          AND status IN ('open','in_progress','blocked','resolved')`
    )
    .all() as MatterDiagRow[];
  let n = 0;
  for (const r of rows) {
    const text = stripSummaryPrefix(r.current_summary || '');
    if (ingestMember({ matterId: r.id, spaceId: r.primary_space_id, text, confidence: r.confidence ?? 0.6 })) n += 1;
  }
  return n;
}
