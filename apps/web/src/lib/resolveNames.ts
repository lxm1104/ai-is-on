/**
 * Resolve Feishu doc URLs and user open_ids to human-readable names.
 *
 * Used by `<ResolvedText/>` so card text like
 *   `[DIh1bk8bQa1EXrstYtnccUDXnCf](https://www.feishu.cn/base/DIh1bk8bQa1EXrstYtnccUDXnCf)`
 * renders as the doc's real title instead of the raw token.
 *
 * Strategy:
 * - localStorage cache (24h TTL) so refreshing the page doesn't re-hit the API.
 * - In-memory in-flight de-dup so multiple cards asking for the same URL
 *   collapse into one network round-trip.
 */

const STORAGE_KEY = 'aiio:nameResolve:v1';
const TTL_MS = 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 5 * 60 * 1000;

export type DocInfo = { title: string; url: string; token: string; type: string };

type CachedDoc = { value: DocInfo | null; expiresAt: number };
type CachedUser = { value: string | null; expiresAt: number };
type Cache = {
  docs: Record<string, CachedDoc>;
  users: Record<string, CachedUser>;
};

function loadCache(): Cache {
  if (typeof localStorage === 'undefined') return { docs: {}, users: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { docs: {}, users: {} };
    const parsed = JSON.parse(raw) as Cache;
    return {
      docs: parsed.docs ?? {},
      users: parsed.users ?? {},
    };
  } catch {
    return { docs: {}, users: {} };
  }
}

function saveCache(c: Cache) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // quota or disabled — silently ignore
  }
}

let cache: Cache = loadCache();

function getDoc(url: string): DocInfo | null | undefined {
  const e = cache.docs[url];
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    delete cache.docs[url];
    return undefined;
  }
  return e.value;
}

function getUser(openId: string): string | null | undefined {
  const e = cache.users[openId];
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    delete cache.users[openId];
    return undefined;
  }
  return e.value;
}

function setDoc(url: string, value: DocInfo | null) {
  cache.docs[url] = {
    value,
    expiresAt: Date.now() + (value ? TTL_MS : NEG_TTL_MS),
  };
  saveCache(cache);
}

function setUser(openId: string, value: string | null) {
  cache.users[openId] = {
    value,
    expiresAt: Date.now() + (value ? TTL_MS : NEG_TTL_MS),
  };
  saveCache(cache);
}

// ---------- extraction ----------

export type FeishuRef =
  | { kind: 'mdlink'; raw: string; label: string; url: string }
  | { kind: 'url'; raw: string; url: string }
  | { kind: 'openid'; raw: string; openId: string };

const FEISHU_HOST_RE = /(?:feishu\.cn|larksuite\.com|larkoffice\.com)/;
const FEISHU_URL_RE =
  /https?:\/\/(?:[\w-]+\.)?(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/[\w/-]+\/[A-Za-z0-9_-]{8,}/g;
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const OPEN_ID_RE = /\bou_[A-Za-z0-9]{16,}\b/g;

/**
 * Split a text string into a sequence of plain-text and ref segments. The
 * scan is greedy + left-to-right with rough priority: markdown link > bare
 * feishu URL > bare open_id. Non-feishu markdown links are kept as plain
 * markdown segments so they still render correctly via fallback.
 */
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'ref'; ref: FeishuRef };

