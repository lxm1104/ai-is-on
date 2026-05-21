/**
 * MVP11.0-a：把 collector 现场算出的结构化判定（is_at_me / signal_kind ...）
 * 编码进 ContextUnit.meaning 字段的前缀，evaluator 用 decodeSemanticTags 解出。
 *
 * 格式：`[tags:<base64url(JSON)>] <plain meaning?>`
 *
 * 设计原则：
 * - evaluator 不解析 events.raw_json；只读 ContextUnit + semanticTags。
 * - 解码失败 / 无前缀 / 空字符串都不抛，返回 tags={} + plainMeaning=原串。
 */

export type SemanticTags = Record<string, string | boolean | number>;

const TAG_RE = /^\[tags:([A-Za-z0-9_-]+)\]\s?/;

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function fromBase64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function encodeSemanticTags(
  tags: SemanticTags,
  plainMeaning?: string
): string {
  const enc = toBase64Url(JSON.stringify(tags));
  const meaning = plainMeaning?.trim() ?? '';
  return meaning ? `[tags:${enc}] ${meaning}` : `[tags:${enc}]`;
}

export function decodeSemanticTags(
  meaning?: string | null
): { tags: SemanticTags; plainMeaning: string } {
  if (!meaning) return { tags: {}, plainMeaning: '' };
  const m = meaning.match(TAG_RE);
  if (!m) return { tags: {}, plainMeaning: meaning };
  try {
    const obj = JSON.parse(fromBase64Url(m[1]));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return { tags: obj as SemanticTags, plainMeaning: meaning.slice(m[0].length) };
    }
    return { tags: {}, plainMeaning: meaning };
  } catch {
    return { tags: {}, plainMeaning: meaning };
  }
}
