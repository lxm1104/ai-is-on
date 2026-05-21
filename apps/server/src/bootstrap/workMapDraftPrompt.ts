/**
 * MVP7.1 §4.5 LLM Work Map 草稿 prompt + 输入脱敏。
 *
 * 输出 schema 与 WorkMapDraft 完全对齐，便于直接喂回 confirm 接口。
 * sanitizeExcerpt 是导出函数 —— 单元测试覆盖 5 条规则。
 */

import type { WorkMapDraft } from './workMapTypes.js';

/**
 * 草稿 LLM 的 system prompt。
 * - 强制 JSON-only 输出，否则前端 / eval 都没法解析。
 * - 不要联系外部人；不要把"我担心的事"写成"应该做"。
 * - 草稿应**保守**：宁缺勿伪造；missingInfo 不在本 schema，因为草稿就是 draft，
 *   用户会在 panel 里手动改。
 */
export const WORK_MAP_DRAFT_SYSTEM_PROMPT = `你正在协助用户构建他工作场景的"世界模型"（Work Map），用于让后续 Agent 在判断时有正确的坐标系。
你会收到：
1. seedText：用户用 5-8 行自然语言写的自我描述（可能为空）
2. 一组从用户近期 work-scope context 中按价值排序、字段已脱敏的条目
3. 已有 Work Map 当前快照（增量草稿时）

任务：输出一份 WorkMapDraft（单个 JSON 对象，UTF-8，无 Markdown），覆盖以下结构：

{
  "profile": {
    "roleTitle": "他的角色 / 头衔（可缺省）",
    "teamName": "团队名（可缺省）",
    "responsibilities": ["职责，每条短句，2-6 条"]
  },
  "projects": [
    {
      "name": "项目名（必填，要与 entity 命名一致）",
      "description": "一句话项目简述",
      "goals": ["1-3 条本周/本阶段目标"],
      "authoritativeDocs": ["权威文档 URL（如果上下文里直接给了）"],
      "upcomingDeadlines": [{ "title": "承诺/deadline 名", "dueAt": "ISO 时间，可缺省" }],
      "risks": ["1-3 条用户担心的事"]
    }
  ],
  "stakeholders": [{ "name": "人名", "note": "如何协作（可缺省）" }],
  "preferences": ["工作偏好，3-6 条"],
  "boundaries": [
    {
      "description": "人话描述：'不希望被打扰的事'",
      "triggerType": ["commitment_due"],
      "priorityAtMost": "P2",
      "source": ["im"],
      "allowedAction": "record"
    }
  ]
}

铁律：
- 输出必须是单个合法 JSON 对象，不要 Markdown，不要解释，不要 \`\`\`fences。
- 不要主动给外部人发任何东西；boundaries 是用来"过滤打扰"，不是用来"对外执行"。
- 宁缺勿伪造：上下文里看不出来的字段直接留空数组 / 不写。
- 项目名要复用 context 中出现的实体名（避免后续 entity 重复）。
- triggerType 允许值：commitment_due, meeting_prepare, context_conflict, goal_blocked, low_noise_batch, check_in_due, context_divergence。
- priorityAtMost 允许值：P0, P1, P2, P3。
- source 允许值：calendar, im, mail, drive, manual, agent。
- allowedAction 允许值：record, notify, draft, execute_reversible。`;

// ---------------- sanitizeExcerpt（§4.5） ----------------

/**
 * 把 context_unit.content 裁成 ≤120 字的脱敏摘要，仅用于 LLM 输入辅助。
 *
 * 规则顺序很关键 —— 先剥邮箱 / URL（它们含 @ 和 / 容易被后续规则误吃），
 * 再屏蔽长数字，最后压空白和截断。
 */
export function sanitizeExcerpt(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw);
  // 1. email
  s = s.replace(/\S+@\S+\.\S+/g, '<email>');
  // 2. URL
  s = s.replace(/https?:\/\/\S+/g, '<url>');
  // 3. 连续数字 ≥9 位（手机号/单号/银行卡）
  s = s.replace(/\d{9,}/g, (m) => m.slice(0, 3) + '***' + m.slice(-2));
  // 4. 多空白合一（含换行 / tab）
  s = s.replace(/\s+/g, ' ').trim();
  // 5. 截断到 120 字符；保留可读性，末尾 …
  if (s.length > 120) s = s.slice(0, 120) + '…';
  return s;
}

