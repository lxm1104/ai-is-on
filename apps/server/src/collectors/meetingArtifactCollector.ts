import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { getMyOpenId } from '../util/identity.js';
import type { Collector, RawSignal } from './types.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';

/**
 * MVP25 meetingArtifactCollector — 把"我参与的、有智能纪要的会议"接入 context。
 *
 * 取代 MVP11.1 的失效实现（基于假想 schema，从未写入任何行）。真实数据模型（实测）：
 *   - `vc +search --participant-ids <open_id>` 以会议为中心列出我参与的每一场，
 *     display_info 标注是否有"智能纪要"。
 *   - 绝大多数会议的"智能纪要"是一份**云文档**（note_doc_token），不是妙记 AI 产物：
 *       vc +notes --meeting-ids <id> → 拿 note_doc_token（智能纪要）/ verbatim_doc_token（逐字稿）
 *       docs +fetch --doc <note_doc_token> --api-version v2 → 文档内容（DocxXML）
 *     极少数有录制的会才带 artifacts（summary/todos），作为低成本兜底。
 *   - content 只放 AI 总结结果（总结 + 待办）；逐字稿（verbatim_doc / artifacts.transcript_file）
 *     不进 content、也不读取。
 *
 * 物理 dedup：source='minutes' + sourceId=`meeting:<meetingId>` + contentHash，
 * 经 events 表 UNIQUE(source, source_id, content_hash) 保证幂等。
 *
 * recentEvents 时序语义 / 首次回填洪峰：见 docs/MVP25。稳态 lookback 取 7 天。
 */

// vc +notes 的逐字稿下载目录。--output-dir 实测只接受 cwd 内的相对路径（拒绝绝对路径）。
// 我们不读取逐字稿，仅在每轮 collect 末尾整体清理，避免污染工作目录。
const MINUTES_TMP_DIR = './.cache/meeting-minutes';

// ---------- lark-cli 返回类型（按真实 schema） ----------

type VcSearchResp = {
  ok?: boolean;
  data?: {
    items?: Array<{ id?: string; display_info?: string; meta_data?: { app_link?: string } }>;
    has_more?: boolean;
    page_token?: string;
  };
};

type VcNoteArtifacts = {
  summary?: { content?: string };
  todos?: Array<{ content?: string }>;
  chapters?: Array<{ title?: string; summary_content?: string; start_ms?: string }>;
  keywords?: string[] | string;
  transcript_file?: unknown;
};

type VcNote = {
  minute_token?: string;
  meeting_id?: string;
  create_time?: string; // "2026-06-03 20:22"
  creator_id?: string; // open_id
  note_doc_token?: string; // 智能纪要（AI 总结）云文档
  verbatim_doc_token?: string; // 逐字稿云文档（不读取）
  error?: unknown;
  artifacts?: VcNoteArtifacts;
};

type VcNotesResp = { ok?: boolean; data?: { notes?: VcNote[] } };

type DocsFetchResp = { ok?: boolean; data?: { document?: { content?: string } } };

type DiscoveredMeeting = {
  meetingId: string;
  title: string;
  organizer?: string;
};

// ---------- 纯函数（导出，供单测） ----------

/**
 * MVP25: 从 vc +search 的一个 item 解析出会议元信息。
 * display_info 形如（多行）：
 *   "对一下工具问题的视频会议\n云文档：智能纪要：xxx\n今天 20:16 | 组织者：刘昕明 | ID: 162 330 681"
 * 纯函数，无 IO，便于单测。解析失败的字段留空，不抛错。
 */
export function parseMeetingSearchItem(item: {
  id?: string;
  display_info?: string;
}): { meetingId: string; title: string; organizer?: string; hasMinutes: boolean } | null {
  if (!item.id) return null;
  const info = item.display_info ?? '';
  const lines = info
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const title = lines[0] ?? '';
  const organizer = info.match(/组织者[：:]\s*([^|｜\n]+)/)?.[1]?.trim() || undefined;
  const hasMinutes = /智能纪要/.test(info);
  return { meetingId: item.id, title, organizer, hasMinutes };
}

