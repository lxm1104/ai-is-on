import crypto from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { sanitizeExcerpt } from '../bootstrap/workMapDraftPrompt.js';
import type { Collector, RawSignal } from './types.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';

/**
 * MVP11.1 meetingArtifactCollector — 拉飞书会议 AI 纪要 / 妙记，统一成
 * `source='minutes', kind='meeting_artifact'` 的 RawSignal，evaluator 根据
 * semanticTags 触发 meeting_artifact_ready。
 *
 * Discovery 串行（§5.2.1）：
 *   - A：扫近 lookbackDays 天 calendar events → vc +recording 拿 minute_token 集合 X
 *   - B：minutes +search --participant-ids me --start <since> → 集合 Y
 *   - token = X ∪ Y（去重，per-tick ≤ cap）
 *
 * 内容抓取（§5.2.2）：
 *   - vc +notes 拿 AI 笔记 / action items（stdout JSON）
 *   - minutes minutes get 拿元信息（title / duration / owner）
 *   - 任一失败降级，不阻塞
 *
 * 内容裁剪（§5.2.3）：
 *   - ContextUnit.content：summary → action_items → fallback 前 800 字
 *   - raw_json 字节 ≤ 256 KB，超出 head/tail 截断 transcript 字段
 *   - 全部 text 字段过 sanitizeExcerpt
 *
 * 物理 dedup：source='minutes' + sourceId=`minute:<token>` + contentHash。
 */

type MinutesSearchResp = {
  ok?: boolean;
  data?: {
    items?: Array<{
      minute_token?: string;
      title?: string;
      owner_id?: string;
      start_time?: string;
      end_time?: string;
    }>;
    has_more?: boolean;
    page_token?: string;
  };
};

type MinuteMeta = {
  minute_token?: string;
  title?: string;
  cover?: string;
  duration?: string;
  owner_id?: string;
  create_time?: string;
  url?: string;
  [k: string]: unknown;
};

type MinuteGetResp = {
  ok?: boolean;
  data?: { minute?: MinuteMeta };
};

type VcNotesItem = {
  minute_token?: string;
  meeting_id?: string;
  ai_notes?: {
    summary?: string;
    action_items?: Array<{ owner?: string; task?: string; due_at?: string }>;
    decisions?: string[];
    [k: string]: unknown;
  };
  transcript?: string;
  [k: string]: unknown;
};

type VcNotesResp = {
  ok?: boolean;
  data?: { items?: VcNotesItem[] };
};

type Discovered = {
  minuteToken: string;
  title?: string;
  ownerId?: string;
  startIso?: string;
  endIso?: string;
};

const ownerIsMeCache = new Map<string, boolean>();