// ---------------- parseDraft（容错解析 LLM 输出） ----------------

import { jsonrepair } from 'jsonrepair';

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(jsonrepair(s));
  } catch {}
  return null;
}

function extractJson(s: string): unknown {
  const whole = tryParse(s);
  if (whole !== null) return whole;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1]);
    if (inside !== null) return inside;
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = tryParse(s.slice(first, last + 1));
    if (sliced !== null) return sliced;
  }
  return null;
}

const ALLOWED_TRIGGER_TYPES = new Set([
  'commitment_due',
  'meeting_prepare',
  'context_conflict',
  'goal_blocked',
  'low_noise_batch',
  'check_in_due',
  'context_divergence',
]);
const ALLOWED_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const ALLOWED_SOURCES = new Set(['calendar', 'im', 'mail', 'drive', 'manual', 'agent']);
const ALLOWED_ACTIONS = new Set(['record', 'notify', 'draft', 'execute_reversible']);

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

export function parseWorkMapDraft(text: string): WorkMapDraft {
  const obj = (extractJson(text) ?? {}) as Record<string, unknown>;
  const profile = (obj.profile ?? {}) as Record<string, unknown>;
  const projects = Array.isArray(obj.projects) ? (obj.projects as Record<string, unknown>[]) : [];
  const stakeholders = Array.isArray(obj.stakeholders)
    ? (obj.stakeholders as Record<string, unknown>[])
    : [];
  const boundaries = Array.isArray(obj.boundaries)
    ? (obj.boundaries as Record<string, unknown>[])
    : [];

  return {
    profile: {
      roleTitle: typeof profile.roleTitle === 'string' ? profile.roleTitle : undefined,
      teamName: typeof profile.teamName === 'string' ? profile.teamName : undefined,
      responsibilities: strArr(profile.responsibilities),
    },
    projects: projects.map((p) => ({
      name: typeof p.name === 'string' ? p.name : '',
      description: typeof p.description === 'string' ? p.description : undefined,
      goals: strArr(p.goals),
      authoritativeDocs: strArr(p.authoritativeDocs),
      upcomingDeadlines: Array.isArray(p.upcomingDeadlines)
        ? (p.upcomingDeadlines as Record<string, unknown>[])
            .filter((d) => typeof d?.title === 'string')
            .map((d) => ({
              title: d.title as string,
              dueAt: typeof d.dueAt === 'string' ? (d.dueAt as string) : undefined,
            }))
        : [],
      risks: strArr(p.risks),
    })),
    stakeholders: stakeholders
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: s.name as string,
        note: typeof s.note === 'string' ? (s.note as string) : undefined,
      })),
    preferences: strArr(obj.preferences),
    boundaries: boundaries
      .filter((b) => typeof b.description === 'string')
      .map((b) => {
        const tt = strArr(b.triggerType).filter((t) =>
          ALLOWED_TRIGGER_TYPES.has(t)
        ) as WorkMapDraft['boundaries'][number]['triggerType'];
        const src = strArr(b.source).filter((s) =>
          ALLOWED_SOURCES.has(s)
        ) as WorkMapDraft['boundaries'][number]['source'];
        const prio = typeof b.priorityAtMost === 'string' && ALLOWED_PRIORITIES.has(b.priorityAtMost)
          ? (b.priorityAtMost as WorkMapDraft['boundaries'][number]['priorityAtMost'])
          : undefined;
        const act = typeof b.allowedAction === 'string' && ALLOWED_ACTIONS.has(b.allowedAction)
          ? (b.allowedAction as WorkMapDraft['boundaries'][number]['allowedAction'])
          : undefined;
        return {
          description: b.description as string,
          triggerType: tt && tt.length ? tt : undefined,
          source: src && src.length ? src : undefined,
          priorityAtMost: prio,
          allowedAction: act,
        };
      }),
  };
}
