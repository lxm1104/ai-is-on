// MVP32：办结核实（mark_done 第二档）。
//
// 用户点「已处理」后（第一档已确定性落库），延迟 ~5 分钟跑一次 one-shot 核实：
//   confirmed    → matters.resolve_verification_json 盖章，已处理卡片出「✓ 已核实」
//   contradicted → 升「核实存疑」提案卡（proposal:matter-reopen:），用户裁决重开/确实已完成
//   unverifiable → 静默落库（不打扰；可观测、可排查）
//
// 设计约束（与 MVP31 同源）：
// - 用户始终在环：发现反证只产提案，从不直接重开 matter。
// - 保守：证据缺失 ≠ 反证（采集有延迟）；解析失败/低置信一律降级 unverifiable。
// - 晚到的反证不归这里管——matterReducer 对 resolved matter 的自动 reopen 是既有机制。
// - 延迟默认 ≥ IM collector 一轮，让"刚回的消息"先进 events → Reducer → matter_context_links；
//   核实 agent 的新鲜证据全部来自 matter 链接，不自建 events 查询。
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { broadcast } from '../ws.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { getContextUnitById } from '../context/contextStore.js';
import { getAttentionItem, insertAttentionItem } from '../attention/attentionStore.js';
import { projectAttentionItemToCard } from '../attention/attentionProjection.js';
import { resolveAttentionSignalDetails } from '../cards/contextProjection.js';
import {
  getMatterById,
  listMatterContextLinks,
  listMatterTransitions,
  setMatterResolveVerification,
} from './matterStore.js';
import type { Matter, MatterResolveVerification } from './matterTypes.js';
import { MATTER_VERIFY_SYSTEM_PROMPT } from './matterVerifyPrompt.js';

/** 核实存疑提案卡固定 hash 前缀：去重 + projection/action 层识别（对照 MVP31 的 matter-resolve）。 */
export const MATTER_REOPEN_PROPOSAL_PREFIX = 'proposal:matter-reopen:';

const CONFIRMED_GATE = 0.7;
const CONTRADICTED_GATE = 0.75;
const EVIDENCE_UNITS_CAP = 10;
const TRANSITIONS_CAP = 6;
const SIGNALS_CAP = 6;
const RECOVERY_WINDOW_MS = 24 * 3600_000;

export type VerifyVerdict = {
  verdict: 'confirmed' | 'unverifiable' | 'contradicted';
  confidence: number;
  evidence: string;
};

type VerifyRunDeps = {
  runShot: typeof runOneShot;
};

type ScheduleInput = {
  matterId: string;          // 完整 matter id（调用方负责 matchMatterId canonical 化）
  attentionId?: string;      // mark_done 的来源卡（恢复扫描路径没有）
  userNote?: string;
  delayMs?: number;
};

// 进程内 timer 注册表：同 matter 只挂一个；重启即丢，由 startMatterVerifyService 的恢复扫描兜底。
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

export function scheduleMatterResolveVerification(input: ScheduleInput): void {
  if (!config.matterVerifyEnabled) return;
  if (timers.has(input.matterId) || inFlight.has(input.matterId)) return;
  const delay = input.delayMs ?? config.matterVerifyDelayMs;
  const t = setTimeout(() => {
    timers.delete(input.matterId);
    void runMatterResolveVerification(input.matterId, {
      attentionId: input.attentionId,
      userNote: input.userNote,
    }).catch((err) => {
      console.warn(
        '[matter-verify] run failed:',
        err instanceof Error ? err.message : String(err)
      );
    });
  }, delay);
  // 不阻止进程退出（与 collector 定时器同策略）
  t.unref?.();
  timers.set(input.matterId, t);
  console.log(
    `[matter-verify] 已排程 matter=${input.matterId.slice(0, 8)} delay=${Math.round(delay / 1000)}s`
  );
}