async function discoverViaMinutesSearch(sinceIso: string): Promise<Discovered[]> {
  try {
    const resp = await runLarkCliJson<MinutesSearchResp>([
      'minutes',
      '+search',
      '--participant-ids',
      'me',
      '--start',
      sinceIso,
      '--page-size',
      '30',
      '--format',
      'json',
    ]);
    const items = resp?.data?.items ?? [];
    return items
      .filter((x) => !!x.minute_token)
      .map((x) => ({
        minuteToken: x.minute_token as string,
        title: x.title,
        ownerId: x.owner_id,
        startIso: x.start_time,
        endIso: x.end_time,
      }));
  } catch (err) {
    console.warn(
      '[meetingArtifact] minutes +search failed:',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

// vc +recording 接受 calendar event ids；MVP11.1 简化：仅靠 minutes +search 做 discovery。
// 11.x 再补 calendar → vc +recording 路径覆盖私会 / 无妙记 mention 的场景。

async function fetchVcNotes(minuteToken: string): Promise<VcNotesItem | null> {
  try {
    const resp = await runLarkCliJson<VcNotesResp>([
      'vc',
      '+notes',
      '--minute-tokens',
      minuteToken,
      '--format',
      'json',
    ]);
    return resp?.data?.items?.[0] ?? null;
  } catch (err) {
    console.warn(
      `[meetingArtifact] vc +notes failed for ${minuteToken}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

async function fetchMinuteMeta(minuteToken: string): Promise<MinuteMeta | null> {
  try {
    const resp = await runLarkCliJson<MinuteGetResp>([
      'minutes',
      'minutes',
      'get',
      '--params',
      JSON.stringify({ minute_token: minuteToken, user_id_type: 'open_id' }),
      '--format',
      'json',
    ]);
    return resp?.data?.minute ?? null;
  } catch (err) {
    console.warn(
      `[meetingArtifact] minutes get failed for ${minuteToken}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ---------- 内容裁剪 ----------

function buildContent(
  notes: VcNotesItem | null,
  fallbackTitle: string
): { text: string; hasActionItems: boolean } {
  if (!notes) return { text: fallbackTitle, hasActionItems: false };
  const ai = notes.ai_notes ?? {};
  const lines: string[] = [];
  const summary = typeof ai.summary === 'string' ? ai.summary.trim() : '';
  if (summary) lines.push(`【会议摘要】\n${sanitizeExcerpt(summary)}`);
  const items = Array.isArray(ai.action_items) ? ai.action_items : [];
  if (items.length) {
    lines.push('【待办】');
    for (const it of items.slice(0, 10)) {
      const owner = sanitizeExcerpt(it.owner ?? '') || '待定';
      const task = sanitizeExcerpt(it.task ?? '');
      const due = it.due_at ? `（${it.due_at}）` : '';
      lines.push(`- ${owner}：${task}${due}`);
    }
  }
  const decisions = Array.isArray(ai.decisions) ? ai.decisions : [];
  if (decisions.length) {
    lines.push('【决定】');
    for (const d of decisions.slice(0, 5)) {
      lines.push(`- ${sanitizeExcerpt(d)}`);
    }
  }
  if (lines.length === 0 && typeof notes.transcript === 'string') {
    const t = sanitizeExcerpt(notes.transcript);
    lines.push(t.slice(0, 800));
  }
  if (lines.length === 0) lines.push(fallbackTitle);
  return { text: lines.join('\n'), hasActionItems: items.length > 0 };
}

function truncateRawForCap(raw: unknown, capBytes: number): {
  raw: unknown;
  truncated: boolean;
} {
  const json = JSON.stringify(raw ?? null);
  if (Buffer.byteLength(json, 'utf8') <= capBytes) {
    return { raw, truncated: false };
  }
  // 仅截 transcript 字段
  const shallow = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : { raw };
  const tx = (shallow as { transcript?: unknown }).transcript;
  if (typeof tx === 'string' && tx.length > 0) {
    const head = tx.slice(0, 64 * 1024);
    const tail = tx.slice(-64 * 1024);
    (shallow as Record<string, unknown>).transcript = {
      head,
      tail,
      omittedBytes: Buffer.byteLength(tx, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'),
      truncated: true,
    };
  }
  // 二次检查 — 如果还超就降级到只留 token + truncated 标志
  const json2 = JSON.stringify(shallow);
  if (Buffer.byteLength(json2, 'utf8') > capBytes) {
    return {
      raw: { truncated: true, omittedBytes: Buffer.byteLength(json, 'utf8') },
      truncated: true,
    };
  }
  return { raw: shallow, truncated: true };
}

// ---------- 顶层 collector ----------

function contentHashFor(parts: (string | number | undefined)[]): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex')
    .slice(0, 32);
}

export const meetingArtifactCollector: Collector = {
  name: 'meeting_artifact',
  intervalMs: config.meetingArtifactIntervalMs,

  async collect(_since: Date | null): Promise<RawSignal[]> {
    if (!config.meetingArtifactEnabled) return [];
    const t0 = Date.now();

    const sinceIso = new Date(
      Date.now() - config.meetingArtifactLookbackDays * 86400_000
    ).toISOString();
    const cap = config.meetingArtifactMaxPerTick;
    const capBytes = config.meetingArtifactRawCapBytes;

    // Discovery：MVP11.1 简化只用 minutes +search（已能覆盖大部分）
    const discovered = await discoverViaMinutesSearch(sinceIso);
    const dedup = new Map<string, Discovered>();
    for (const d of discovered) {
      if (!dedup.has(d.minuteToken)) dedup.set(d.minuteToken, d);
      if (dedup.size >= cap) break;
    }

    const signals: RawSignal[] = [];
    let enrichedNotes = 0;
    let enrichedMeta = 0;
    let truncatedCount = 0;
    let hasActionItemsCount = 0;
    for (const d of dedup.values()) {
      const minuteToken = d.minuteToken;
      // 并行拉 notes + meta
      const [notes, meta] = await Promise.all([
        fetchVcNotes(minuteToken),
        fetchMinuteMeta(minuteToken),
      ]);
      if (notes) enrichedNotes++;
      if (meta) enrichedMeta++;
      const title =
        meta?.title || d.title || notes?.ai_notes?.summary?.slice(0, 30) || `妙记 ${minuteToken.slice(0, 6)}…`;
      const ownerId = meta?.owner_id ?? d.ownerId ?? '';
      const ownerIsMe = (() => {
        if (!ownerId) return false;
        if (ownerIsMeCache.has(ownerId)) return ownerIsMeCache.get(ownerId)!;
        // 简化：暂用 cache 默认 false，11.x 接 getMyOpenId 比对
        ownerIsMeCache.set(ownerId, false);
        return false;
      })();

      const { text, hasActionItems } = buildContent(notes, title);
      const url = meta?.url ?? `https://www.feishu.cn/minutes/${minuteToken}`;
      const occurredAt = d.endIso ?? meta?.create_time ?? new Date().toISOString();

      const rawShape: Record<string, unknown> = {
        minute: meta ?? null,
        notes: notes ?? null,
        discovery: d,
      };
      const { raw, truncated } = truncateRawForCap(rawShape, capBytes);
      if (truncated) truncatedCount++;
      if (hasActionItems) hasActionItemsCount++;

      const contentHash = contentHashFor([
        minuteToken,
        meta?.create_time,
        text.length,
        text.slice(0, 200),
      ]);

      const entities: ContextEntityRef[] = [
        { type: 'meeting', name: minuteToken, role: 'about' },
      ];
      if (ownerId) {
        entities.push({
          type: 'person',
          name: `用户${ownerId.slice(-6)}`,
          role: 'organizer',
          aliases: [ownerId],
        });
      }

      const sig: RawSignal = {
        source: 'minutes',
        sourceId: `minute:${minuteToken}`,
        kind: 'meeting_artifact',
        occurredAt,
        title,
        text,
        actor: ownerId ? `用户${ownerId.slice(-6)}` : undefined,
        url,
        raw,
        contentHash,
        entities,
        contextMergeHint: `meeting_artifact:${minuteToken}`,
        scope: ownerIsMe ? 'personal' : 'work',
        actionability: 'record',
        semanticTags: {
          signal_kind: 'meeting_artifact',
          minute_token: minuteToken,
          content_hash_bucket: contentHash.slice(0, 16),
          truncated,
          has_action_items: hasActionItems,
          owner_is_me: ownerIsMe,
        },
        skipTriage: true,
      };
      signals.push(sig);
    }

    // MVP11.2 §6 打点
    console.log(
      '[mvp11.2] meetingArtifact stats',
      JSON.stringify({
        discoveredMinutes: discovered.length,
        dedupedMinutes: dedup.size,
        cappedAt: cap,
        enrichedNotes,
        enrichedMeta,
        emittedSignals: signals.length,
        truncatedRaw: truncatedCount,
        withActionItems: hasActionItemsCount,
        elapsedMs: Date.now() - t0,
      })
    );
    return signals;
  },
};
