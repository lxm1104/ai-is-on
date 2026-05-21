/**
 * sanitizeExcerpt 单元测试（§4.5 五条规则 + 边界）。
 * 运行：npx tsx --test apps/server/test/sanitize-excerpt.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeExcerpt } from '../src/bootstrap/workMapDraftPrompt.js';

test('null / empty → empty string', () => {
  assert.equal(sanitizeExcerpt(undefined), '');
  assert.equal(sanitizeExcerpt(null), '');
  assert.equal(sanitizeExcerpt(''), '');
  assert.equal(sanitizeExcerpt('   '), '');
});

test('email → <email>', () => {
  assert.equal(
    sanitizeExcerpt('请联系 alice.smith@example.com 询问'),
    '请联系 <email> 询问'
  );
});

test('url → <url>', () => {
  assert.equal(
    sanitizeExcerpt('文档见 https://example.com/foo/bar?x=1 谢谢'),
    '文档见 <url> 谢谢'
  );
  assert.equal(sanitizeExcerpt('http://lan.local/abc'), '<url>');
});

test('连续数字 ≥9 位 → 屏蔽中间', () => {
  // 11 位手机号
  assert.equal(sanitizeExcerpt('我的电话 13812345678 打来'), '我的电话 138***78 打来');
  // 9 位边界
  assert.equal(sanitizeExcerpt('编号 123456789 处理'), '编号 123***89 处理');
  // 8 位不屏蔽
  assert.equal(sanitizeExcerpt('编号 12345678 处理'), '编号 12345678 处理');
});

test('多空白折叠成单空格', () => {
  assert.equal(sanitizeExcerpt('a   b\t\tc\n\nd'), 'a b c d');
});

test('截断到 120 字符 + …', () => {
  const long = 'a'.repeat(200);
  const out = sanitizeExcerpt(long);
  assert.equal(out.length, 121); // 120 + …
  assert.ok(out.endsWith('…'));
});

test('120 字符以内不加省略号', () => {
  const exact = 'a'.repeat(120);
  assert.equal(sanitizeExcerpt(exact), exact);
  assert.equal(sanitizeExcerpt(exact).endsWith('…'), false);
});

test('email + url + 长数字组合', () => {
  const raw =
    '请发邮件到 dev@team.io 或访问 https://x.io/path 报案号 987654321 谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢';
  const out = sanitizeExcerpt(raw);
  assert.ok(out.includes('<email>'));
  assert.ok(out.includes('<url>'));
  assert.ok(out.includes('987***21'));
  assert.ok(out.length <= 121);
});

test('URL 内的 @ 不应该被当邮箱（先剥邮箱再剥 URL，按规则顺序）', () => {
  // 注意：根据规则，URL 含 @ 时邮箱正则会先吃掉一段。这是已知折中，记录在此。
  // 此 case 主要确保至少邮箱 / URL 被覆盖，不会原样泄露完整字符串。
  const raw = 'visit https://user:tok@example.com/foo';
  const out = sanitizeExcerpt(raw);
  assert.equal(out.includes('user:tok@example.com'), false);
});
