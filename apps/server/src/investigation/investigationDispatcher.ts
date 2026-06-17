/**
 * MVP36 — 自主排查 dispatcher：后台低频自动挑"需排查"的 matter → 跑只读排查 → 回写结论。
 *
 * 安全设计：默认关（config.investigationDispatchEnabled）；每 tick 至多 1 件；同 matter 有冷却（默认 6h）；
 * 单件 in-flight 锁（不并发派发，避免单并发 LLM gate 进一步拥塞）；排查走 priority:false **让位 attention**。
 * 排查全程硬只读（aiisn-investigate 全工具 deny + 白名单只读工具），回写绝不自动改 status。
 *
 * 选件/worthiness 为纯函数 → 可单测。调度部分薄。
 */
import { config } from '../config.js';
import { getContextEntityById, hasLiveMatterProposal, getRecentInvestigationVerdicts } from '../db.js';
import { listMatters, listMatterEntities } from '../matter/matterStore.js';
import type { Matter } from '../matter/matterTypes.js';
import { runInvestigation } from './investigationLoop.js';
import { applyInvestigationResult } from './investigationWriteback.js';
import { captureInvestigationTrace } from '../playbook/playbookCapture.js';
import { matchPlaybookForMatter, renderPlaybookForPrompt } from '../playbook/playbookMatcher.js';
import { resolveProjectProfileForMatter } from './projectProfile.js';
import { resolveProjectSpaceDeterministic } from './projectRouter.js';
import { ingestConclusion, syncClassStatusForResolvedMatter } from '../problemClass/problemClassService.js';

// deriveDefaultNextAction 的兜底文案——这些太泛，不值得自动排查（要具体的"确认X是否…"才查）。
const GENERIC_NEXT_ACTIONS = new Set([
  '跟进进展并确认结果',
  '推进交付并向对方确认收到',
  '向相关方澄清阻塞点并推动解除',
  '完成评审并反馈意见',
  '确认决策结论并同步相关方',
  '协调相关方对齐时间与分工',
  '参与讨论并推动形成结论',
]);

// 需要"去外部系统查证状态"的下一步：确认是否/核实/排查进展/跟进…结果 等。
// MVP48：补「IM-可查的悬而未决状态」——待确认/待回复/未回复/未闭环/不确定。实测 55 个从未被排查的
// active matter 多是泛兜底 nextAction（被排除），但其中"评测集接收方不确定""暂停时间待确认""待办未闭环"
// 这类**状态就在飞书 IM 里、现在就能查清**。刻意不含「待验证/修复/环境」等代码/系统类（留给 run_command）；
// 这些词均不出现在任何泛兜底 nextAction 里，故不会经 nextAction 误触发。查不到也有 MVP45 止损兜底退避。
const WORTHY_RE =
  /(是否|核实|排查(进展|结果)?|查清|查证|确认.*(进展|完成|收到|发|回复)|跟进.*(进展|结果|排查)|待确认|待回复|未回复|未闭环|不确定)/;

// MVP52：run_command 落地后，"代码/系统类 badcase"不再只能留给人——只要带**可解析的凭据**
// （日志ID/traceID，run_command 能 bytedcli→fornax→grep 追下去），就值得自动排查。
// 失败信号 + 凭据 双命中才放行（仅"报错"无凭据不进，避免泛触发挤兑单并发 gate）。
const BADCASE_SIGNAL_RE = /报错|bug|缺陷|失败|崩|异常|panic|超时|截断|无权限|鉴权失败|沙箱|trace|日志/i;
const ARTIFACT_RE = /\b\d{16,20}\b|trace[_-]?id|traceid|日志\s*ID|run[_-]?log/i;

/** 代码/系统类 badcase 且带 run_command 可解析的凭据（日志ID/traceID）→ 值得自主排查。纯函数。 */
export function hasResolvableBadcase(input: { title?: string; currentSummary?: string | null }): boolean {
  const blob = `${input.title ?? ''} ${input.currentSummary ?? ''}`;
  return BADCASE_SIGNAL_RE.test(blob) && ARTIFACT_RE.test(blob);
}

