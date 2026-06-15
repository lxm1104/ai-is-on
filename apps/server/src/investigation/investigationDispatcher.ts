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
import { getContextEntityById } from '../db.js';
import { listMatters, listMatterEntities } from '../matter/matterStore.js';
import type { Matter } from '../matter/matterTypes.js';
import { runInvestigation } from './investigationLoop.js';
import { applyInvestigationResult } from './investigationWriteback.js';
import { captureInvestigationTrace } from '../playbook/playbookCapture.js';

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
const WORTHY_RE = /(是否|核实|排查(进展|结果)?|查清|查证|确认.*(进展|完成|收到|发|回复)|跟进.*(进展|结果|排查))/;

/** 这条 nextAction 值不值得自动排查（纯函数）。 */
export function isInvestigationWorthy(nextAction: string | null | undefined): boolean {
  const na = (nextAction ?? '').trim();
  if (na.length < 6) return false; // 极短的（"开会"）不查；具体查证动作由下方 regex 把关
  if (GENERIC_NEXT_ACTIONS.has(na)) return false;
  return WORTHY_RE.test(na);
}

const PRIO_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * 从候选 matter 里挑最该查的一件（纯函数）：worthy + 不在冷却 → 按 优先级↑ 再 最久未动↑ 排，取 top-1。
 * @param isCoolingDown 给定 matterId 是否在冷却期内
 */
export function selectInvestigationCandidate(
  matters: Matter[],
  isCoolingDown: (matterId: string) => boolean
): Matter | null {
  const pool = matters.filter(
    (m) =>
      (m.status === 'open' || m.status === 'in_progress') &&
      isInvestigationWorthy(m.nextAction) &&
      !isCoolingDown(m.id)
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
    (id) => isCoolingDown(id, now)
  );
  if (!candidate) return false;

  inFlight = true;
  lastInvestigatedAt.set(candidate.id, now); // 进 in-flight 即占冷却，防重入
  try {
    const result = await runInvestigation({
      matterTitle: candidate.title,
      matterType: candidate.type,
      currentSummary: candidate.currentSummary,
      nextAction: candidate.nextAction ?? '确认该事项当前进展',
      entities: buildEntities(candidate.id),
      maxRounds: config.investigationMaxRounds,
      priority: false, // 让位 attention
    });
    const toolSummary = result.toolLog.map((l) => `${l.tool}:${l.ok ? l.summary : '失败'}`).join('；');
    applyInvestigationResult({ matterId: candidate.id, conclusion: result.conclusion, toolSummary });
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
