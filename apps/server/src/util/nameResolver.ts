/**
 * Resolve Feishu doc URLs and user open_ids to human-readable names via
 * `lark-cli`. Used by the web UI to swap raw tokens / open_ids in card text
 * with real titles / display names.
 *
 * Strategy:
 * - In-process Map cache with 24h TTL — names rarely change.
 * - Per-key in-flight de-dup so a burst of UI calls collapses into one CLI run.
 * - On failure for a single item we cache a short-TTL null so we don't
 *   hammer lark-cli on every render. Caller still gets `null` (= "give up,
 *   render raw text").
 */
import { runLarkCliJson } from './larkCli.js';

const DOC_TTL_MS = 24 * 60 * 60 * 1000;
const USER_TTL_MS = 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 5 * 60 * 1000; // failed lookups: retry after 5 min

export type DocInfo = { title: string; url: string; token: string; type: string };

type DocEntry = { value: DocInfo | null; expiresAt: number };
type UserEntry = { value: string | null; expiresAt: number };

const docCache = new Map<string, DocEntry>();
const userCache = new Map<string, UserEntry>();

const docInflight = new Map<string, Promise<DocInfo | null>>();
let userBatchTimer: NodeJS.Timeout | null = null;
let userBatchQueue: Array<{ openId: string; resolve: (v: string | null) => void }> = [];

function readDoc(url: string): DocInfo | null | undefined {
  const e = docCache.get(url);
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    docCache.delete(url);
    return undefined;
  }
  return e.value;
}

function writeDoc(url: string, value: DocInfo | null) {
  docCache.set(url, {
    value,
    expiresAt: Date.now() + (value ? DOC_TTL_MS : NEG_TTL_MS),
  });
}

function readUser(openId: string): string | null | undefined {
  const e = userCache.get(openId);
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    userCache.delete(openId);
    return undefined;
  }
  return e.value;
}

function writeUser(openId: string, value: string | null) {
  userCache.set(openId, {
    value,
    expiresAt: Date.now() + (value ? USER_TTL_MS : NEG_TTL_MS),
  });
}

type InspectResp = {
  ok?: boolean;
  data?: {
    title?: string;
    token?: string;
    type?: string;
    url?: string;
    input_url?: string;
  };
};

async function fetchDoc(url: string): Promise<DocInfo | null> {
  try {
    const resp = await runLarkCliJson<InspectResp>([
      'drive',
      '+inspect',
      '--url',
      url,
    ]);
    const d = resp.data;
    if (!d || !d.title || !d.token) return null;
    return {
      title: d.title,
      token: d.token,
      type: d.type ?? 'unknown',
      url: d.url ?? url,
    };
  } catch (err) {
    console.warn(
      `[nameResolver] inspect failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

export async function resolveDoc(url: string): Promise<DocInfo | null> {
  const cached = readDoc(url);
  if (cached !== undefined) return cached;
  const inflight = docInflight.get(url);
  if (inflight) return inflight;
  const p = fetchDoc(url).then((v) => {
    writeDoc(url, v);
    docInflight.delete(url);
    return v;
  });
  docInflight.set(url, p);
  return p;
}

export async function resolveDocs(urls: string[]): Promise<Record<string, DocInfo | null>> {
  const out: Record<string, DocInfo | null> = {};
  const unique = Array.from(new Set(urls.filter(Boolean)));
  await Promise.all(
    unique.map(async (u) => {
      out[u] = await resolveDoc(u);
    })
  );
  return out;
}

// ---------- users ----------

type SearchUserResp = {
  ok?: boolean;
  data?: {
    users?: Array<{
      open_id?: string;
      name?: string;
      localized_name?: string;
      en_name?: string;
    }>;
  };
};

async function flushUserBatch() {
  userBatchTimer = null;
  const queue = userBatchQueue;
  userBatchQueue = [];
  if (queue.length === 0) return;

  // Deduplicate
  const idToCallbacks = new Map<string, Array<(v: string | null) => void>>();
  for (const item of queue) {
    const arr = idToCallbacks.get(item.openId) ?? [];
    arr.push(item.resolve);
    idToCallbacks.set(item.openId, arr);
  }
  const ids = Array.from(idToCallbacks.keys());

  try {
    // search-user supports up to 100 ids per call; chunk just in case.
    const CHUNK = 80;
    const found = new Map<string, string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      try {
        const resp = await runLarkCliJson<SearchUserResp>([
          'contact',
          '+search-user',
          '--as',
          'user',
          '--user-ids',
          slice.join(','),
          '--page-size',
          String(Math.min(slice.length, 30)),
        ]);
        const users = resp.data?.users ?? [];
        for (const u of users) {
          if (!u.open_id) continue;
          const name = u.localized_name || u.name || u.en_name;
          if (name) found.set(u.open_id, name);
        }
      } catch (err) {
        console.warn(
          `[nameResolver] search-user chunk failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    for (const id of ids) {
      const v = found.get(id) ?? null;
      writeUser(id, v);
      for (const cb of idToCallbacks.get(id) ?? []) cb(v);
    }
  } catch (err) {
    console.warn(
      `[nameResolver] user batch resolve failed: ${err instanceof Error ? err.message : String(err)}`
    );
    for (const id of ids) {
      writeUser(id, null);
      for (const cb of idToCallbacks.get(id) ?? []) cb(null);
    }
  }
}

export function resolveUser(openId: string): Promise<string | null> {
  const cached = readUser(openId);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise<string | null>((resolve) => {
    userBatchQueue.push({ openId, resolve });
    if (!userBatchTimer) {
      userBatchTimer = setTimeout(() => void flushUserBatch(), 20);
    }
  });
}

export async function resolveUsers(openIds: string[]): Promise<Record<string, string | null>> {
  const unique = Array.from(new Set(openIds.filter(Boolean)));
  const entries = await Promise.all(
    unique.map(async (id) => [id, await resolveUser(id)] as const)
  );
  const out: Record<string, string | null> = {};
  for (const [id, v] of entries) out[id] = v;
  return out;
}