/**
 * MVP25: 把智能纪要云文档的 DocxXML content 转成纯文本。
 *   - <cite user-name="X"> → X（参会人/负责人姓名）
 *   - <whiteboard> → 去除
 *   - 块级闭合标签 → 换行；<li> → "- "
 *   - 其余标签去除；折叠多余空行
 * 纯函数，便于单测。
 */
export function stripDocxXml(content: string): string {
  return content
    .replace(/<cite\b[^>]*user-name="([^"]*)"[^>]*>\s*<\/cite>/g, '$1、')
    .replace(/<whiteboard\b[^>]*>\s*<\/whiteboard>/g, '')
    .replace(/<li\b[^>]*>/g, '\n- ')
    .replace(/<\/(h1|h2|h3|h4|p|blockquote|li|tr)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 内容上限（字符）。智能纪要总结+待办通常 < 2000；超出截断。
const MEETING_TEXT_CAP = 2000;

/**
 * 脱敏但**保留换行结构**（不同于 sanitizeExcerpt：后者会把换行压成空格并截断到 120 字，
 * 仅适合短摘要）。redact email / url / 长数字，不截断（截断由调用方按 CAP 控制）。
 */
function redactSensitive(s: string): string {
  return s
    .replace(/\S+@\S+\.\S+/g, '<email>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d{9,}/g, (m) => m.slice(0, 3) + '***' + m.slice(-2));
}

/**
 * MVP25: 从智能纪要文档纯文本里裁出 content——去掉 AI 免责声明、"会议最佳表现成员"、
 * "相关链接"等尾部噪声，保留主题/参会人/总结/待办（含换行结构）。纯函数，便于单测。
 */
export function buildContentFromDocText(
  docText: string,
  fallbackTitle: string
): { text: string; hasActionItems: boolean } {
  if (!docText?.trim()) return { text: fallbackTitle, hasActionItems: false };
  let t = docText
    .replace(/智能会议纪要由 AI 生成[^\n]*\n?/g, '')
    .replace(/\n会议最佳表现成员[\s\S]*$/g, '')
    .replace(/\n相关链接[\s\S]*$/g, '')
    .trim();
  // hasActionItems 在截断前、保留换行时判定，避免被 CAP 截掉"待办"段而漏判。
  const hasActionItems = /(^|\n)\s*待办/.test(t);
  t = redactSensitive(t).slice(0, MEETING_TEXT_CAP);
  return { text: t || fallbackTitle, hasActionItems };
}

/**
 * MVP25: 兜底——极少数有录制的会带 artifacts（summary/todos）。content 只放总结结果。
 * 纯函数，便于单测。
 */
export function buildContent(
  artifacts: VcNoteArtifacts | null | undefined,
  fallbackTitle: string
): { text: string; hasActionItems: boolean } {
  if (!artifacts) return { text: fallbackTitle, hasActionItems: false };
  const lines: string[] = [];
  const summary = artifacts.summary?.content?.trim();
  if (summary) lines.push(`【会议摘要】\n${redactSensitive(summary)}`);
  const todos = Array.isArray(artifacts.todos) ? artifacts.todos : [];
  if (todos.length) {
    lines.push('【待办】');
    for (const t of todos.slice(0, 10)) {
      const c = redactSensitive((t.content ?? '').trim());
      if (c) lines.push(`- ${c}`);
    }
  }
  const chapters = Array.isArray(artifacts.chapters) ? artifacts.chapters : [];
  if (!summary && chapters.length) {
    lines.push('【章节脉络】');
    for (const c of chapters.slice(0, 8)) {
      const t = redactSensitive((c.title ?? c.summary_content ?? '').trim());
      if (t) lines.push(`- ${t}`);
    }
  }
  if (lines.length === 0) lines.push(fallbackTitle);
  return { text: lines.join('\n').slice(0, MEETING_TEXT_CAP), hasActionItems: todos.length > 0 };
}

function buildEntities(d: DiscoveredMeeting): ContextEntityRef[] {
  const entities: ContextEntityRef[] = [
    { type: 'meeting', name: d.title || d.meetingId, role: 'about' },
  ];
  if (d.organizer) entities.push({ type: 'person', name: d.organizer, role: 'organizer' });
  return entities;
}

function contentHashFor(parts: (string | number | undefined)[]): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex')
    .slice(0, 32);
}

function truncateRawForCap(raw: unknown, capBytes: number): { raw: unknown; truncated: boolean } {
  const json = JSON.stringify(raw ?? null);
  if (Buffer.byteLength(json, 'utf8') <= capBytes) return { raw, truncated: false };
  return { raw: { truncated: true, omittedBytes: Buffer.byteLength(json, 'utf8') }, truncated: true };
}

function parseCreateTimeIso(createTime?: string): string {
  if (!createTime) return new Date().toISOString();
  const d = new Date(createTime.replace(' ', 'T') + '+08:00');
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

// ---------- IO 包装（薄，不单测） ----------

/**
 * MVP25: minutes +search 只覆盖"我拥有/被分享"的妙记（实测近30天仅 5 场）。改用
 * vc +search 按参会人枚举我参与的所有会议（实测 85 场），display_info 标注智能纪要。
 */
async function discoverViaVcSearch(
  myOpenId: string,
  sinceIso: string
): Promise<DiscoveredMeeting[]> {
  const parsed: Array<NonNullable<ReturnType<typeof parseMeetingSearchItem>>> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < config.meetingArtifactSearchMaxPages; page++) {
    const args = [
      'vc', '+search', '--participant-ids', myOpenId,
      '--start', sinceIso, '--page-size', '30', '--format', 'json',
    ];
    if (pageToken) args.push('--page-token', pageToken);
    const resp = await runLarkCliJson<VcSearchResp>(args);
    for (const it of resp?.data?.items ?? []) {
      const p = parseMeetingSearchItem(it);
      if (p) parsed.push(p);
    }
    if (!resp?.data?.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
    if (page === config.meetingArtifactSearchMaxPages - 1) {
      console.warn(
        `[meetingArtifact] vc +search hit page cap (${config.meetingArtifactSearchMaxPages}), 可能有更早会议被截断`
      );
    }
  }

  const seen = new Set<string>();
  const out: DiscoveredMeeting[] = [];
  for (const p of parsed) {
    if (config.meetingArtifactOnlyWithMinutes && !p.hasMinutes) continue;
    if (seen.has(p.meetingId)) continue;
    seen.add(p.meetingId);
    out.push({ meetingId: p.meetingId, title: p.title, organizer: p.organizer });
  }
  return out;
}

async function fetchVcNotes(meetingId: string): Promise<VcNote | null> {
  try {
    // --output-dir 只接受 cwd 内相对路径；进度行走 stderr，stdout 是纯 JSON。
    const resp = await runLarkCliJson<VcNotesResp>([
      'vc', '+notes', '--meeting-ids', meetingId,
      '--output-dir', MINUTES_TMP_DIR, '--overwrite', '--format', 'json',
    ]);
    const note = resp?.data?.notes?.[0];
    // 注意：note.error="no minute file" 是正常的——表示没有妙记，但 note_doc_token 仍可用。
    if (!note) return null;
    if (!note.note_doc_token && !note.artifacts) return null; // 既无智能纪要文档也无 artifacts → 跳过
    return note;
  } catch (err) {
    console.warn(
      `[meetingArtifact] vc +notes failed for ${meetingId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

async function fetchNoteDocText(noteDocToken: string): Promise<string | null> {
  try {
    const resp = await runLarkCliJson<DocsFetchResp>([
      'docs', '+fetch', '--doc', noteDocToken, '--api-version', 'v2', '--format', 'json',
    ]);
    const content = resp?.data?.document?.content;
    return typeof content === 'string' && content ? stripDocxXml(content) : null;
  } catch (err) {
    console.warn(
      `[meetingArtifact] docs +fetch failed for ${noteDocToken}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

function cleanupTmpDir(): void {
  try {
    fs.rmSync(MINUTES_TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------- 顶层 collector ----------

export const meetingArtifactCollector: Collector = {
  name: 'meeting_artifact',
  intervalMs: config.meetingArtifactIntervalMs,

  async collect(_since: Date | null): Promise<RawSignal[]> {
    if (!config.meetingArtifactEnabled) return [];
    const t0 = Date.now();

    const myOpenId = await getMyOpenId().catch(() => '');
    if (!myOpenId) {
      console.warn('[meetingArtifact] getMyOpenId failed, skip this tick');
      return [];
    }

    const sinceIso = new Date(
      Date.now() - config.meetingArtifactLookbackDays * 86400_000
    ).toISOString();

    const discovered = await discoverViaVcSearch(myOpenId, sinceIso);
    const targets = discovered.slice(0, config.meetingArtifactMaxPerTick);
    const capBytes = config.meetingArtifactRawCapBytes;

    const signals: RawSignal[] = [];
    let fromDoc = 0;
    let fromArtifacts = 0;
    let withActionItems = 0;
    let truncatedCount = 0;
    try {
      for (const d of targets) {
        // 串行调用，规避 vc +notes / docs +fetch 高频限流。
        const note = await fetchVcNotes(d.meetingId);
        if (!note) continue;

        // 内容来源：优先智能纪要文档（note_doc_token），兜底 artifacts（录制妙记）。
        let built: { text: string; hasActionItems: boolean } | null = null;
        let docText: string | null = null;
        if (note.note_doc_token) {
          docText = await fetchNoteDocText(note.note_doc_token);
          if (docText) {
            built = buildContentFromDocText(docText, d.title);
            fromDoc++;
          }
        }
        if (!built && note.artifacts) {
          built = buildContent(note.artifacts, d.title);
          fromArtifacts++;
        }
        if (!built) continue; // 文档读不出且无 artifacts → 跳过

        const { text, hasActionItems } = built;
        if (hasActionItems) withActionItems++;
        const ownerIsMe = !!note.creator_id && note.creator_id === myOpenId;
        const occurredAt = parseCreateTimeIso(note.create_time);
        const minuteToken = note.minute_token ?? '';
        const title = d.title || `会议纪要 ${d.meetingId.slice(-6)}`;

        // raw_json：notes 的 JSON（不含逐字稿正文）+ discovery。文档正文不入 raw（已在 text）。
        const { raw, truncated } = truncateRawForCap({ note, discovery: d }, capBytes);
        if (truncated) truncatedCount++;

        const contentHash = contentHashFor([
          d.meetingId,
          note.create_time,
          text.length,
          text.slice(0, 200),
        ]);

        signals.push({
          source: 'minutes',
          sourceId: `meeting:${d.meetingId}`,
          kind: 'meeting_artifact',
          occurredAt,
          title,
          text,
          actor: d.organizer,
          url: note.note_doc_token
            ? `https://www.feishu.cn/docx/${note.note_doc_token}`
            : minuteToken
              ? `https://www.feishu.cn/minutes/${minuteToken}`
              : undefined,
          raw,
          contentHash,
          entities: buildEntities(d),
          contextMergeHint: `meeting_artifact:${d.meetingId}`,
          scope: 'work',
          actionability: 'record',
          semanticTags: {
            signal_kind: 'meeting_artifact',
            meeting_id: d.meetingId,
            minute_token: minuteToken,
            content_hash_bucket: contentHash.slice(0, 16),
            truncated,
            has_action_items: hasActionItems,
            owner_is_me: ownerIsMe,
          },
          // MVP25.1: 不再 skipTriage —— 会议纪要和 IM/文档一样过 triage，
          // 把总结/待办拆成独立的 commitment/goal 等 unit（挂到对应人/项目），
          // 而不是当成一个 event blob 让 attention 跨会议打包成"N场会议"meta 卡。
        });
      }
    } finally {
      cleanupTmpDir();
    }

    console.log(
      '[mvp25] meetingArtifact stats',
      JSON.stringify({
        discovered: discovered.length,
        targeted: targets.length,
        emitted: signals.length,
        fromDoc,
        fromArtifacts,
        withActionItems,
        truncatedRaw: truncatedCount,
        lookbackDays: config.meetingArtifactLookbackDays,
        elapsedMs: Date.now() - t0,
      })
    );
    return signals;
  },
};
