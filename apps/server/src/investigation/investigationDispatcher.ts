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
import { getContextEntityById, hasLiveMatterProposal, getRecentInvestigationVerdicts, getLastInvestigatedAt, hasNewExternalEvidenceSince, listUserBackfillUnitsForMatter, getMatterOriginHint, listKnownCodeRepos } from '../db.js';
import { listMatters, listMatterEntities } from '../matter/matterStore.js';
import type { Matter } from '../matter/matterTypes.js';
import { runInvestigation } from './investigationLoop.js';
import { applyInvestigationResult, scanDanglingCommitments } from './investigationWriteback.js';
import { captureInvestigationTrace } from '../playbook/playbookCapture.js';
import { matchPlaybookForMatter, renderPlaybookForPrompt } from '../playbook/playbookMatcher.js';
import { resolveProjectProfileForMatter } from './projectProfile.js';
import { resolveProjectSpaceDeterministic } from './projectRouter.js';
import { ingestConclusion, syncClassStatusForResolvedMatter, getProblemClassHintForMatter } from '../problemClass/problemClassService.js';
import { classCompletionImpactOfResolving } from '../problemClass/problemClassStore.js';
import { onInvestigationKick } from './investigationKick.js';
import { maybeAlertReadToolHealth } from './readToolHealth.js';

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

// MVP64 ⑥：决策类事项——「该拍但还没拍/信息不全」时值得自主去 IM/文档拉齐各方立场+约束+缺口，
// 产出"决策信息包"待用户拍板。仅在有**未决信号**时放行（已拍板的决策不反复查，避免挤占单并发 gate）。
const DECISION_OPEN_RE = /待定|未决|没定|定不下来|拍不了板|待拍板|未拍板|分歧|各方意见|选型|要不要|是否要|怎么定|方案[^。]{0,6}(待|未定|没定|不确定)/;
/** 待拍板且信息不全的决策类 matter → 值得自主拉齐决策信息包。纯函数。 */
export function isOpenDecision(input: { type?: string; title?: string; currentSummary?: string | null }): boolean {
  if (input.type !== 'decision') return false;
  return DECISION_OPEN_RE.test(`${input.title ?? ''} ${input.currentSummary ?? ''}`);
}

// MVP57/58：自主排查"优先挑"的关键词由 config 给（用户可改，定义"哪类先查"）；P0 仍绝对最先。
const PRIORITY_KW_RE = new RegExp(
  config.investigationPriorityKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|') || '(?!)',
  'i'
);
/** 是不是"优先排查类"事项（带凭据的 badcase、或标题命中用户配置的优先关键词）。纯函数，用于排序前置。 */
export function isBadcaseMatter(input: { title?: string; currentSummary?: string | null }): boolean {
  return hasResolvableBadcase(input) || PRIORITY_KW_RE.test(input.title ?? '');
}

/**
 * 这件事值不值得自动排查（纯函数）。看 标题 + 下一步 + 摘要：
 * - nextAction 具体（非泛兜底）且命中查证词 → worthy；
 * - 或标题本身命中查证词（如"排查宁波力劲…"）→ worthy；
 * - 或（MVP52）代码/系统类 badcase 且带可解析凭据（日志ID/traceID）→ worthy（交给 run_command 追）。
 */
export function isInvestigationWorthy(input: { title?: string; nextAction?: string | null; currentSummary?: string | null; type?: string }): boolean {
  const na = (input.nextAction ?? '').trim();
  const ti = (input.title ?? '').trim();
  const naWorthy = na.length >= 6 && !GENERIC_NEXT_ACTIONS.has(na) && WORTHY_RE.test(na);
  const tiWorthy = ti.length >= 4 && WORTHY_RE.test(ti);
  return (
    naWorthy ||
    tiWorthy ||
    hasResolvableBadcase({ title: input.title, currentSummary: input.currentSummary }) ||
    isOpenDecision({ type: input.type, title: input.title, currentSummary: input.currentSummary })
  );
}

const PRIO_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * 止损（纯函数）：近 N(默认2) 次排查都是**真** unknown → 飞书查不清，退避不再空查。
 * 只数 confidence>0 的真 unknown：conf=0 是排查器空转/工具报错的退化哨兵（瞬时失败），
 * 不能算进永久放弃（实测 2 个 matter 因两次 conf0 退化被误背刺、从没真查过 → MVP45）。
 */
