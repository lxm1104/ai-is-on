import crypto from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import type { Collector, RawSignal } from './types.js';

/**
 * MVP5.0 drive collector — wraps `lark-cli drive +search --edited-since` to
 * pull recently-edited Lark docs that the current user can see. Each doc that
 * has changed since the last successful scan becomes one RawSignal.
 *
 * 注意：
 * - lark-cli 的 my_edit_time 是小时粒度，server-side snap 到整点。我们 since
 *   传 ISO 即可，lark-cli 会处理。
 * - 同一 doc 多次编辑通过 content_hash (token + update_time) 去重；只有
 *   update_time 变了才会插入新一条 event。
 */

type DriveSearchResult = {
  entity_type?: string;
  result_meta?: {
    create_time?: number;
    create_time_iso?: string;
    doc_types?: string;
    edit_user_name?: string;
    edit_user_id?: string;
    owner_name?: string;
    token?: string;
    update_time?: number;
    update_time_iso?: string;
    url?: string;
  };
  title_highlighted?: string;
  summary_highlighted?: string;
};

type DriveSearchResp = {
  ok?: boolean;
  data?: {
    has_more?: boolean;
    page_token?: string;
    results?: DriveSearchResult[];
  };
};

function contentHash(doc: DriveSearchResult): string {
  const token = doc.result_meta?.token ?? '';
  const updated = doc.result_meta?.update_time ?? 0;
  return crypto.createHash('sha256').update(`${token}|${updated}`).digest('hex').slice(0, 32);
}

function summarizeDoc(doc: DriveSearchResult): string {
  const m = doc.result_meta ?? {};
  const lines: string[] = [];
  if (doc.title_highlighted) lines.push(`标题：${doc.title_highlighted}`);
  if (m.doc_types) lines.push(`类型：${m.doc_types}`);
  if (m.edit_user_name) lines.push(`最近编辑：${m.edit_user_name}`);
  if (m.owner_name && m.owner_name !== m.edit_user_name) lines.push(`所有者：${m.owner_name}`);
  if (m.update_time_iso) lines.push(`更新时间：${m.update_time_iso}`);
  if (doc.summary_highlighted && doc.summary_highlighted.trim()) {
    const summary = doc.summary_highlighted.trim();
    lines.push(`摘要：${summary.length > 400 ? summary.slice(0, 400) + '…' : summary}`);
  }
  if (m.url) lines.push(`链接：${m.url}`);
  return lines.join('\n');
}

function stripHl(s?: string): string {
  if (!s) return '';
  // 飞书 search 在命中关键字处可能加 <mark> 之类标记
  return s.replace(/<[^>]+>/g, '');
}

export const driveCollector: Collector = {
  name: 'drive',
  intervalMs: config.driveIntervalMs,

  async collect(since: Date | null): Promise<RawSignal[]> {
    // First scan: 7 day lookback per spec §15
    const sinceIso = since
      ? since.toISOString()
      : new Date(Date.now() - config.driveFirstScanDays * 86400_000).toISOString();

    const args = [
      'drive',
      '+search',
      '--edited-since',
      sinceIso,
      '--page-size',
      String(config.drivePageSize),
      '--format',
      'json',
      '--sort',
      'edit_time',
    ];

    const resp = await runLarkCliJson<DriveSearchResp>(args);
    const items = resp.data?.results ?? [];

    const signals: RawSignal[] = [];
    for (const doc of items) {
      const token = doc.result_meta?.token;
      if (!token) continue;
      const updateIso =
        doc.result_meta?.update_time_iso ??
        (doc.result_meta?.update_time
          ? new Date(doc.result_meta.update_time * 1000).toISOString()
          : new Date().toISOString());
      const sig: RawSignal = {
        source: 'drive',
        sourceId: `doc:${token}`,
        kind: 'doc_update',
        occurredAt: updateIso,
        title: stripHl(doc.title_highlighted) || `(无标题文档 ${token.slice(0, 6)})`,
        text: summarizeDoc(doc),
        raw: doc,
        contentHash: contentHash(doc),
      };
      if (doc.result_meta?.edit_user_name) sig.actor = doc.result_meta.edit_user_name;
      if (doc.result_meta?.url) sig.url = doc.result_meta.url;
      signals.push(sig);
    }
    return signals;
  },
};
