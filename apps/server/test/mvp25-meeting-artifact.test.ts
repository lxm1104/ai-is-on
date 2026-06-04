/**
 * MVP25 unit tests: meeting-artifact ingestion pure helpers.
 *   - parseMeetingSearchItem: parse vc +search display_info → title / organizer / hasMinutes
 *   - buildContent: summary + todos → 【会议摘要】【待办】; chapters fallback; no transcript
 *
 * spawn-lark-cli functions (discoverViaVcSearch / fetchVcNotes / collect) are NOT
 * unit-tested — covered by the end-to-end replay. Same test boundary as MVP24.
 *
 * Run: npx tsx --test apps/server/test/mvp25-meeting-artifact.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMeetingSearchItem,
  buildContent,
  stripDocxXml,
  buildContentFromDocText,
} from '../src/collectors/meetingArtifactCollector.js';

test('parseMeetingSearchItem: 标准多行 display_info → title/organizer/hasMinutes', () => {
  const item = {
    id: '7647118061119835332',
    display_info:
      '对一下工具问题的视频会议\n云文档：智能纪要：会议商讨删除工具及权限修改\n今天 20:16 | 组织者：刘昕明 | ID: 162 330 681',
  };
  const r = parseMeetingSearchItem(item);
  assert.ok(r);
  assert.equal(r.meetingId, '7647118061119835332');
  assert.equal(r.title, '对一下工具问题的视频会议');
  assert.equal(r.organizer, '刘昕明');
  assert.equal(r.hasMinutes, true);
});

test('parseMeetingSearchItem: 无"智能纪要"字样 → hasMinutes=false', () => {
  const r = parseMeetingSearchItem({
    id: 'm1',
    display_info: '某个会议\n今天 10:00 | 组织者：张三 | ID: 111',
  });
  assert.ok(r);
  assert.equal(r.hasMinutes, false);
});

test('parseMeetingSearchItem: 缺 id → null', () => {
  assert.equal(parseMeetingSearchItem({ display_info: '智能纪要：x' }), null);
});

test('parseMeetingSearchItem: 全角／半角冒号都能解析组织者', () => {
  const half = parseMeetingSearchItem({ id: 'a', display_info: 't\n组织者: 李四 | ID: 1' });
  const full = parseMeetingSearchItem({ id: 'b', display_info: 't\n组织者：王五 | ID: 1' });
  assert.equal(half?.organizer, '李四');
  assert.equal(full?.organizer, '王五');
});

test('parseMeetingSearchItem: 重复性日程无组织者行 → organizer 留空、不报错', () => {
  const r = parseMeetingSearchItem({ id: 'c', display_info: 'chatbot 日会\n[重复性日程]' });
  assert.ok(r);
  assert.equal(r.title, 'chatbot 日会');
  assert.equal(r.organizer, undefined);
});

test('buildContent: summary + todos → 含【会议摘要】【待办】, hasActionItems=true', () => {
  const { text, hasActionItems } = buildContent(
    {
      summary: { content: '本次会议讨论了 CRM 场景。' },
      todos: [{ content: '整理背调规则文档 @于魄' }, { content: '研究飞书审批 skill' }],
    },
    'fallback'
  );
  assert.match(text, /【会议摘要】/);
  assert.match(text, /本次会议讨论了 CRM 场景/);
  assert.match(text, /【待办】/);
  assert.match(text, /整理背调规则文档/);
  assert.equal(hasActionItems, true);
});

test('buildContent: 仅 chapters（无 summary）→ 走【章节脉络】兜底', () => {
  const { text, hasActionItems } = buildContent(
    {
      chapters: [
        { title: 'AI CRM 场景交流', summary_content: 'xx' },
        { title: '录入效果优化', summary_content: 'yy' },
      ],
    },
    'fallback'
  );
  assert.match(text, /【章节脉络】/);
  assert.match(text, /AI CRM 场景交流/);
  assert.doesNotMatch(text, /【会议摘要】/);
  assert.equal(hasActionItems, false);
});

test('buildContent: 全空 artifacts → 返回 fallbackTitle，不含逐字稿', () => {
  const transcriptText = '贾一宁 00:00:00.000 大家好我们开始吧';
  const { text } = buildContent({}, '某会议纪要');
  assert.equal(text, '某会议纪要');
  assert.doesNotMatch(text, /00:00:00/);
  // 防御：即使 artifacts 里塞了 transcript_file，也不应进 content
  const r2 = buildContent({ transcript_file: transcriptText } as never, 'fb');
  assert.equal(r2.text, 'fb');
});

test('buildContent: null artifacts → fallbackTitle', () => {
  assert.equal(buildContent(null, 'fb').text, 'fb');
  assert.equal(buildContent(undefined, 'fb').text, 'fb');
});

test('stripDocxXml: cite→姓名、whiteboard 去除、块级标签→换行、li→"- "', () => {
  const xml =
    '<title>智能纪要：X</title><blockquote><p>参会人：' +
    '<cite type="user" user-id="ou_1" user-name="刘昕明"></cite>' +
    '<cite type="user" user-id="ou_2" user-name="黄剑成"></cite></p></blockquote>' +
    '<h1>总结</h1><whiteboard token="wb"></whiteboard><p>讨论了 A</p><li>要点一</li>';
  const t = stripDocxXml(xml);
  assert.match(t, /刘昕明、黄剑成/);
  assert.doesNotMatch(t, /<[^>]+>/); // 无残留标签
  assert.doesNotMatch(t, /whiteboard|wb/); // whiteboard 去除
  assert.match(t, /\n- 要点一/); // li → "- "
});

test('buildContentFromDocText: 保留换行、不截断到 120、识别待办', () => {
  const docText =
    '智能纪要：会议 X\n会议主题：X\n智能会议纪要由 AI 生成，可能不准确，请谨慎甄别后使用\n' +
    '总结\n' +
    '本次会议讨论了非常多的细节内容'.repeat(10) +
    '\n待办\n张三：完成 X（来自李四）\n会议最佳表现成员\n李四\n相关链接\n- 文字记录';
  const { text, hasActionItems } = buildContentFromDocText(docText, 'fb');
  assert.equal(hasActionItems, true); // 识别"待办"段
  assert.ok(text.length > 120); // 不被 sanitizeExcerpt 的 120 截断
  assert.match(text, /总结/);
  assert.match(text, /待办/);
  assert.doesNotMatch(text, /智能会议纪要由 AI 生成/); // 免责声明去除
  assert.doesNotMatch(text, /会议最佳表现成员/); // 尾部噪声去除
  assert.doesNotMatch(text, /相关链接/);
});

test('buildContentFromDocText: 长数字脱敏、空文本回退', () => {
  const { text } = buildContentFromDocText('总结\n联系电话 13800138000 请保密', 'fb');
  assert.doesNotMatch(text, /13800138000/);
  assert.equal(buildContentFromDocText('', 'fb').text, 'fb');
  assert.equal(buildContentFromDocText('   ', 'fb').text, 'fb');
});