// MVP66：死胡同集合——unknown(查不清) 与 blocked(查到但解不了) 同属"重查也不会有产出"。
// 旧 isStuckOnUnknowns 只数 unknown，被 blocked/progressed 打断连续计数 → 振荡 matter 永不止损
// （实测 48a55ea3：7 unknown + 3 blocked 交替，被排查 10 次从未 resolved）。
const DEAD_END_VERDICTS = new Set(['unknown', 'blocked']);
export function isStuckDeadEnd(
  recent: Array<{ verdict: string; confidence: number }>,
  n = 2
): boolean {
  const genuine = recent.filter((r) => !(r.verdict === 'unknown' && r.confidence <= 0));
  if (genuine.length < n) return false;
  return genuine.slice(0, n).every((r) => DEAD_END_VERDICTS.has(r.verdict));
}
/** 兼容别名（既有单测/调用按旧名引用）。 */
export const isStuckOnUnknowns = isStuckDeadEnd;

/**
 * MVP66 信噪比主力门（纯函数，deps 注入，零 I/O）：上次排查后**无新外部证据 → 不重查**。
 * 实测元凶是「对同一份没变过的证据反复空查」（13 个 matter 占 88% 排查量，bb858dee 一天查 8 次全 unknown）。
 *  - lastInvestigatedAt===null（从没真查过）→ 放行首查，绝不误伤。
 *  - 查过且此后无新外部证据 → 跳过（把稀缺单并发 gate 让给新鲜/有进展的事项）。
 * "新外部证据"判定见 db.hasNewExternalEvidenceSince（排自产、看 updated_at|mcl.created_at）。
 */
export function shouldSkipNoNewEvidence(
  lastInvestigatedAt: string | null,
  hasNewSince: (sinceIso: string) => boolean
): boolean {
  if (lastInvestigatedAt === null) return false;
  return !hasNewSince(lastInvestigatedAt);
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
      isInvestigationWorthy({ title: m.title, nextAction: m.nextAction, currentSummary: m.currentSummary, type: m.type }) &&
      !isCoolingDown(m.id) &&
      !shouldSkip(m.id)
  );
  if (pool.length === 0) return null;
  pool.sort((a, b) => {
    // ① P0 绝对最先（高风险/到期事项不让位）
    const aP0 = a.priority === 'P0' ? 0 : 1;
    const bP0 = b.priority === 'P0' ? 0 : 1;
    if (aP0 !== bP0) return aP0 - bP0;
    // ② MVP57：badcase / 排查类优先（用户的核心工作；有限排查吞吐先用在它们上）
    const aBad = isBadcaseMatter(a) ? 0 : 1;
    const bBad = isBadcaseMatter(b) ? 0 : 1;
    if (aBad !== bBad) return aBad - bBad;
    // ③ 再按优先级、最久未动
    const pr = (PRIO_RANK[a.priority] ?? 3) - (PRIO_RANK[b.priority] ?? 3);
    if (pr !== 0) return pr;
    return (a.updatedAt || '').localeCompare(b.updatedAt || '');
  });
  return pool[0];
}

// ---- 调度（薄）----

const lastInvestigatedAt = new Map<string, number>();
let inFlight = false;
// MVP69 P1：当前正在排查哪件事（透明度——让用户看到"AI 此刻在查什么"）。单并发，故至多一件。
let currentInvestigation: { matterId: string; title: string; startedAt: string } | null = null;
/** 当前在飞的排查（无则 null）。带 startedAt 陈旧兜底由读取侧做（崩溃/重启会留陈旧值）。 */
export function getCurrentInvestigation(): { matterId: string; title: string; startedAt: string } | null {
  return currentInvestigation;
}
let timer: ReturnType<typeof setInterval> | null = null;

