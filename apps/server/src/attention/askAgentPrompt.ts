// MVP14 Step 3 后修：让"让 AI 处理"带完整上下文给右侧 Claude。
// 在 attention item 上点 ask_agent / draft_reply 时被调用：
//   - 展开 signalIds 拉真实 ContextUnit（title + content 摘要 + entities + time + url）
//   - 展开 relatedSpaceIds 拉 space 名 + 该 space 的近期承诺
//   - 展开 relatedEntityIds 拉 entity name/type
//   - 把 LLM 抽 attention 时的 why / suggestedAction / recommendedAgent 一并带上
//
// 设计：在 action 触发时构建（而非 projection 时），保证读到最新的 ContextUnit。

import { getContextUnitById } from '../context/contextStore.js';
import {
  getContextEntityById,
  getContextSpace,
  listSpaceLinks,
  matchMatterId,
} from '../db.js';
import { getMatterById } from '../matter/matterStore.js';
import { matchPlaybookForMatter, renderPlaybookForPrompt } from '../playbook/playbookMatcher.js';
import { getProjectProfileForMatter } from '../investigation/projectProfile.js';
import type { AttentionItem } from './attentionTypes.js';
import type { ContextUnit } from '../context/ContextUnit.js';

const UNIT_CONTENT_TRUNC = 400;     // 单条 unit 内容最多 400 字（约 200 token）
const MAX_SIGNAL_UNITS = 6;         // 最多展开 6 条 signal unit
const MAX_SPACE_COMMITMENTS = 3;    // 每个 space 最多列 3 条关联 commitment
const MAX_RELATED_ENTITIES = 6;     // 最多展开 6 个 entity