export async function runMatterResolveVerification(
  matterId: string,
  opts?: { attentionId?: string; userNote?: string; deps?: Partial<VerifyRunDeps> }
): Promise<MatterResolveVerification | null> {
  if (!config.matterVerifyEnabled) return null;
  if (inFlight.has(matterId)) return null;
  inFlight.add(matterId);
  try {
    // ---- 运行前守卫：全部静默跳过（核实是增强不是义务） ----
    const matter = getMatterById(matterId);
    if (!matter) return null;
    if (matter.status !== 'resolved') {
      console.log(
        `[matter-verify] skip matter=${matterId.slice(0, 8)}：status=${matter.status}（已被重开/撤销）`
      );
      return null;
    }
    if (matter.resolveVerification) return null; // 已核实过

    const userNote = opts?.userNote ?? latestUserResolveNote(matterId);
    const userMsg = buildVerifyInput(matter, userNote, opts?.attentionId);

    const runShot = opts?.deps?.runShot ?? runOneShot;
    const shot = await runShot(userMsg, {
      agentName: 'aiisn-matter-verify',
      timeoutMs: config.matterVerifyTimeoutMs,
    });

    // ---- 判定 + 门槛降级 ----
    const parsed = parseVerifyVerdict(shot.text);
    let final: VerifyVerdict;
    if (!parsed) {
      final = { verdict: 'unverifiable', confidence: 0, evidence: '' };
    } else if (parsed.verdict === 'confirmed' && parsed.confidence >= CONFIRMED_GATE) {
      final = parsed;
    } else if (
      parsed.verdict === 'contradicted' &&
      parsed.confidence >= CONTRADICTED_GATE &&
      parsed.evidence.trim()
    ) {
      final = parsed;
    } else {
      // 不到门槛 / contradicted 无证据 → 降级；保留原 confidence/evidence 便于排查
      final = { ...parsed, verdict: 'unverifiable' };
    }

    // 核实期间用户可能撤销/Reducer 可能重开——写入前重读一次，非 resolved 不落章。
    const fresh = getMatterById(matterId);
    if (!fresh || fresh.status !== 'resolved') {
      console.log(`[matter-verify] discard matter=${matterId.slice(0, 8)}：核实期间状态已变化`);
      return null;
    }

    const record: MatterResolveVerification = {
      verdict: final.verdict,
      confidence: final.confidence,
      evidence: final.evidence.slice(0, 300),
      checkedAt: new Date().toISOString(),
      userNote,
    };
    setMatterResolveVerification(matterId, record);
    broadcast({ type: 'matter_updated', matterId });
    console.log(
      `[matter-verify] matter=${matterId.slice(0, 8)} verdict=${record.verdict} conf=${record.confidence}`
    );

    if (record.verdict === 'contradicted') {
      insertReopenProposal(matter, record);
    }

    // 「✓ 已核实」即时上卡：重投影来源卡（done 卡不在 GET /cards 的 live 列表里，靠 WS 更新）。
    if (opts?.attentionId) {
      const item = getAttentionItem(opts.attentionId);
      if (item) {
        broadcast({ type: 'card_updated', card: projectAttentionItemToCard(item) });
      }
    }

    return record;
  } finally {
    inFlight.delete(matterId);
  }
}

/** 升「核实存疑」提案卡。幂等：同事项已有在场提案则跳过（同 MVP31）。 */
function insertReopenProposal(matter: Matter, record: MatterResolveVerification): void {
  const proposalHash = `${MATTER_REOPEN_PROPOSAL_PREFIX}${matter.id}`;
  const existing = db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(proposalHash);
  if (existing) return;

  const now = new Date().toISOString();
  insertAttentionItem({
    id: randomUUID(),
    generation: 0, // 系统提案不参与 LLM 代际
    llmRunId: null,
    inputHash: proposalHash,
    llmItem: {
      priority: 'P1',
      title: `核实存疑：${matter.title.slice(0, 40)}`,
      why:
        `你已标记该事项已处理，但核实发现：${record.evidence.slice(0, 120)}。` +
        '请确认是否重新打开跟进。',
      suggestedAction: '重新打开，或确认确实已完成',
      signalIds: [],
      matterId: matter.id,
    },
    now,
  });
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
  console.log(
    `[matter-verify] 升核实存疑提案：matter=${matter.id.slice(0, 8)}「${matter.title.slice(0, 24)}」`
  );
}

