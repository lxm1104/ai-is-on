/**
 * MVP7 §4.3 Work Map 写入唯一入口。
 * 接收用户确认后的 WorkMapDraft，幂等落到既有 ContextUnit / Space / BoundaryRule。
 * 不新建表；多跑一次只更新 updated_at，不复制行。
 */
import { randomUUID } from 'node:crypto';
import {
  type ContextSpaceLinkRow,
  getContextSpaceByTypeName,
  getBoundaryRuleByConditionHash,
  setSetting,
  tryInsertContextSpaceLink,
} from '../db.js';
import { upsertContextUnit } from '../context/contextStore.js';
import { resolveOrCreateEntity } from '../context/entityResolver.js';
import { computeConditionHash, createRule } from '../boundary/boundaryStore.js';
import {
  createSpace,
  syncSpaceIntentFromWorkMap,
} from '../spaces/contextSpaceService.js';
import { extractKeywords } from '../spaces/keywordExtractor.js';
import type { BoundaryCondition } from '../boundary/BoundaryRule.js';
import type {
  BoundarySeedDraft,
  ProjectMapDraft,
  WorkMapDraft,
  WorkMapWriteSummary,
} from './workMapTypes.js';

function slug(text: string, max = 48): string {
  const s = text
    .trim()
    .toLowerCase()
    // 保留汉字 + 数字 + 字母；其余转 '-'
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max) || 'unnamed';
}

function ensureDocEntityLinked(spaceId: string, url: string): void {
  const ent = resolveOrCreateEntity('doc', url);
  const row: ContextSpaceLinkRow = {
    id: randomUUID(),
    space_id: spaceId,
    target_type: 'entity',
    target_id: ent.id,
    link_type: 'about',
    confidence: 1.0,
    created_at: new Date().toISOString(),
  };
  // UNIQUE(space_id, target_type, target_id) → 幂等
  tryInsertContextSpaceLink(row);
}

