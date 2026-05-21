/**
 * MVP12 §4.1 P1.2 — 从纯文本里抽出飞书 doc 引用（markdown link + bare URL），
 * 输出 ContextEntityRef[]，同时把 `doc:<token>` 与 url 通过 mergeDocIdentity 合并。
 *
 * regex 必须与前端 apps/web/src/lib/resolveNames.ts 保持一致；
 * extract-feishu-doc-refs.test.ts 用同一份 corpus 校验前后端 token/url 集合相同。
 */
import { mergeDocIdentity } from '../context/entityResolver.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';

// === 与前端 resolveNames.ts 完全一致的 regex ===
const FEISHU_HOST_RE = /(?:feishu\.cn|larksuite\.com|larkoffice\.com)/;
const FEISHU_URL_RE =
  /https?:\/\/(?:[\w-]+\.)?(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/[\w/-]+\/[A-Za-z0-9_-]{8,}/g;
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * 从飞书 URL 末段抽 doc token。
 * URL 形如 https://x.feishu.cn/<type>/<TOKEN> 或 …/<type>/<TOKEN>?from=… ；
 * 只取 path 最后一段去掉 query / fragment。
 */
export function extractFeishuToken(url: string): string | null {
  try {
    const u = new URL(url);
    if (!FEISHU_HOST_RE.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (!last) return null;
    if (last.length < 8) return null;
    // token 必须是 [A-Za-z0-9_-]+
    if (!/^[A-Za-z0-9_-]+$/.test(last)) return null;
    return last;
  } catch {
    return null;
  }
}

export type DocRefExtractResult = {
  /** 唯一 URL 列表（按出现顺序去重）。entity.name 直接用这些原始 URL，不 strip query。 */
  urls: string[];
  /** 同步抽出的 token（与 urls 一一对应；缺失为 null） */
  tokens: Array<string | null>;
};

/**
 * 只抽取，不写 DB。给测试和 collector 共用。
 */
export function extractFeishuDocUrls(text: string): DocRefExtractResult {
  if (!text) return { urls: [], tokens: [] };

  // 与前端 resolveNames.ts `extractSegments` 一致：
  //   1) 先收集 markdown link 的 [start, end] 命中
  //   2) bare URL 命中需检查 start/end 是否落在已有 md link 区间内；若是则跳过
  //   3) 同 URL 字符串多次出现 → 仅保留第一次（按 start 升序）
  type Hit = { start: number; end: number; url: string };
  const hits: Hit[] = [];

  for (const m of text.matchAll(MD_LINK_RE)) {
    const url = m[2];
    if (!FEISHU_HOST_RE.test(url)) continue;
    if (typeof m.index !== 'number') continue;
    hits.push({ start: m.index, end: m.index + m[0].length, url });
  }
  for (const m of text.matchAll(FEISHU_URL_RE)) {
    const url = m[0];
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + url.length;
    if (hits.some((h) => start >= h.start && end <= h.end)) continue;
    hits.push({ start, end, url });
  }

  hits.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const h of hits) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    urls.push(h.url);
  }

  const tokens = urls.map((u) => extractFeishuToken(u));
  return { urls, tokens };
}

/**
 * 抽出 + mergeDocIdentity + 返回 ContextEntityRef[]。
 * Collector 落 RawSignal.entities 时直接用。
 *
 * - entity.name = 原始 URL（保留 query / fragment，与前端 cache key 对齐）
 * - role = 'about'
 * - 每个 (token, url) 调一次 mergeDocIdentity 让 `doc:<token>` 自动指向 url entity
 */
export function extractFeishuDocEntities(text: string): ContextEntityRef[] {
  const { urls, tokens } = extractFeishuDocUrls(text);
  const out: ContextEntityRef[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const token = tokens[i];
    if (token) {
      try {
        mergeDocIdentity(token, url);
      } catch {
        // mergeDocIdentity 内部已吞错；这里再裹一层保险
      }
    }
    out.push({ type: 'doc', name: url, role: 'about' });
  }
  return out;
}