/**
 * 这件事值不值得自动排查（纯函数）。看 标题 + 下一步 + 摘要：
 * - nextAction 具体（非泛兜底）且命中查证词 → worthy；
 * - 或标题本身命中查证词（如"排查宁波力劲…"）→ worthy；
 * - 或（MVP52）代码/系统类 badcase 且带可解析凭据（日志ID/traceID）→ worthy（交给 run_command 追）。
 */
export function isInvestigationWorthy(input: { title?: string; nextAction?: string | null; currentSummary?: string | null }): boolean {
  const na = (input.nextAction ?? '').trim();
  const ti = (input.title ?? '').trim();
  const naWorthy = na.length >= 6 && !GENERIC_NEXT_ACTIONS.has(na) && WORTHY_RE.test(na);
  const tiWorthy = ti.length >= 4 && WORTHY_RE.test(ti);
  return naWorthy || tiWorthy || hasResolvableBadcase({ title: input.title, currentSummary: input.currentSummary });
}

const PRIO_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * 止损（纯函数）：近 N(默认2) 次排查都是**真** unknown → 飞书查不清，退避不再空查。
 * 只数 confidence>0 的真 unknown：conf=0 是排查器空转/工具报错的退化哨兵（瞬时失败），
 * 不能算进永久放弃（实测 2 个 matter 因两次 conf0 退化被误背刺、从没真查过 → MVP45）。
 */
export function isStuckOnUnknowns(
  recent: Array<{ verdict: string; confidence: number }>,
  n = 2
): boolean {
  const genuine = recent.filter((r) => !(r.verdict === 'unknown' && r.confidence <= 0));
  if (genuine.length < n) return false;
  return genuine.slice(0, n).every((r) => r.verdict === 'unknown');
}

/**
 * 从候选 matter 里挑最该查的一件（纯函数）：worthy + 不在冷却 + 不该止损 → 按 优先级↑ 再 最久未动↑ 取 top-1。
 * @param isCoolingDown 在冷却期内
 * @param shouldSkip 止损：已有 live 提案(结论已交用户) 或 连续 unknown(查不清) → 跳过，把配额导向新事项
 */
export function selectInvestigationCandidate(
  matters: Matter[],
  isCoolingDown: (matterId: string) => boolean,
  shouldSkip: (matterId: string) => boolean = () => false
): Matter | null {
  const pool = matters.filter(
    (m) =>
      (m.status === 'open' || m.status === 'in_progress') &&
      isInvestigationWorthy({ title: m.title, nextAction: m.nextAction, currentSummary: m.currentSummary }) &&
      !isCoolingDown(m.id) &&
      !shouldSkip(m.id)
  );
  if (pool.length === 0) return null;
  pool.sort((a, b) => {
    const pr = (PRIO_RANK[a.priority] ?? 3) - (PRIO_RANK[b.priority] ?? 3);
    if (pr !== 0) return pr;
    return (a.updatedAt || '').localeCompare(b.updatedAt || ''); // 最久未动优先
  });
  return pool[0];
}

// ---- 调度（薄）----

const lastInvestigatedAt = new Map<string, number>();
let inFlight = false;
let timer: ReturnType<typeof setInterval> | null = null;

function isCoolingDown(matterId: string, now: number): boolean {
  const last = lastInvestigatedAt.get(matterId);
  return last !== undefined && now - last < config.investigationCooldownMs;
}

function buildEntities(matterId: string): Array<{ type: string; name: string; role: string }> {
  return listMatterEntities(matterId)
    .map((l) => {
      const e = getContextEntityById(l.entityId);
      return e ? { type: e.type, name: e.name, role: String(l.role) } : null;
    })
    .filter((x): x is { type: string; name: string; role: string } => x !== null)
    .slice(0, 8);
}