function buildVerifyInput(matter: Matter, userNote?: string, attentionId?: string): string {
  const parts: string[] = [
    '【事项】',
    `标题：${matter.title}`,
    `状态：${matter.status}（resolvedAt=${matter.resolvedAt ?? '—'}）`,
    matter.currentSummary ? `当前摘要：${matter.currentSummary}` : '',
    matter.nextAction ? `此前记录的下一步：${matter.nextAction}` : '',
    '',
    '【用户声明】',
    `用户已于 ${matter.resolvedAt ?? '刚才'} 标记该事项已处理。处理说明：${userNote ?? '（未填写）'}`,
  ];

  // 事项最近证据：matter_context_links 上挂的 units（Reducer 持续更新，含 mark_done 之后采到的新证据）。
  // 排除 mark_done 自己写入的处理说明 unit（relation=resolved_by 且 origin=card_action）——防循环自证。
  const links = listMatterContextLinks(matter.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, EVIDENCE_UNITS_CAP * 2); // unit 可能已过期取不到，多取一倍再裁
  const evidenceLines: string[] = [];
  for (const link of links) {
    if (evidenceLines.length >= EVIDENCE_UNITS_CAP) break;
    const unit = getContextUnitById(link.contextUnitId);
    if (!unit) continue;
    if (link.relation === 'resolved_by' && unit.origin.kind === 'card_action') continue;
    const t = unit.time?.occurredAt ?? unit.updatedAt;
    evidenceLines.push(
      `- [${t}] (${unit.kind}/${link.relation}) ${unit.title} — ${unit.content.slice(0, 200)}`
    );
  }
  if (evidenceLines.length) {
    parts.push('', '【事项最近证据】', ...evidenceLines);
  }

  const transitions = listMatterTransitions(matter.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, TRANSITIONS_CAP);
  if (transitions.length) {
    parts.push(
      '',
      '【状态轨迹（新→旧）】',
      ...transitions.map(
        (t) => `- ${t.fromStatus ?? '∅'} → ${t.toStatus}：${t.reason.slice(0, 80)}`
      )
    );
  }

  // 提醒卡原始信号（生成时冻结的 signalIds；恢复扫描路径没有来源卡则省略）。
  if (attentionId) {
    const item = getAttentionItem(attentionId);
    if (item?.signalIds.length) {
      const details = resolveAttentionSignalDetails(item.signalIds.slice(0, SIGNALS_CAP));
      const lines = details
        .filter((d) => d.title)
        .map((d) => `- ${d.title}${d.excerpt ? ` — ${d.excerpt.slice(0, 160)}` : ''}`);
      if (lines.length) parts.push('', '【提醒卡原始信号】', ...lines);
    }
  }

  parts.push('', '任务：判断现有证据是否支持"该事项已完成"，按系统约定输出单个 JSON。');
  return parts.filter((p) => p !== null && p !== undefined && p !== '').join('\n').replace(/\n{3,}/g, '\n\n');
}

/** mark_done 落库的 transition reason 形如「用户标记已处理：<note>」；恢复扫描路径从这里反解 note。 */
function latestUserResolveNote(matterId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT reason FROM matter_transitions
        WHERE matter_id = ? AND to_status = 'resolved' AND trigger_context_unit_id = 'user_action'
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(matterId) as { reason: string } | undefined;
  if (!row) return undefined;
  const m = row.reason.match(/^用户标记已处理：(.+)$/s);
  return m ? m[1] : undefined;
}

/** 导出仅为单测。 */
export function parseVerifyVerdict(text: string): VerifyVerdict | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const obj = JSON.parse(text.slice(s, e + 1)) as Partial<VerifyVerdict>;
    if (
      (obj.verdict === 'confirmed' ||
        obj.verdict === 'unverifiable' ||
        obj.verdict === 'contradicted') &&
      typeof obj.confidence === 'number'
    ) {
      return {
        verdict: obj.verdict,
        confidence: obj.confidence,
        evidence: typeof obj.evidence === 'string' ? obj.evidence : '',
      };
    }
  } catch {
    // fallthrough
  }
  return null;
}

let started = false;

/**
 * 启动恢复扫描：timer 不持久化，重启会丢——把 24h 窗口内"用户 resolve 且尚无核实结果"的
 * matter 重新排程（10–60s 抖动摊平启动峰值）。窗口外不补（核实是增强不是义务）。
 */
export function startMatterVerifyService(): void {
  if (started) return;
  started = true;
  if (!config.matterVerifyEnabled) {
    console.log('[matter-verify] 已禁用（MATTER_VERIFY_ENABLED=false）');
    return;
  }
  const cutoffIso = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT m.id FROM matters m
        WHERE m.status = 'resolved' AND m.resolve_verification_json IS NULL
          AND EXISTS (SELECT 1 FROM matter_transitions t
                       WHERE t.matter_id = m.id AND t.to_status = 'resolved'
                         AND t.trigger_context_unit_id = 'user_action'
                         AND t.created_at > ?)`
    )
    .all(cutoffIso) as Array<{ id: string }>;
  for (const r of rows) {
    scheduleMatterResolveVerification({
      matterId: r.id,
      delayMs: 10_000 + Math.floor(Math.random() * 50_000),
    });
  }
  console.log(`[matter-verify] MVP32 核实服务已启动；恢复扫描补排 ${rows.length} 个事项`);
}

/** 测试/关停对称 API：清掉未触发的 timer。 */
export function stopMatterVerifyService(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  started = false;
}
