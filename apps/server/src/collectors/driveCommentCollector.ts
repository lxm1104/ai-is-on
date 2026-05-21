import crypto from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { getMyOpenId } from '../util/identity.js';
import { listContextEntities, listEventsBySourceSince } from '../db.js';
import { mergeDocIdentity } from '../context/entityResolver.js';
import { sanitizeExcerpt } from '../bootstrap/workMapDraftPrompt.js';
import type { Collector, RawSignal } from './types.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';

/**
 * MVP11.0-b driveCommentCollector — 扫两类文档的评论：
 *   1. Work Map 权威 doc（type='doc' 的 entity，name 为 URL）
 *   2. 近 14 天 driveCollector 抓到过 doc_update 的 doc
 *
 * 每 tick：
 *   - 收集 file_token 候选集（去重，≤ MAX_DOCS_PER_TICK）
 *   - 每个 file_token 调 drive.file.comments.list，遍历 comment + 每条 comment 的 reply_list.replies
 *   - 每条 comment / reply emit 一个 RawSignal（skipTriage=true，已结构化）
 *
 * 关键 invariant：
 *   - 调用 mergeDocIdentity(token, url) 让 doc:<token> 自动合并到 Work Map URL entity
 *   - 不在此处调 LLM
 *   - is_at_me / on_authoritative_doc / author_is_self 全部在 collector 现场算出，
 *     evaluator 只看 semanticTags
 */

type InspectResp = {
  ok?: boolean;
  data?: {
    input_url?: string;
    title?: string;
    token?: string;
    type?: string; // doc|docx|sheet|bitable|file|slides|wiki...
    url?: string;
  };
};

type ReplyContentElement = {
  type?: string;
  text_run?: { text?: string };
  mention_user?: { user_id?: string };
  // 其他 element 类型直接忽略
};

type ReplyItem = {
  reply_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  content?: { elements?: ReplyContentElement[] };
};

type CommentItem = {
  comment_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  is_solved?: boolean;
  quote?: string;
  reply_list?: { replies?: ReplyItem[] };
};

type CommentsListResp = {
  ok?: boolean;
  data?: {
    has_more?: boolean;
    page_token?: string;
    items?: CommentItem[];
  };
};

// ---------- 缓存：URL → {token, type} ----------

type DocIdent = { token: string; type: string; url: string };
const inspectCache = new Map<string, DocIdent | null>();

async function inspectUrl(url: string): Promise<DocIdent | null> {
  if (inspectCache.has(url)) return inspectCache.get(url) ?? null;
  try {
    const resp = await runLarkCliJson<InspectResp>([
      'drive',
      '+inspect',
      '--url',
      url,
      '--format',
      'json',
    ]);
    const d = resp?.data;
    if (!d?.token || !d?.type) {
      inspectCache.set(url, null);
      return null;
    }
    // 排除评论 API 不支持的 file_type
    const supported = new Set(['doc', 'docx', 'sheet', 'file', 'slides', 'bitable']);
    if (!supported.has(d.type)) {
      inspectCache.set(url, null);
      return null;
    }
    const ident: DocIdent = {
      token: d.token,
      type: d.type,
      url: d.url ?? url,
    };
    inspectCache.set(url, ident);
    return ident;
  } catch (err) {
    console.warn(
      `[driveComment] inspect failed for ${url}:`,
      err instanceof Error ? err.message : String(err)
    );
    inspectCache.set(url, null);
    return null;
  }
}

// ---------- file_token 候选收集 ----------

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function collectAuthoritativeDocUrls(): string[] {
  // listContextEntities 是全量，过滤 type=doc & name 是 http URL
  const all = listContextEntities(1000);
  return all
    .filter((e) => e.type === 'doc' && isHttpUrl(e.name))
    .map((e) => e.name);
}

function collectRecentlyEditedDocUrls(sinceIso: string): string[] {
  // events 表存的 url 字段就是 driveCollector 抓的 doc URL
  const rows = listEventsBySourceSince('drive', 'doc_update', sinceIso, 500);
  const urls = new Set<string>();
  for (const r of rows) {
    if (r.url && isHttpUrl(r.url)) urls.add(r.url);
  }
  return Array.from(urls);
}

// ---------- reply / comment 内容抽取 ----------