// MVP65：unknown 退避——刚查回「真实 unknown」的事项很可能仍查不清，把冷却拉长（默认 4×），
// 让稀缺单并发 gate 的吞吐优先给新鲜/有意义的事项。实测 98 次排查里 55% 是 unknown（浪费）。
// 不动 worthiness、不动 2-strikes 止损：最坏退化回原冷却，是严格改进。纯函数，导出供测。
export const UNKNOWN_COOLDOWN_MULT = 4;
export function effectiveCooldownMs(
  recent: Array<{ verdict: string; confidence: number }>,
  baseMs: number
): number {
  // 最近一次"真实"结论（排除 conf=0 退化哨兵：排查器空转/工具报错，不代表查不清）
  // MVP66：unknown 与 blocked 同属死胡同 → 都拉长冷却（不止 unknown）。
  const genuine = recent.find((r) => !(r.verdict === 'unknown' && r.confidence <= 0));
  return genuine && DEAD_END_VERDICTS.has(genuine.verdict) ? baseMs * UNKNOWN_COOLDOWN_MULT : baseMs;
}

function isCoolingDown(matterId: string, now: number): boolean {
  // MVP66 重启安全：内存 Map 重启即丢（实测 bb858dee 攻击间隔小到 19min ≪ 6h，多次重启即绕过冷却）。
  // 回落到 audit_logs 派生的持久时刻（取内存与持久的较晚者）。
  const memLast = lastInvestigatedAt.get(matterId);
  const persistedLast = Date.parse(getLastInvestigatedAt(matterId) ?? '') || 0;
  const last = Math.max(memLast ?? 0, persistedLast);
  if (last <= 0) return false;
  // MVP66：新外部证据优先于冷却——真有新进展的 matter 不被 ×4 退避压住最多 24h（对抗审查 P1）。
  if (hasNewExternalEvidenceSince(matterId, new Date(last).toISOString())) return false;
  const cd = effectiveCooldownMs(getRecentInvestigationVerdicts(matterId, 3), config.investigationCooldownMs);
  return now - last < cd;
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
  // MVP71 §11.1：dangling 静态扫描——确定性、零 LLM、零 gate。让"被正确停查的存量自我承诺"浮成「待你处理」卡
  // （writeback 路径只在新鲜 unknown 时触发、catch 不到这些停查存量）。每 tick 一次，幂等+合并配额兜噪。
  try {
    scanDanglingCommitments();
  } catch (err) {
    console.warn('[dangling-scan] failed:', err instanceof Error ? err.message : String(err));
  }
  const candidate = selectInvestigationCandidate(
    listMatters({ statuses: ['open', 'in_progress'], limit: 200 }),
    (id) => isCoolingDown(id, now),
    // 止损（省配额给新事项）：已有 live 提案（结论已交用户）｜近 2 次都死胡同（查不清/解不了）
    // ｜MVP66 上次排查后无新外部证据（对同一份没变的证据反复空查，实测 88% 浪费的元凶）。
    // MVP69：死胡同退避也要给**新证据逃生门**——否则用户补一手后，isStuckDeadEnd 仍 true 会把它挡死，
    // 「你补了 AI 接着查」的闭环在 55% unknown 主力场景下不转（与 isCoolingDown 侧的逃生门对称）。
    (id) =>
      hasLiveMatterProposal(id) ||
      (isStuckDeadEnd(getRecentInvestigationVerdicts(id, 3)) &&
        !hasNewExternalEvidenceSince(id, getLastInvestigatedAt(id) ?? '')) ||
      shouldSkipNoNewEvidence(getLastInvestigatedAt(id), (since) => hasNewExternalEvidenceSince(id, since))
  );
  if (!candidate) return false;

  inFlight = true;
  currentInvestigation = { matterId: candidate.id, title: candidate.title, startedAt: new Date(now).toISOString() };
  lastInvestigatedAt.set(candidate.id, now); // 进 in-flight 即占冷却，防重入
  try {
    const matchedPb = matchPlaybookForMatter(candidate);
    // MVP80「学习照做也是结果」：记住本次排查带没带你教的做法/你补的信息——结论落 audit 时归因，工作日志可见。
    const userBackfills = listUserBackfillUnitsForMatter(candidate.id, 5).map((u) => u.content);
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
      // MVP71 KEYSTONE：把用户经求助卡补给该 matter 的内容喂回重查——闭环从"只解封不喂内容"的假闭环变真闭环。
      userBackfills,
      // 追查链路：这件事最初出现在哪（源头对话/文档）——让排查第一步先回源头看进展。
      originHint: getMatterOriginHint(candidate.id) ?? undefined,
      // 追查链路：已知业务代码库路径——即便本 matter 没路由到项目 space，也让它 git log 去对的仓查提交。
      knownCodeRepos: listKnownCodeRepos(),
      // 追查链路：所属问题类的已知根因 + 已解决兄弟事项——系统早已归纳的现成线索，先看这些别从零重推。
      problemClassHint: getProblemClassHintForMatter(candidate.id) ?? undefined,
    });
    const toolSummary = result.toolLog.map((l) => `${l.tool}:${l.ok ? l.summary : '失败'}`).join('；');
    // MVP69 P0-5：把"派发起始时刻"透传给 writeback 写进 audit payload.startedAt，
    // 让 getLastInvestigatedAt 的 since 用排查**起始**而非结束——覆盖 in-flight 期到达的回填/新证据。
    const wb = applyInvestigationResult({
      matterId: candidate.id,
      conclusion: result.conclusion,
      toolSummary,
      startedAt: new Date(now).toISOString(),
      // MVP80 归因：结论若产出结果（办结/方案/建议），audit 标注"按你教的做法/用了你补的信息"——学习照做也是结果。
      followedYourPlaybook: !!matchedPb,
      usedYourBackfill: userBackfills.length > 0,
    });
    // MVP51：诊断结论吸纳进「问题类聚合」（case→根因类台账，fire-and-forget，过诊断门才落）
    void ingestConclusion({
      matterId: candidate.id,
      spaceId: candidate.primarySpaceId ?? resolveProjectSpaceDeterministic(candidate)?.spaceId ?? null,
      text: result.conclusion.factSummary,
      evidence: result.conclusion.evidence,
      confidence: result.conclusion.confidence,
    })
      .then(() => {
        // MVP55：若本轮 AI 主动办结了该 matter，且它所属问题类的成员都已办结 → 自动标记该类已修复。
        // 审查 P1-4：闭合 TOCTOU——cascade 跑在 async 段，若此刻并发的兄弟办结让"这次翻牌"变成完成一个**多成员**类
        //（含他人成员），不自动翻（与 auto-resolve 级联护栏同策略，留人确认），避免绕过护栏静默翻整类。
        if (wb.autoResolved && !classCompletionImpactOfResolving(candidate.id).willComplete) {
          syncClassStatusForResolvedMatter(candidate.id);
        }
      })
      .catch(() => {});
    // 能力二：把"这次怎么查的"落成操作轨迹（纯采集，供后续蒸馏 playbook）
    try {
      captureInvestigationTrace(candidate, result);
    } catch (err) {
      console.warn('[playbook] capture trace failed:', err instanceof Error ? err.message : String(err));
    }
    // MVP70：感官健康自检——近期飞书读取几乎全空（搜真实词却 0 命中，统计上不正常）→ 升一张去重系统提醒。
    try {
      maybeAlertReadToolHealth();
    } catch (err) {
      console.warn('[health] read-tool health check failed:', err instanceof Error ? err.message : String(err));
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
    currentInvestigation = null;
  }
}