export function extractSegments(text: string): Segment[] {
  if (!text) return [];

  type Hit = { start: number; end: number; ref: FeishuRef };
  const hits: Hit[] = [];

  // 1. markdown links — only keep the ones pointing at Feishu hosts
  for (const m of text.matchAll(MD_LINK_RE)) {
    const [raw, label, url] = m;
    if (!FEISHU_HOST_RE.test(url)) continue;
    if (typeof m.index !== 'number') continue;
    hits.push({
      start: m.index,
      end: m.index + raw.length,
      ref: { kind: 'mdlink', raw, label, url },
    });
  }

  // 2. bare Feishu URLs not already covered by a markdown link
  for (const m of text.matchAll(FEISHU_URL_RE)) {
    const url = m[0];
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + url.length;
    if (hits.some((h) => start >= h.start && end <= h.end)) continue;
    hits.push({ start, end, ref: { kind: 'url', raw: url, url } });
  }

  // 3. bare open_ids
  for (const m of text.matchAll(OPEN_ID_RE)) {
    const id = m[0];
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + id.length;
    if (hits.some((h) => start >= h.start && end <= h.end)) continue;
    hits.push({ start, end, ref: { kind: 'openid', raw: id, openId: id } });
  }

  hits.sort((a, b) => a.start - b.start);

  // Drop overlaps (later/shorter wins lose).
  const dedup: Hit[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue;
    dedup.push(h);
    cursor = h.end;
  }

  const segs: Segment[] = [];
  let pos = 0;
  for (const h of dedup) {
    if (h.start > pos) segs.push({ type: 'text', text: text.slice(pos, h.start) });
    segs.push({ type: 'ref', ref: h.ref });
    pos = h.end;
  }
  if (pos < text.length) segs.push({ type: 'text', text: text.slice(pos) });
  return segs;
}

// ---------- network ----------

const docInflight = new Map<string, Promise<DocInfo | null>>();
const userInflight = new Map<string, Promise<string | null>>();

let pending: { docUrls: Set<string>; openIds: Set<string> } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushResolve: Array<() => void> = [];

function scheduleFlush(): Promise<void> {
  if (!pending) pending = { docUrls: new Set(), openIds: new Set() };
  return new Promise<void>((resolve) => {
    flushResolve.push(resolve);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      void flushNow();
    }, 30);
  });
}

async function flushNow() {
  flushTimer = null;
  const batch = pending;
  pending = null;
  const resolvers = flushResolve;
  flushResolve = [];

  if (!batch || (batch.docUrls.size === 0 && batch.openIds.size === 0)) {
    for (const r of resolvers) r();
    return;
  }

  const body = {
    docUrls: Array.from(batch.docUrls),
    userOpenIds: Array.from(batch.openIds),
  };

  try {
    const r = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`resolve ${r.status}`);
    const j = (await r.json()) as {
      docs: Record<string, DocInfo | null>;
      users: Record<string, string | null>;
    };
    for (const url of body.docUrls) {
      const v = j.docs[url] ?? null;
      setDoc(url, v);
    }
    for (const id of body.userOpenIds) {
      const v = j.users[id] ?? null;
      setUser(id, v);
    }
  } catch (err) {
    // Cache failures with short TTL so we don't spin.
    for (const url of body.docUrls) setDoc(url, null);
    for (const id of body.userOpenIds) setUser(id, null);
    console.warn('[resolveNames] flush failed', err);
  } finally {
    for (const r of resolvers) r();
  }
}

export function getCachedDoc(url: string): DocInfo | null | undefined {
  return getDoc(url);
}

export function getCachedUser(openId: string): string | null | undefined {
  return getUser(openId);
}

export function resolveDocUrl(url: string): Promise<DocInfo | null> {
  const cached = getDoc(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = docInflight.get(url);
  if (inflight) return inflight;
  const p = (async () => {
    if (!pending) pending = { docUrls: new Set(), openIds: new Set() };
    pending.docUrls.add(url);
    await scheduleFlush();
    docInflight.delete(url);
    return getDoc(url) ?? null;
  })();
  docInflight.set(url, p);
  return p;
}

export function resolveOpenId(openId: string): Promise<string | null> {
  const cached = getUser(openId);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = userInflight.get(openId);
  if (inflight) return inflight;
  const p = (async () => {
    if (!pending) pending = { docUrls: new Set(), openIds: new Set() };
    pending.openIds.add(openId);
    await scheduleFlush();
    userInflight.delete(openId);
    return getUser(openId) ?? null;
  })();
  userInflight.set(openId, p);
  return p;
}
