import crypto from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import type { CollectResult, Collector, RawSignal } from './types.js';

type AgendaEvent = {
  event_id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start_time?: { datetime?: string; timezone?: string };
  end_time?: { datetime?: string; timezone?: string };
  attendees?: Array<{ open_id?: string }>;
  event_organizer?: { display_name?: string; user_id?: string };
  app_link?: string;
};

type AgendaResp = { ok?: boolean; data?: AgendaEvent[] };

const HOUR_MS = 60 * 60 * 1000;

function calendarContentHash(ev: AgendaEvent): string {
  const attendees = (ev.attendees ?? [])
    .map((a) => a.open_id ?? '')
    .filter(Boolean)
    .sort()
    .join('|');
  const payload = JSON.stringify({
    title: ev.summary ?? '',
    start: ev.start_time?.datetime ?? '',
    end: ev.end_time?.datetime ?? '',
    location: ev.location ?? '',
    description: ev.description ?? '',
    attendees,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function summarizeEvent(ev: AgendaEvent): string {
  const lines: string[] = [];
  if (ev.summary) lines.push(`标题：${ev.summary}`);
  if (ev.start_time?.datetime || ev.end_time?.datetime) {
    lines.push(
      `时间：${ev.start_time?.datetime ?? '?'} - ${ev.end_time?.datetime ?? '?'}`
    );
  }
  if (ev.location) lines.push(`地点：${ev.location}`);
  if (ev.event_organizer?.display_name)
    lines.push(`组织者：${ev.event_organizer.display_name}`);
  if (ev.description) {
    const desc = ev.description.trim();
    lines.push(`描述：${desc.length > 400 ? desc.slice(0, 400) + '…' : desc}`);
  }
  const atSize = (ev.attendees ?? []).length;
  if (atSize) lines.push(`参与者：${atSize} 人`);
  return lines.join('\n');
}

export const calendarCollector: Collector = {
  name: 'calendar',
  intervalMs: config.calendarIntervalMs,
  async collect(): Promise<CollectResult> {
    // 不强依赖 since：日历窗口固定为 [now-2h, now+48h]，每轮 dedup 由 events.UNIQUE(content_hash) 兜底
    // MVP33：快照式采集，水位 = 本轮扫描起点（与历史行为一致）
    const now = new Date();
    const coveredUntil = now.toISOString();
    const start = new Date(now.getTime() - 2 * HOUR_MS).toISOString();
    const end = new Date(now.getTime() + 48 * HOUR_MS).toISOString();

    const resp = await runLarkCliJson<AgendaResp>([
      'calendar',
      '+agenda',
      '--as',
      'user',
      '--start',
      start,
      '--end',
      end,
      '--format',
      'json',
    ]);

    if (!resp.ok || !Array.isArray(resp.data)) return { signals: [], coveredUntil };

    const signals: RawSignal[] = [];
    for (const ev of resp.data) {
      if (!ev.event_id) continue;
      const occurredAt = ev.start_time?.datetime ?? new Date().toISOString();
      signals.push({
        source: 'calendar',
        sourceId: ev.event_id,
        kind: 'event',
        occurredAt,
        title: ev.summary,
        text: summarizeEvent(ev),
        actor: ev.event_organizer?.display_name,
        url: ev.app_link,
        raw: ev,
        contentHash: calendarContentHash(ev),
      });
    }
    return { signals, coveredUntil };
  },
};