// MVP58：事件驱动——新可排查事项一到就近实时派发（去抖合并突发；派完若还有候选则继续 drain）。
let kickTimer: ReturnType<typeof setTimeout> | null = null;
export function requestInvestigationSoon(delayMs = config.investigationKickDebounceMs): void {
  if (!config.investigationDispatchEnabled) return;
  if (inFlight || kickTimer) return; // 已在飞行 / 已排了一次 → 不叠（去抖）
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void runInvestigationDispatchTick()
      .then((did) => {
        if (did) requestInvestigationSoon(1_500); // 刚查完一件、还有候选 → 继续排干（单并发，逐件）
      })
      .catch(() => {});
  }, delayMs);
  kickTimer.unref?.();
}

export function startInvestigationDispatcher(): void {
  if (!config.investigationDispatchEnabled) {
    console.log('[investigation] dispatcher 默认关闭（INVESTIGATION_DISPATCH_ENABLED=true 开启）');
    return;
  }
  // 订阅"该排查了"信号：matterReducer 等新建可排查事项时 kickInvestigation() → 这里立刻派发。
  onInvestigationKick(() => requestInvestigationSoon());
  if (timer) return;
  console.log(`[investigation] dispatcher 启动，每 ${Math.round(config.investigationTickMs / 1000)}s 兜底派发 + 新事项即时 kick`);
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
  if (kickTimer) {
    clearTimeout(kickTimer);
    kickTimer = null;
  }
}
