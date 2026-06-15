// 看板标题相对日期改写（2026-06-12）：turbo 偶发在 title 用「今天/明天」，
// 跨天即错 —— 解析处确定性替换为绝对 M/D。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absolutizeRelativeDatesInTitle } from '../src/attention/titleHygiene.js';

// 固定基准：2026-06-12（周五）本地时区
const NOW = new Date(2026, 5, 12, 11, 30, 0);

test('明天 → 6/13', () => {
  assert.equal(
    absolutizeRelativeDatesInTitle('CLI POC 明天到期，确认孔恩培进展', NOW),
    'CLI POC 6/13到期，确认孔恩培进展'
  );
});

test('今天/今日 → 6/12', () => {
  assert.equal(absolutizeRelativeDatesInTitle('今天 14:00 评审会', NOW), '6/12 14:00 评审会');
  assert.equal(absolutizeRelativeDatesInTitle('今日 14:00 评审会', NOW), '6/12 14:00 评审会');
});

test('大后天先于后天匹配，不产生「大6/14」', () => {
  assert.equal(absolutizeRelativeDatesInTitle('大后天提交方案', NOW), '6/15提交方案');
  assert.equal(absolutizeRelativeDatesInTitle('后天提交方案', NOW), '6/14提交方案');
});

test('多个相对词全部替换', () => {
  assert.equal(
    absolutizeRelativeDatesInTitle('今天确认、明天发布', NOW),
    '6/12确认、6/13发布'
  );
});

test('无相对日期原样返回', () => {
  const t = '6/13 CLI POC 到期';
  assert.equal(absolutizeRelativeDatesInTitle(t, NOW), t);
});

test('跨月边界正确进位', () => {
  const eom = new Date(2026, 5, 30, 9, 0, 0); // 6/30
  assert.equal(absolutizeRelativeDatesInTitle('明天上线', eom), '7/1上线');
});

// ---------- titlesEquivalent（churn guard v2） ----------
import { titlesEquivalent } from '../src/attention/titleHygiene.js';

test('同标题不同空白/大小写 → 等价', () => {
  assert.equal(titlesEquivalent('6/12 18:00 Chatbot 双日会', '6/12  18:00 chatbot 双日会'), true);
  assert.equal(titlesEquivalent('回复陈一柯 /new 模板问题', '回复陈一柯/new模板问题'), true);
});

test('不同标题 → 不等价', () => {
  assert.equal(titlesEquivalent('回复陈一柯 /new 模板问题', '回复王爽数据查询问题'), false);
});

test('空标题不等价任何东西', () => {
  assert.equal(titlesEquivalent('', ''), false);
  assert.equal(titlesEquivalent('  ', 'x'), false);
});

// ---------- isDismissSuppressed（负反馈确定性压制，2026-06-14） ----------
import { isDismissSuppressed } from '../src/attention/titleHygiene.js';

test('同标题被 dismiss + 同优先级 → 压制（不再打扰）', () => {
  const neg = [{ title: '检查张天赐招聘日报触发器配置', priority: 'P2' }];
  assert.equal(isDismissSuppressed({ title: '检查张天赐招聘日报触发器配置', priority: 'P2' }, neg), true);
  // 标题归一化（空格/大小写）也命中
  assert.equal(isDismissSuppressed({ title: '检查张天赐招聘日报触发器配置 ', priority: 'P3' }, neg), true);
});

test('优先级明确升级（更紧急）→ 放行', () => {
  const neg = [{ title: '检查张天赐招聘日报触发器配置', priority: 'P2' }];
  assert.equal(isDismissSuppressed({ title: '检查张天赐招聘日报触发器配置', priority: 'P1' }, neg), false);
  assert.equal(isDismissSuppressed({ title: '检查张天赐招聘日报触发器配置', priority: 'P0' }, neg), false);
});

test('优先级降低或持平 → 仍压制', () => {
  const neg = [{ title: 'X 任务', priority: 'P1' }];
  assert.equal(isDismissSuppressed({ title: 'X 任务', priority: 'P1' }, neg), true);  // 持平
  assert.equal(isDismissSuppressed({ title: 'X 任务', priority: 'P3' }, neg), true);  // 更不紧急
});

test('未被 dismiss 的标题 → 不压制', () => {
  const neg = [{ title: '别的卡', priority: 'P0' }];
  assert.equal(isDismissSuppressed({ title: '一张全新的卡', priority: 'P2' }, neg), false);
  assert.equal(isDismissSuppressed({ title: '任意', priority: 'P0' }, []), false);
});