export function writeWorkMap(draft: WorkMapDraft): WorkMapWriteSummary {
  let unitsWritten = 0;
  let unitsUpdated = 0;
  let spacesWritten = 0;
  let rulesWritten = 0;
  let rulesTouched = 0;

  // -------- 1) Profile：角色 + 职责 --------
  if (draft.profile.roleTitle?.trim()) {
    const r = upsertContextUnit({
      kind: 'state',
      title: `我的角色：${draft.profile.roleTitle.trim()}`,
      content: [
        draft.profile.roleTitle.trim(),
        draft.profile.teamName ? `团队：${draft.profile.teamName.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      entities: [{ type: 'person', name: 'me', role: 'subject' }],
      scope: 'work',
      origin: { kind: 'system', refId: 'work_map' },
      actionability: 'record',
      confidence: 0.95,
      mergeHint: 'work_map:role:self',
    });
    r.wasUpdate ? unitsUpdated++ : unitsWritten++;
  }
  for (const resp of draft.profile.responsibilities) {
    const text = resp.trim();
    if (!text) continue;
    const r = upsertContextUnit({
      kind: 'state',
      title: text,
      content: text,
      entities: [{ type: 'person', name: 'me', role: 'subject' }],
      scope: 'work',
      origin: { kind: 'system', refId: 'work_map' },
      actionability: 'record',
      confidence: 0.9,
      mergeHint: `work_map:responsibility:${slug(text)}`,
    });
    r.wasUpdate ? unitsUpdated++ : unitsWritten++;
  }

  // -------- 2) Projects：Space + goal + commitment + doc + risk --------
  for (const p of draft.projects) {
    const ws = writeProject(p);
    spacesWritten += ws.spacesWritten;
    unitsWritten += ws.unitsWritten;
    unitsUpdated += ws.unitsUpdated;
  }

  // -------- 3) Stakeholders：relationship unit --------
  for (const s of draft.stakeholders) {
    const name = s.name.trim();
    if (!name) continue;
    const r = upsertContextUnit({
      kind: 'relationship',
      title: `协作者：${name}`,
      content: s.note?.trim() || `常协作的人：${name}`,
      entities: [{ type: 'person', name, role: 'about' }],
      scope: 'work',
      origin: { kind: 'system', refId: 'work_map' },
      actionability: 'record',
      confidence: 0.85,
      mergeHint: `work_map:relationship:${slug(name)}`,
    });
    r.wasUpdate ? unitsUpdated++ : unitsWritten++;
  }

  // -------- 4) Preferences --------
  for (const pref of draft.preferences) {
    const text = pref.trim();
    if (!text) continue;
    const r = upsertContextUnit({
      kind: 'preference',
      title: text,
      content: text,
      entities: [{ type: 'person', name: 'me', role: 'subject' }],
      scope: 'work',
      origin: { kind: 'system', refId: 'work_map' },
      actionability: 'record',
      confidence: 0.85,
      mergeHint: `work_map:preference:${slug(text)}`,
    });
    r.wasUpdate ? unitsUpdated++ : unitsWritten++;
  }

  // -------- 5) Boundaries（不希望被打扰的事） --------
  for (const b of draft.boundaries) {
    const written = writeBoundary(b);
    if (written === 'created') rulesWritten++;
    else if (written === 'touched') rulesTouched++;
  }

  const now = new Date().toISOString();
  setSetting('bootstrap_completed_at', now);

  return {
    unitsWritten,
    unitsUpdated,
    spacesWritten,
    rulesWritten,
    rulesTouched,
    bootstrapCompletedAt: now,
  };
}

function writeProject(p: ProjectMapDraft) {
  let unitsWritten = 0;
  let unitsUpdated = 0;
  let spacesWritten = 0;
  const name = p.name.trim();
  if (!name) return { unitsWritten, unitsUpdated, spacesWritten };

  // Space —— createSpace 内部已对 (type, name) 做幂等；先查一次以判断 created vs reused
  const preexisting = getContextSpaceByTypeName('project', name);
  const space = createSpace({
    type: 'project',
    name,
    description: p.description?.trim() || undefined,
  });
  if (!preexisting) spacesWritten++;

  // goals
  for (const g of p.goals) {
    const text = g.trim();
    if (!text) continue;
    const r = upsertContextUnit({
      kind: 'goal',
      title: text,
      content: text,
      entities: [{ type: 'project', name, role: 'about' }],
      scope: 'work',
      origin: { kind: 'system', refId: 'work_map' },
      actionability: 'notify',
      confidence: 0.85,
      mergeHint: `work_map:goal:${slug(name)}:${slug(text)}`,
    });
    r.wasUpdate ? unitsUpdated++ : unitsWritten++;
  }

  // commitments / deadlines
  for (const d of p.upcomingDeadlines) {
    const title = d.title.trim();
    if (!title) continue;
    const r = upsertContextUnit({
      kind: 'commitment',
      title,
      content: title,
      entities: [{ type: 'project', name, role: 'about' }],
      scope: 'work',
      origin: { kind: 'system', refId: 'work_map' },
      time: d.dueAt ? { dueAt: d.dueAt } : undefined,
      actionability: 'act',
      confidence: 0.85,
      mergeHint: `work_map:commitment:${slug(name)}:${slug(title)}`,
    });
    r.wasUpdate ? unitsUpdated++ : unitsWritten++;
  }

  // risks
  for (const risk of p.risks) {
    const text = risk.trim();
    if (!text) continue;
    const r = upsertContextUnit({
      kind: 'uncertainty',
      title: text,
      content: text,
      entities: [{ type: 'project', name, role: 'about' }],
      scope: 'work',
      origin: { kind: 'system', refId: 'work_map' },
      actionability: 'notify',
      confidence: 0.7,
      mergeHint: `work_map:risk:${slug(name)}:${slug(text)}`,
    });
    r.wasUpdate ? unitsUpdated++ : unitsWritten++;
  }

  // authoritative docs：entity{type:'doc',name:url} → link to Space
  for (const url of p.authoritativeDocs) {
    const u = url.trim();
    if (!u) continue;
    ensureDocEntityLinked(space.id, u);
  }

  // MVP13 §5.1: sync Space intent_json from Work Map
  //   - summary = description 或前两个 goal 拼起来
  //   - keywords = name + goals + risks 抽取
  //   - 用户 updatedBy='user' 时 syncSpaceIntentFromWorkMap 内部会保留用户字段
  const summary =
    p.description?.trim() ||
    p.goals.slice(0, 2).filter(Boolean).join('；') ||
    undefined;
  const keywords = extractKeywords(
    [p.name, ...p.goals, ...p.risks].filter(Boolean).join('\n'),
    12
  );
  syncSpaceIntentFromWorkMap(
    space.id,
    {
      summary,
      aliases: [p.name],
      keywords,
      workMapGoalTitles: p.goals.filter((g) => g.trim()),
      workMapRiskTitles: p.risks.filter((g) => g.trim()),
      authoritativeDocNames: p.authoritativeDocs.filter((u) => u.trim()),
    },
    {
      source: 'work_map_writer',
      projectName: name,
      origin: 'work_map',
      updatedAt: new Date().toISOString(),
    }
  );

  return { unitsWritten, unitsUpdated, spacesWritten };
}

function writeBoundary(b: BoundarySeedDraft): 'created' | 'touched' | 'skipped' {
  const cond: BoundaryCondition = {
    rawDescription: b.description.trim() || undefined,
  };
  if (b.triggerType?.length) cond.triggerType = b.triggerType;
  if (b.priorityAtMost) cond.priorityAtMost = b.priorityAtMost;
  if (b.source?.length) cond.source = b.source;

  // 至少要有一个结构化字段才落规则；否则视为 noise 不写
  const hasStructured = !!(
    cond.triggerType?.length ||
    cond.priorityAtMost ||
    cond.source?.length
  );
  if (!hasStructured) return 'skipped';

  const allowedAction = b.allowedAction ?? 'record';
  // 先用同样的 hash 函数查一次，确定 created vs touched（createRule 内部同样判一次但不告知调用者）
  const hash = computeConditionHash({
    condition: cond,
    allowedAction,
    autonomy: null,
    scopeOuter: 'work',
  });
  const before = getBoundaryRuleByConditionHash(hash);

  createRule({
    scope: 'work',
    condition: cond,
    allowedAction,
    requiresApproval: false,
    confidence: 0.75,
    source: 'manual',
    active: true,
  });

  return before ? 'touched' : 'created';
}