function extractReplyText(reply: ReplyItem): { text: string; mentionedOpenIds: string[] } {
  const parts: string[] = [];
  const mentioned: string[] = [];
  for (const el of reply.content?.elements ?? []) {
    if (el.type === 'text_run' && el.text_run?.text) {
      parts.push(el.text_run.text);
    } else if (el.type === 'mention_user' && el.mention_user?.user_id) {
      mentioned.push(el.mention_user.user_id);
      parts.push(`@${el.mention_user.user_id.slice(0, 8)}`);
    }
  }
  return { text: parts.join('').trim(), mentionedOpenIds: mentioned };
}

// ---------- signal 构造 ----------

function contentHashFor(parts: (string | number | undefined)[]): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex')
    .slice(0, 32);
}

function buildReplyId(reply: ReplyItem, commentId: string): string {
  if (reply.reply_id) return reply.reply_id;
  return crypto
    .createHash('sha1')
    .update(
      `${commentId}|${reply.create_time ?? ''}|${reply.user_id ?? ''}|${
        extractReplyText(reply).text
      }`
    )
    .digest('hex')
    .slice(0, 16);
}

function shortUser(openId: string): string {
  if (!openId) return '某人';
  return `用户${openId.slice(-6)}`;
}

function commentDocTitle(ident: DocIdent): string {
  // 评论卡片标题里要带 doc 名字。MVP 简化：直接用 token 短前缀。
  return `文档 ${ident.token.slice(0, 6)}…`;
}

function emitOne(opts: {
  ident: DocIdent;
  commentId: string;
  reply: ReplyItem;
  isRoot: boolean;
  isAuthoritative: boolean;
  myOpenId: string;
}): RawSignal | null {
  const { ident, commentId, reply, isRoot, isAuthoritative, myOpenId } = opts;
  const { text, mentionedOpenIds } = extractReplyText(reply);
  if (!text && !mentionedOpenIds.length) return null;
  const replyId = buildReplyId(reply, commentId);
  const occurredAtSec = reply.update_time ?? reply.create_time ?? Math.floor(Date.now() / 1000);
  const occurredAt = new Date(occurredAtSec * 1000).toISOString();
  const kind = isRoot ? 'doc_comment' : 'doc_comment_reply';
  const sourceId = isRoot
    ? `comment:${ident.token}:${commentId}`
    : `reply:${ident.token}:${commentId}:${replyId}`;
  const authorOpenId = reply.user_id ?? '';
  const isAtMe = !!myOpenId && mentionedOpenIds.includes(myOpenId);
  const authorIsSelf = !!myOpenId && authorOpenId === myOpenId;
  const authorName = shortUser(authorOpenId);

  const sanitized = sanitizeExcerpt(text) || text.slice(0, 200);
  const docTitle = commentDocTitle(ident);
  const title = isRoot
    ? `${authorName}在「${docTitle}」评论`
    : `${authorName}在「${docTitle}」的评论里回复`;
  const bodyLines = [
    `${authorName}：${sanitized}`,
    `文档：${ident.url}`,
  ];
  const bodyText = bodyLines.join('\n');

  const entities: ContextEntityRef[] = [
    { type: 'doc', name: ident.url, role: 'about' },
  ];
  if (authorOpenId) {
    entities.push({
      type: 'person',
      name: authorName,
      role: 'author',
      aliases: [authorOpenId],
    });
  }
  for (const mid of mentionedOpenIds) {
    if (mid === authorOpenId) continue;
    entities.push({
      type: 'person',
      name: shortUser(mid),
      role: 'mention',
      aliases: [mid],
    });
  }

  const contentHash = contentHashFor([
    commentId,
    replyId,
    reply.update_time ?? reply.create_time,
    text,
  ]);

  const semanticTags = {
    signal_kind: kind,
    is_at_me: isAtMe,
    author_is_self: authorIsSelf,
    on_authoritative_doc: isAuthoritative,
    content_hash_bucket: contentHash.slice(0, 16),
  };

  // §4.4.3：is_at_me 或 on_authoritative_doc → notify；否则 record
  const actionability: 'notify' | 'record' =
    isAtMe || isAuthoritative ? 'notify' : 'record';

  return {
    source: 'drive',
    sourceId,
    kind,
    occurredAt,
    title,
    text: bodyText,
    actor: authorName,
    url: ident.url,
    raw: {
      file_token: ident.token,
      file_type: ident.type,
      comment_id: commentId,
      reply_id: replyId,
      reply,
    },
    contentHash,
    entities,
    contextMergeHint: isRoot
      ? `drive_comment:${ident.token}:${commentId}:root`
      : `drive_comment:${ident.token}:${commentId}:${replyId}`,
    scope: 'work',
    actionability,
    semanticTags,
    skipTriage: true,
  };
}

