/**
 * MVP12 Step 1 — extractFeishuDocRefs 共享 corpus 测试。
 *
 * 同一 corpus 输入分别经过：
 *   - 后端 apps/server/src/util/extractFeishuDocRefs.ts
 *   - 前端 apps/web/src/lib/resolveNames.ts.extractSegments
 * 比较抽出的 URL 集合是否完全一致。
 *
 * 不依赖 DB（mergeDocIdentity 不被触发）。前端 cache layer 与 fetch 用 stub。
 *
 * 运行：npx tsx --test apps/server/test/extract-feishu-doc-refs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractFeishuDocUrls,
  extractFeishuToken,
} from '../src/util/extractFeishuDocRefs.js';

// 复制前端 extractSegments 时实际跑的两条 regex，与 resolveNames.ts 完全一致。
// 我们不 import 前端模块（会拉 localStorage / fetch），直接复用同一份 regex 文本。
const FE_FEISHU_HOST_RE = /(?:feishu\.cn|larksuite\.com|larkoffice\.com)/;
const FE_FEISHU_URL_RE =
  /https?:\/\/(?:[\w-]+\.)?(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/[\w/-]+\/[A-Za-z0-9_-]{8,}/g;
const FE_MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

// 与 resolveNames.ts `extractSegments` 同款 hit 收集 + 区间重叠去重。
function frontendUrls(text: string): string[] {
  if (!text) return [];
  type Hit = { start: number; end: number; url: string };
  const hits: Hit[] = [];
  for (const m of text.matchAll(FE_MD_LINK_RE)) {
    const url = m[2];
    if (!FE_FEISHU_HOST_RE.test(url)) continue;
    if (typeof m.index !== 'number') continue;
    hits.push({ start: m.index, end: m.index + m[0].length, url });
  }
  for (const m of text.matchAll(FE_FEISHU_URL_RE)) {
    const url = m[0];
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + url.length;
    if (hits.some((h) => start >= h.start && end <= h.end)) continue;
    hits.push({ start, end, url });
  }
  hits.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    out.push(h.url);
  }
  return out;
}

const CORPUS: Array<{ name: string; text: string; expected: string[] }> = [
  {
    name: 'pure markdown link',
    text: '请看 [MVP12 方案](https://www.feishu.cn/wiki/DIh1bk8bQa1EXrstYtnccUDXnCf)',
    expected: ['https://www.feishu.cn/wiki/DIh1bk8bQa1EXrstYtnccUDXnCf'],
  },
  {
    name: 'bare URL',
    text: '文档链接 https://example.feishu.cn/docs/AbCdEfGhIjKlMnOp01 谢谢',
    expected: ['https://example.feishu.cn/docs/AbCdEfGhIjKlMnOp01'],
  },
  {
    name: 'mixed: md + bare same doc → md wins, then bare deduped',
    text: '看 [spec](https://a.feishu.cn/docx/TokenAAAAAAAA) 和 https://a.feishu.cn/docx/TokenBBBBBBBB',
    expected: [
      'https://a.feishu.cn/docx/TokenAAAAAAAA',
      'https://a.feishu.cn/docx/TokenBBBBBBBB',
    ],
  },
  {
    name: 'non-feishu md link ignored',
    text: '参考 [google](https://google.com/foo/bar) 和 [base](https://www.feishu.cn/base/DIh1bk8bQa1EXrstYtnccUDXnCf)',
    expected: ['https://www.feishu.cn/base/DIh1bk8bQa1EXrstYtnccUDXnCf'],
  },
  {
    name: 'lark + larkoffice hosts',
    text: '海外 https://example.larksuite.com/wiki/ABCDEFGHIJ001 + 老域名 https://x.larkoffice.com/sheets/ZYXWVUTSRQ',
    expected: [
      'https://example.larksuite.com/wiki/ABCDEFGHIJ001',
      'https://x.larkoffice.com/sheets/ZYXWVUTSRQ',
    ],
  },
  {
    name: 'duplicate same URL appears twice → once',
    text: 'A https://feishu.cn/docx/DupTokenAAAAAA 再说 https://feishu.cn/docx/DupTokenAAAAAA',
    expected: ['https://feishu.cn/docx/DupTokenAAAAAA'],
  },
  {
    name: 'empty / no match',
    text: '今天没有任何链接',
    expected: [],
  },
  {
    // 前端 FEISHU_URL_RE 字符类不含 '?'，所以裸 URL 形式下 query 会被截掉。
    // 后端必须保持一致行为：corpus 校验 = 前端真实可见集合。
    name: 'bare URL with query: query stripped to match frontend regex',
    text: '看 https://www.feishu.cn/docx/TokenAAAA1234?from=im_share',
    expected: ['https://www.feishu.cn/docx/TokenAAAA1234'],
  },
  {
    // markdown link 用的是 MD_LINK_RE，括号内 [^)\s]+ 会吃掉 query string。
    // 这种形态前端 cache key 是含 query 的完整 URL，后端也要含。
    name: 'markdown URL with query preserved',
    text: '看 [doc](https://www.feishu.cn/docx/TokenBBBB5678?from=im_share)',
    expected: ['https://www.feishu.cn/docx/TokenBBBB5678?from=im_share'],
  },
];

test('backend extractFeishuDocUrls === frontend extractSegments URL set', () => {
  for (const c of CORPUS) {
    const back = extractFeishuDocUrls(c.text).urls;
    const front = frontendUrls(c.text);
    assert.deepEqual(back, c.expected, `back ${c.name}`);
    assert.deepEqual(front, c.expected, `front ${c.name}`);
    assert.deepEqual(back, front, `parity ${c.name}`);
  }
});

test('extractFeishuToken returns last path segment', () => {
  assert.equal(
    extractFeishuToken('https://www.feishu.cn/wiki/DIh1bk8bQa1EXrstYtnccUDXnCf'),
    'DIh1bk8bQa1EXrstYtnccUDXnCf'
  );
  assert.equal(
    extractFeishuToken('https://www.feishu.cn/docx/TokenAAAA1234?from=im_share'),
    'TokenAAAA1234'
  );
  assert.equal(extractFeishuToken('https://google.com/foo/bar'), null);
  assert.equal(extractFeishuToken('not a url'), null);
});

test('extractFeishuDocUrls — empty input', () => {
  assert.deepEqual(extractFeishuDocUrls('').urls, []);
  assert.deepEqual(extractFeishuDocUrls('').tokens, []);
});