/** 跑一次派发 tick。返回是否真的派发了一件。 */
export async function runInvestigationDispatchTick(): Promise<boolean> {
  if (!config.investigationDispatchEnabled || inFlight) return false;
  const now = Date.now();
  const candidate = selectInvestigationCandidate(
    listMatters({ statuses: ['open', 'in_progress'], limit: 200 }),
    (id) => isCoolingDown(id, now),
    // 止损：已有 live 提案（结论已交用户）或近 2 次都 unknown（飞书查不清）→ 跳过，省配额给新事项。
    (id) => hasLiveMatterProposal(id) || isStuckOnUnknowns(getRecentInvestigationVerdicts(id, 3))
  );
  if (!candidate) return false;

  inFlight = true;
  lastInvestigatedAt.set(candidate.id, now); // 进 in-flight 即占冷却，防重入
  try {
    const matchedPb = matchPlaybookForMatter(candidate);
    const result = await runInvestigation({
      matterTitle: candidate.title,
      matterType: candidate.type,
      currentSummary: candidate.currentSummary,
      nextAction: candidate.nextAction ?? '确认该事项当前进展',
      entities: buildEntities(candidate.id),
      maxRounds: config.investigationMaxRounds,
      priority: config.investigationPriority, // 低频排查公平竞争 gate（默认 true），否则繁忙时被饿死
      playbookHint: matchedPb ? renderPlaybookForPrompt(matchedPb) : undefined,
      projectProfile: (await resolveProjectProfileForMatter(candidate)) ?? undefined,
    });
    const toolSummary = result.toolLog.map((l) => `${l.tool}:${l.ok ? l.summary : '失败'}`).join('；');
    const wb = applyInvestigationResult({ matterId: candidate.id, conclusion: result.conclusion, toolSummary });
    // MVP51：诊断结论吸纳进「问题类聚合」（case→根因类台账，fire-and-forget，过诊断门才落）
    void ingestConclusion({
      matterId: candidate.id,
      spaceId: candidate.primarySpaceId ?? resolveProjectSpaceDeterministic(candidate)?.spaceId ?? null,
      text: result.conclusion.factSummary,
      evidence: result.conclusion.evidence,
      confidence: result.conclusion.confidence,
    })
      .then(() => {
        // MVP55：若本轮 AI 主动办结了该 matter，且它所属问题类的成员都已办结 → 自动标记该类已修复
        if (wb.autoResolved) syncClassStatusForResolvedMatter(candidate.id);
      })
      .catch(() => {});
    // 能力二：把"这次怎么查的"落成操作轨迹（纯采集，供后续蒸馏 playbook）
    try {
      captureInvestigationTrace(candidate, result);
    } catch (err) {
      console.warn('[playbook] capture trace failed:', err instanceof Error ? err.message : String(err));
    }
    console.log(
      `[investigation] 排查 matter=${candidate.id.slice(0, 8)} "${candidate.title.slice(0, 20)}" → ` +
        `${result.conclusion.verdict}(${result.conclusion.confidence.toFixed(2)}) ${result.rounds}轮`
    );
    return true;
  } catch (err) {
    console.warn('[investigation] dispatch tick failed:', err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    inFlight = false;
  }
}

export function startInvestigationDispatcher(): void {
  if (!config.investigationDispatchEnabled) {
    console.log('[investigation] dispatcher 默认关闭（INVESTIGATION_DISPATCH_ENABLED=true 开启）');
    return;
  }
  if (timer) return;
  console.log(`[investigation] dispatcher 启动，每 ${Math.round(config.investigationTickMs / 1000)}s 派发≤1 件`);
  timer = setInterval(() => {
    void runInvestigationDispatchTick();
  }, config.investigationTickMs);
  timer.unref?.();
}

export function stopInvestigationDispatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
