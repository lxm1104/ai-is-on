/**
 * MVP78 —— 积压大扫除：AI 甄别陈旧事项，你在飞书回一句「确认清理」批量办结。
 *
 * 取证（2026-07-03）：open 事项积压 234 件，其中 47 件 ≥14 天没有任何新证据；抽样发现大量
 * 标题本身就写着完成态（"日志已上传/审批已通过/直播定档6月23日"）或围绕早已过去的时间点——
 * 它们不是垃圾（不能盲目 drop），也不该逐件打扰用户（47 张确认卡=轰炸）。
 *
 * 设计：AI 做 100% 的甄别工作 → 一条飞书清单 → 用户一句话批量确认。
 * - 甄别是**建议**不是执行：绝不自动办结（守「误判已完成」信任红线）；拿不准一律 still_pending 不进清单。
 * - 用户回「确认清理」→ likely_done/event_passed 走 userResolveMatter、obsolete 走 userDropMatter；
 *   「保留 2 5」挑着留；「忽略」放弃本批；误清可「恢复 <关键词>」（7 天内可找回）。
 * - 每天至多扫一次；有未决清单时不叠加新批。
 */
import { randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import { config } from '../config.js';
import { writeAudit } from '../boundary/auditLog.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { sendBotDm } from '../lark/larkNotifyService.js';
import {
  getMatterOriginUrl,
  getSetting,
  listRecentlySweptMatters,
  listStaleOpenMatters,
  setSetting,
  type StaleMatterRow,
} from '../db.js';
import { getMatterById } from './matterStore.js';
import { userDropMatter, userReopenMatter, userResolveMatter } from './matterActions.js';

export type SweepVerdict = 'likely_done' | 'event_passed' | 'obsolete' | 'still_pending';

export type SweepBatchItem = {
  matterId: string;
  title: string;
  verdict: Exclude<SweepVerdict, 'still_pending'>;
  because: string;
};

export type SweepBatch = {
  id: string;
  createdAt: string;
  scanned: number;
  items: SweepBatchItem[];
};

const PENDING_BATCH_KEY = 'sweep:pendingBatch';
const LAST_RUN_KEY = 'sweep:lastRunDate';
const BATCH_TTL_MS = 3 * 86_400_000; // 清单超 3 天作废：事项状态可能已变，重扫再确认

const VERDICT_LABEL: Record<Exclude<SweepVerdict, 'still_pending'>, string> = {
  likely_done: '疑似已完成',
  event_passed: '时间点已过',
  obsolete: '疑似不再相关',
};

function localDateStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function clip(s: string, n: number): string {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function getPendingSweepBatch(now = new Date()): SweepBatch | null {
  const raw = getSetting(PENDING_BATCH_KEY);
  if (!raw) return null;
  try {
    const batch = JSON.parse(raw) as SweepBatch;
    if (!batch?.id || !Array.isArray(batch.items)) return null;
    if (now.getTime() - Date.parse(batch.createdAt) > BATCH_TTL_MS) return null; // 过期视同不存在
    return batch;
  } catch {
    return null;
  }
}

function buildSweepPrompt(rows: StaleMatterRow[], now: Date): string {
  const lines = rows.map((r, i) => {
    const parts = [
      `[${i + 1}] (${r.priority}/${r.type}/停滞${r.staleDays}天) ${clip(r.title, 60)}`,
      r.currentSummary ? `  摘要: ${clip(r.currentSummary, 140)}` : '',
      r.nextAction ? `  原定下一步: ${clip(r.nextAction, 50)}` : '',
    ].filter(Boolean);
    return parts.join('\n');
  });
  return [
    `今天是 ${localDateStr(now)}。以下 ${rows.length} 件工作事项已停滞 ≥${config.sweepStaleDays} 天（无任何新证据）。`,
    `请仅凭给出的信息逐件判断：`,
    ``,
    lines.join('\n'),
  ].join('\n');
}

function parseSweepVerdicts(text: string, count: number): Array<{ i: number; verdict: SweepVerdict; because: string }> {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  const slice = text.slice(start, end + 1);
  try {
    arr = JSON.parse(slice);
  } catch {
    try {
      arr = JSON.parse(jsonrepair(slice));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const valid: SweepVerdict[] = ['likely_done', 'event_passed', 'obsolete', 'still_pending'];
  const out: Array<{ i: number; verdict: SweepVerdict; because: string }> = [];
  for (const item of arr) {
    const o = item as { i?: unknown; verdict?: unknown; because?: unknown };
    const i = Number(o?.i);
    if (!Number.isInteger(i) || i < 1 || i > count) continue;
    const verdict = valid.includes(o?.verdict as SweepVerdict) ? (o.verdict as SweepVerdict) : 'still_pending';
    const because = typeof o?.because === 'string' ? o.because.trim() : '';
    out.push({ i, verdict, because });
  }
  return out;
}

export function composeSweepListMessage(batch: SweepBatch): string {
  const lines: string[] = [
    `**🧹 积压大扫除**（扫描 ${batch.scanned} 件停滞 ≥${config.sweepStaleDays} 天的事项，其余仍会继续跟进）`,
    ``,
    `这 ${batch.items.length} 件看起来可以清了：`,
  ];
  batch.items.forEach((it, idx) => {
    // 带上源头深链：确认清不清之前，一点直达原会话/原文档核实现状
    const u = getMatterOriginUrl(it.matterId);
    lines.push(
      `${idx + 1}. [${VERDICT_LABEL[it.verdict]}] ${clip(it.title, 44)}${it.because ? `——${clip(it.because, 60)}` : ''}${u ? ` [直达](${u})` : ''}`
    );
  });
  lines.push(
    ``,
    `回复「确认清理」一键全部办结/归档；「保留 2 5」留下这几件清其余；「忽略」放弃本次。`,
    `不回复不会自动清。误清 7 天内可回复「恢复 <标题关键词>」找回。`
  );
  return lines.join('\n');
}

export type SweepRunOutcome =
  | 'sent'
  | 'empty'
  | 'nothing_cleanable'
  | 'pending_exists'
  | 'disabled'
  | 'failed';

type OneShotFn = (
  userMessage: string,
  opts: { agentName: 'aiisn-backlog-sweep'; timeoutMs?: number }
) => Promise<{ text: string }>;

/** 跑一轮大扫除：候选 → LLM 甄别 → 存 pending 批次 → 飞书清单 DM。绝不直接改任何 matter。 */
export async function runBacklogSweep(
  now = new Date(),
  deps: { oneShot?: OneShotFn } = {}
): Promise<SweepRunOutcome> {
  if (!config.sweepEnabled) return 'disabled';
  if (getPendingSweepBatch(now)) return 'pending_exists'; // 上批还没答复，不叠加
  const rows = listStaleOpenMatters(config.sweepStaleDays, config.sweepBatchMax);
  if (rows.length === 0) return 'empty';
  const oneShot = deps.oneShot ?? ((msg, opts) => runOneShot(msg, opts));
  let text: string;
  try {
    const shot = await oneShot(buildSweepPrompt(rows, now), {
      agentName: 'aiisn-backlog-sweep',
      timeoutMs: 240_000,
    });
    text = shot.text;
  } catch (err) {
    console.warn('[sweep] LLM 甄别失败：', err instanceof Error ? err.message : String(err));
    return 'failed';
  }
  const verdicts = parseSweepVerdicts(text, rows.length);
  const cleanable: SweepBatchItem[] = [];
  for (const v of verdicts) {
    if (v.verdict === 'still_pending') continue;
    const row = rows[v.i - 1];
    if (!row) continue;
    if (cleanable.some((c) => c.matterId === row.id)) continue; // 同项重复判定只取首个
    cleanable.push({ matterId: row.id, title: row.title, verdict: v.verdict, because: v.because });
  }
  if (cleanable.length === 0) {
    writeAudit({
      action: 'backlog_sweep_proposed',
      reason: `大扫除扫描 ${rows.length} 件，无可清项（全部仍需跟进）`,
      payload: { scanned: rows.length, cleanable: 0 },
    });
    return 'nothing_cleanable';
  }
  const batch: SweepBatch = {
    id: randomUUID().slice(0, 8),
    createdAt: now.toISOString(),
    scanned: rows.length,
    items: cleanable,
  };
  setSetting(PENDING_BATCH_KEY, JSON.stringify(batch));
  writeAudit({
    action: 'backlog_sweep_proposed',
    reason: `大扫除甄别出 ${cleanable.length}/${rows.length} 件可清事项，清单已发飞书待确认`,
    payload: { batchId: batch.id, scanned: rows.length, cleanable: cleanable.length },
  });
  const ok = await sendBotDm(composeSweepListMessage(batch), {
    kind: 'sweep_list',
    refId: batch.id,
    idempotencyKey: `aiisn:sweep_list:${batch.id}`,
  });
  return ok ? 'sent' : 'failed';
}

export type SweepApplyResult = { ok: boolean; message: string };

/**
 * 应用未决清单（用户在飞书确认后调用）。keepIndices 为 1-based 序号（对应清单里的编号），留下的不动。
 * 每件应用前重查 matter 现状（已办结/归档的跳过），绝不重复翻状态。
 */
export function applyPendingSweepBatch(
  keepIndices: number[] = [],
  now = new Date()
): SweepApplyResult {
  const batch = getPendingSweepBatch(now);
  if (!batch) {
    return { ok: false, message: '现在没有待确认的清理清单（可能已处理或已过期）。' };
  }
  const keep = new Set(keepIndices);
  let resolved = 0;
  let dropped = 0;
  let skipped = 0;
  const keptTitles: string[] = [];
  batch.items.forEach((it, idx) => {
    const no = idx + 1;
    if (keep.has(no)) {
      keptTitles.push(it.title);
      return;
    }
    const m = getMatterById(it.matterId);
    if (!m || m.status === 'resolved' || m.status === 'dropped') {
      skipped += 1;
      return;
    }
    const because = it.because ? `：${clip(it.because, 80)}` : '';
    if (it.verdict === 'obsolete') {
      const r = userDropMatter(it.matterId, `批量清理（你在飞书确认，不再跟进）${because}`, now.toISOString());
      if (r) dropped += 1;
      else skipped += 1;
    } else {
      const r = userResolveMatter(it.matterId, `批量清理（你在飞书确认）${because}`, now.toISOString());
      if (r) resolved += 1;
      else skipped += 1;
    }
    writeAudit({
      action: 'backlog_swept',
      reason: `批量清理：${clip(it.title, 60)}（${VERDICT_LABEL[it.verdict]}）`,
      payload: { matterId: it.matterId, verdict: it.verdict, batchId: batch.id },
    });
  });
  setSetting(PENDING_BATCH_KEY, '');
  const parts = [`✅ 已清理 ${resolved + dropped} 件（办结 ${resolved}、归档 ${dropped}）`];
  if (keptTitles.length) parts.push(`保留 ${keptTitles.length} 件继续跟进`);
  if (skipped) parts.push(`${skipped} 件状态已变化自动跳过`);
  parts.push(`误清 7 天内可回复「恢复 <标题关键词>」找回。`);
  return { ok: true, message: parts.join('，') };
}

/** 用户回「忽略」：放弃本批清单（事项全部保持原状）。 */
export function ignorePendingSweepBatch(now = new Date()): SweepApplyResult {
  const batch = getPendingSweepBatch(now);
  if (!batch) return { ok: false, message: '现在没有待确认的清理清单。' };
  setSetting(PENDING_BATCH_KEY, '');
  return { ok: true, message: `好，本批 ${batch.items.length} 件全部保持跟进，未做任何清理。` };
}

/** 用户回「恢复 <关键词>」：从近 7 天批量清理记录里按标题找回并重开。 */
export function restoreSweptMatter(keyword: string, now = new Date()): SweepApplyResult {
  const kw = keyword.trim();
  if (!kw) return { ok: false, message: '请带上标题关键词，例如：恢复 图片预览' };
  const sinceIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const hits = listRecentlySweptMatters(sinceIso, kw, 5);
  if (hits.length === 0) {
    return { ok: false, message: `近 7 天的批量清理记录里没找到标题含「${kw}」的事项。` };
  }
  if (hits.length > 1) {
    const list = hits.map((h) => `· ${clip(h.title, 50)}`).join('\n');
    return { ok: false, message: `找到多件，回复更精确的关键词：\n${list}` };
  }
  const r = userReopenMatter(hits[0].matterId, `你在飞书要求恢复（批量清理误清找回）`, now.toISOString());
  if (!r) return { ok: false, message: `恢复失败：「${clip(hits[0].title, 50)}」当前状态不可重开。` };
  writeAudit({
    action: 'backlog_sweep_restored',
    reason: `恢复被批量清理的事项：${clip(hits[0].title, 60)}`,
    payload: { matterId: hits[0].matterId },
  });
  return { ok: true, message: `已恢复「${clip(hits[0].title, 50)}」，继续跟进。` };
}

let sweepTimer: NodeJS.Timeout | undefined;

/** 每分钟检查：到点（sweepHour 后）且今天没跑过 → 跑一轮。每天至多一次尝试（失败也不重试轰炸）。 */
export function startBacklogSweepJob(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = new Date();
    if (!config.sweepEnabled) return;
    if (now.getHours() < config.sweepHour) return;
    const today = localDateStr(now);
    if (getSetting(LAST_RUN_KEY) === today) return;
    setSetting(LAST_RUN_KEY, today); // 先标记：每天至多一次尝试
    void runBacklogSweep(now)
      .then((r) => {
        if (r === 'sent') console.log('[sweep] 大扫除清单已发飞书待确认');
      })
      .catch((err) => console.warn('[sweep] run failed:', err instanceof Error ? err.message : String(err)));
  }, 60_000);
  console.log(`[sweep] 积压大扫除任务已启动（每天 ${config.sweepHour}:00 后扫一轮）`);
}

export function stopBacklogSweepJob(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}