// ---------- 顶层 collector ----------

async function listCommentsForDoc(ident: DocIdent): Promise<CommentItem[]> {
  // MVP：拉一页（page-size=100），足够覆盖大部分场景；翻页留 11.2 优化。
  const args = [
    'drive',
    'file.comments',
    'list',
    '--params',
    JSON.stringify({
      file_token: ident.token,
      file_type: ident.type,
      user_id_type: 'open_id',
      page_size: 100,
    }),
    '--format',
    'json',
  ];
  try {
    const resp = await runLarkCliJson<CommentsListResp>(args);
    if (!resp?.ok && resp?.ok !== undefined) return [];
    return resp?.data?.items ?? [];
  } catch (err) {
    console.warn(
      `[driveComment] list comments failed for ${ident.token}:`,
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

export const driveCommentCollector: Collector = {
  name: 'drive_comment',
  intervalMs: config.driveCommentIntervalMs,

  async collect(_since: Date | null): Promise<RawSignal[]> {
    if (!config.driveCommentEnabled) return [];
    const t0 = Date.now();

    let myOpenId = '';
    try {
      myOpenId = await getMyOpenId();
    } catch (err) {
      console.warn(
        '[driveComment] getMyOpenId failed, is_at_me / author_is_self will be unreliable:',
        err instanceof Error ? err.message : String(err)
      );
    }

    // 1) 收集 URL 集合（Work Map 权威 + 近 N 天编辑）
    const authoritative = new Set(collectAuthoritativeDocUrls());
    const sinceIso = new Date(
      Date.now() - config.driveCommentLookbackDays * 86400_000
    ).toISOString();
    const recent = new Set(collectRecentlyEditedDocUrls(sinceIso));
    const allUrls = new Set<string>([...authoritative, ...recent]);

    // 2) inspect 拿 token+type；超出 cap 则截断
    const cap = config.driveCommentMaxDocsPerTick;
    const urlList = Array.from(allUrls);
    urlList.sort((a, b) =>
      Number(authoritative.has(b)) - Number(authoritative.has(a))
    );

    const idents: Array<{ ident: DocIdent; isAuthoritative: boolean; url: string }> = [];
    let unresolvedUrls = 0;
    let cappedOff = 0;
    for (const url of urlList) {
      if (idents.length >= cap) {
        cappedOff = urlList.length - idents.length - unresolvedUrls;
        break;
      }
      const ident = await inspectUrl(url);
      if (!ident) {
        unresolvedUrls++;
        continue;
      }
      idents.push({ ident, isAuthoritative: authoritative.has(url), url });
      mergeDocIdentity(ident.token, ident.url);
    }

    // 3) 每个 doc 拉评论
    const signals: RawSignal[] = [];
    let atMeCount = 0;
    let authDocSignalCount = 0;
    const perDocCap = config.driveCommentMaxCommentsPerDoc;
    for (const { ident, isAuthoritative } of idents) {
      const comments = await listCommentsForDoc(ident);
      let emitted = 0;
      for (const c of comments) {
        if (emitted >= perDocCap) break;
        const commentId = c.comment_id;
        if (!commentId) continue;
        const replies = c.reply_list?.replies ?? [];
        for (let i = 0; i < replies.length; i++) {
          if (emitted >= perDocCap) break;
          const sig = emitOne({
            ident,
            commentId,
            reply: replies[i],
            isRoot: i === 0,
            isAuthoritative,
            myOpenId,
          });
          if (sig) {
            signals.push(sig);
            emitted++;
            const tags = sig.semanticTags ?? {};
            if (tags.is_at_me === true) atMeCount++;
            if (tags.on_authoritative_doc === true) authDocSignalCount++;
          }
        }
      }
    }

    // MVP11.2 §6 打点：方便后续观察命中率 / 调 rate cap
    console.log(
      '[mvp11.2] driveComment stats',
      JSON.stringify({
        urlsTotal: allUrls.size,
        authoritativeUrls: authoritative.size,
        recentEditedUrls: recent.size,
        inspectedDocs: idents.length,
        unresolvedUrls,
        cappedOffUrls: cappedOff,
        emittedSignals: signals.length,
        atMeSignals: atMeCount,
        authDocSignals: authDocSignalCount,
        elapsedMs: Date.now() - t0,
      })
    );
    return signals;
  },
};