export function buildRichAskAgentPrompt(item: AttentionItem): string {
  const parts: string[] = [];

  parts.push('我刚在 attention 面板上点了「让 AI 处理」。请基于下面这条 attention item 给出下一步建议或直接帮我做必要的查询/起草，不要执行任何对外发送或写操作。');
  parts.push('');
  parts.push(`【标题】${item.title}`);
  parts.push(`【优先级】${item.priority}`);
  parts.push(`【为什么应该关注】${item.why}`);
  if (item.suggestedAction) {
    parts.push(`【系统建议动作】${item.suggestedAction}`);
  }
  if (item.recommendedAgent) {
    parts.push(`【推荐能力】${item.recommendedAgent}（仅供参考，你按实际判断）`);
  }

  // MVP37/38 召回：这件事命中的 playbook（该这么做）+ 所属项目的排查档案（代码库/trace/术语等）。
  if (item.matterId) {
    const matter = getMatterById(matchMatterId(item.matterId) ?? item.matterId);
    if (matter) {
      const profile = getProjectProfileForMatter(matter);
      if (profile) {
        parts.push('');
        parts.push('【项目背景与做事方法（用户登记）】');
        parts.push(profile);
      }
      const pb = matchPlaybookForMatter(matter);
      if (pb) {
        parts.push('');
        parts.push(renderPlaybookForPrompt(pb));
      }
    }
  }

  // -------- 展开 signalIds：把抽象 id 还原成真实信号 --------
  const signalBlock = renderSignals(item.signalIds);
  if (signalBlock) {
    parts.push('');
    parts.push('【相关信号 / context unit】');
    parts.push(signalBlock);
  }

  // -------- 展开 relatedSpaceIds：项目 / 主题归属 --------
  const spaceBlock = renderSpaces(item.relatedSpaceIds);
  if (spaceBlock) {
    parts.push('');
    parts.push('【关联项目 / 主题】');
    parts.push(spaceBlock);
  }

  // -------- 展开 relatedEntityIds：涉及到的人 / 文档 / 项目 --------
  const entityBlock = renderEntities(item.relatedEntityIds);
  if (entityBlock) {
    parts.push('');
    parts.push('【涉及实体】');
    parts.push(entityBlock);
  }

  return parts.join('\n');
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function renderSignals(ids: string[]): string {
  if (ids.length === 0) return '';
  const lines: string[] = [];
  let seen = 0;
  for (const id of ids) {
    if (seen >= MAX_SIGNAL_UNITS) {
      lines.push(`  …（还有 ${ids.length - seen} 条未展开）`);
      break;
    }
    const u = getContextUnitById(id);
    if (!u) {
      // 不是 ContextUnit id；attentionEngine 的 prompt 允许引用 event id，但 event 也常常已被
      // ingest 写成 minimal ContextUnit（origin.kind='event'）。这里就别再多查一次 events 表了，
      // 直接标注未知。
      lines.push(`  - (id=${id.slice(0, 8)} 未找到对应 ContextUnit)`);
      seen++;
      continue;
    }
    lines.push(renderUnit(u));
    seen++;
  }
  return lines.join('\n');
}

function renderUnit(u: ContextUnit): string {
  const lines: string[] = [];
  const timeStr = formatTimeHint(u);
  lines.push(`  - [${u.kind}] ${u.title}${timeStr ? '  ' + timeStr : ''}`);
  if (u.meaning && u.meaning.length <= 120) {
    lines.push(`    含义：${u.meaning}`);
  }
  if (u.entities && u.entities.length) {
    const ents = u.entities
      .filter((e) => e.type !== 'chat' && e.type !== 'app' && e.role !== 'container')
      .slice(0, 4)
      .map((e) => `${e.type}:${e.name}`);
    if (ents.length) lines.push(`    涉及：${ents.join(', ')}`);
  }
  const content = (u.content ?? '').trim();
  if (content) {
    const truncated = content.length > UNIT_CONTENT_TRUNC
      ? content.slice(0, UNIT_CONTENT_TRUNC) + ' …'
      : content;
    // 多行内容缩进显示
    const indented = truncated
      .split('\n')
      .map((ln) => `    ${ln}`)
      .join('\n');
    lines.push(`    内容：`);
    lines.push(indented);
  }
  return lines.join('\n');
}

function formatTimeHint(u: ContextUnit): string {
  if (u.time?.dueAt) return `(due ${shortIso(u.time.dueAt)})`;
  if (u.time?.startsAt) return `(starts ${shortIso(u.time.startsAt)})`;
  if (u.time?.occurredAt) return `(${shortIso(u.time.occurredAt)})`;
  return '';
}

function shortIso(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function renderSpaces(spaceIds: string[]): string {
  if (spaceIds.length === 0) return '';
  const lines: string[] = [];
  for (const sid of spaceIds.slice(0, 4)) {
    const sp = getContextSpace(sid);
    if (!sp) {
      lines.push(`  - (space id=${sid.slice(0, 8)} 未找到)`);
      continue;
    }
    lines.push(`  - ${sp.name} (${sp.type})${sp.description ? ' — ' + sp.description : ''}`);
    // 拉该 space 的近期 commitment（最多 N 条）作为上下文
    const cmts = collectSpaceCommitmentTitles(sid, MAX_SPACE_COMMITMENTS);
    if (cmts.length) {
      lines.push(`    近期承诺：${cmts.join('；')}`);
    }
  }
  return lines.join('\n');
}

function collectSpaceCommitmentTitles(spaceId: string, max: number): string[] {
  const links = listSpaceLinks(spaceId);
  const titles: string[] = [];
  for (const l of links) {
    if (l.target_type !== 'context_unit') continue;
    if (titles.length >= max) break;
    const u = getContextUnitById(l.target_id);
    if (u && u.status === 'active' && u.kind === 'commitment') {
      titles.push(u.title);
    }
  }
  return titles;
}

function renderEntities(entityIds: string[]): string {
  if (entityIds.length === 0) return '';
  const lines: string[] = [];
  for (const eid of entityIds.slice(0, MAX_RELATED_ENTITIES)) {
    const e = getContextEntityById(eid);
    if (!e) {
      lines.push(`  - (entity id=${eid.slice(0, 8)} 未找到)`);
      continue;
    }
    lines.push(`  - ${e.type}:${e.name}`);
  }
  return lines.join('\n');
}
