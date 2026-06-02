/**
 * 构建"我"（当前用户本人）的身份画像，用于注入主聊天 agent 的 system prompt。
 *
 * 背景：opencode CLI 没有运行时注入 system prompt 的 flag，主聊天的 system prompt
 * 唯一来源是 .opencode/agent/aiisn-chat.md（启动时由 syncOpencodeAgents 物化）。
 * 之前这份 prompt 完全不含用户身份，模型读飞书日历/消息/邮件时无从判断"哪个是我"。
 *
 * 数据源（都已落库，跨重启持久）：
 *   - settings.self_person_entity_id → person entity → PersonAttributes（姓名 / open_id / 邮箱 / 部门）
 *   - Work Map 的 work_map:role:self（角色）与 work_map:responsibility:*（职责）
 *
 * 取不到任何信息时返回 ''，调用方据此决定是否拼接。
 */

import { getSetting, getContextEntityById } from '../db.js';
import { parsePersonAttributesFromRow } from './personAttributes.js';
import { listActiveContextUnits } from './contextStore.js';

const SELF_ENTITY_SETTING_KEY = 'self_person_entity_id';

export function buildSelfProfilePrompt(): string {
  const lines: string[] = [];

  // ---- 身份：来自 self person entity（飞书 profile）----
  const selfId = getSetting(SELF_ENTITY_SETTING_KEY);
  if (selfId) {
    const row = getContextEntityById(selfId);
    const attrs = row ? parsePersonAttributesFromRow(row) : null;
    const name = attrs?.larkLocalizedName ?? row?.name;
    if (name) lines.push(`- 姓名：${name}`);
    if (attrs?.larkOpenId) lines.push(`- 飞书 open_id：${attrs.larkOpenId}`);
    const email = attrs?.larkEnterpriseEmail ?? attrs?.larkEmail;
    if (email) lines.push(`- 邮箱：${email}`);
    if (attrs?.larkDepartmentName) lines.push(`- 部门：${attrs.larkDepartmentName}`);
  }

  // ---- 角色 / 职责：来自已确认的 Work Map ----
  const workMapUnits = listActiveContextUnits({ limit: 1000 }).filter(
    (u) => u.scope === 'work' && (u.mergeKey?.startsWith('work_map:') ?? false)
  );
  const role = workMapUnits.find((u) => u.mergeKey === 'work_map:role:self');
  if (role?.title) lines.push(`- 角色：${role.title}`);
  const responsibilities = workMapUnits
    .filter((u) => u.mergeKey?.startsWith('work_map:responsibility:'))
    .map((u) => u.title)
    .filter(Boolean)
    .slice(0, 5);
  if (responsibilities.length) {
    lines.push(`- 主要职责：${responsibilities.join('；')}`);
  }

  if (lines.length === 0) return '';

  return [
    '关于"我"（当前用户本人）：',
    ...lines,
    '',
    '当飞书日历 / @我消息 / 邮件 / 文档里出现上面这个人时，那就是"我"本人。',
    '判断"@我"、"谁找我"、"和我相关"以及生成回复草稿时，都以上述身份（尤其是 open_id 和邮箱）为准。',
  ].join('\n');
}
