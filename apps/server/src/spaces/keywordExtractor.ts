/**
 * MVP13: 轻量的 token / keyword 抽取，用于：
 *   - Space intent_json.keywords（Work Map writer 自动同步）
 *   - chat / Space 名字归一化 + tokenize → nameSimilarity
 *
 * 不引入新依赖；规则简单可解释：
 *   1. 把文本拆成 unicode letter+number 段
 *   2. 全小写
 *   3. 长度 < 2 的 token 丢掉
 *   4. 去常见停用词（中英都有）
 *   5. dedup 保序
 */

const STOPWORDS = new Set<string>([
  // 英
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'with', 'by',
  'is', 'are', 'be', 'this', 'that', 'we', 'you', 'they', 'it', 'as', 'at',
  'from', 'so', 'do', 'does', 'has', 'have', 'will', 'shall', 'about',
  // 中（高频虚词；为了简单不分词，按"短串包含"匹配；故只放单字
  // 不实用 —— 中文我们走 character bigram 一种近似）
  '的', '了', '和', '与', '在', '是', '我', '你', '他', '她', '它', '们',
  '及', '或', '一', '个',
]);

const TOKEN_RE = /[\p{Letter}\p{Number}]+/gu;

export function tokenize(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const tokens: string[] = [];
  const matches = String(raw).toLowerCase().match(TOKEN_RE) ?? [];
  for (const m of matches) {
    if (m.length < 2) continue;
    if (STOPWORDS.has(m)) continue;
    tokens.push(m);
  }
  // 中文额外做 bigram：上面 TOKEN_RE 会把中文整段连一起，按字符切 bigram
  const bigrams: string[] = [];
  for (const seg of matches) {
    // 整段是否全中文（无 ASCII letter/number）
    if (/^[\p{Script=Han}]+$/u.test(seg) && seg.length >= 2) {
      for (let i = 0; i + 2 <= seg.length; i++) {
        const bg = seg.slice(i, i + 2);
        if (STOPWORDS.has(bg)) continue;
        bigrams.push(bg);
      }
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...tokens, ...bigrams]) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function extractKeywords(raw: string, limit = 12): string[] {
  return tokenize(raw).slice(0, limit);
}

/**
 * Space ↔ chat name 归一化：
 *   - lower
 *   - 去常见噪声装饰 (【】[]()（）)
 *   - 保留汉字/英数
 *   - 多空白合一
 */
export function normalizeDisplayName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).toLowerCase();
  s = s.replace(/[【】\[\]()（）「」『』《》<>]/g, ' ');
  s = s.replace(/[^\p{Letter}\p{Number}\s]+/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Jaccard + substring bonus。
 *   - tokens(spaceName) ∩ tokens(chatName) / union
 *   - 如果 spaceName 归一化后是 chatName 的子串 → 至少 0.72
 *   - 返回 max(jaccard, substringScore)
 */
export function nameSimilarity(
  spaceName: string,
  chatName: string
): { similarity: number; tokenOverlap: string[] } {
  const a = new Set(tokenize(spaceName));
  const b = new Set(tokenize(chatName));
  const overlap: string[] = [];
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) {
      inter++;
      overlap.push(t);
    }
  }
  const union = new Set([...a, ...b]).size;
  const jaccard = union === 0 ? 0 : inter / union;

  const ns = normalizeDisplayName(spaceName);
  const nc = normalizeDisplayName(chatName);
  let sub = 0;
  if (ns.length >= 2 && nc.length >= 2 && nc.includes(ns)) sub = 0.72;
  return { similarity: Math.max(jaccard, sub), tokenOverlap: overlap };
}
