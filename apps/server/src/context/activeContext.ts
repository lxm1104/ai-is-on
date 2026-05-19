import { listActiveContextUnits } from './contextStore.js';
import type { ContextUnit, ContextUnitKind } from './ContextUnit.js';
import { isCaringPaused } from '../caring/caringSettings.js';

/**
 * 评分 + 裁剪生成"当前活跃 context 切片"，用于注入 user message 前。
 * 方案 §4.6.1。
 */

export type ActiveContextOptions = {
  budgetTokens?: number;    // 单次注入硬上限，默认 1500
  limit?: number;           // 候选池大小
};

export type ActiveContextItem = ContextUnit & { _score: number };

export type ActiveContextSnapshot = {
  items: ActiveContextItem[];
  summary: string;
  tokenEstimate: number;
};

const DEFAULT_BUDGET = 1500;
const DEFAULT_LIMIT = 80;

// §4.6.1 weights
const W = {
  recency: 1.0,
  actionability: 0.8,
  due: 0.9,
  confidence: 0.3,
  pinned: 1.5,
};

const ACTIONABILITY_WEIGHT: Record<string, number> = {
  act: 1.0,
  ask: 0.85,
  notify: 0.6,
  record: 0.3,
  none: 0.0,
};

export function buildActiveContext(opts: ActiveContextOptions = {}): ActiveContextSnapshot {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  let candidates = listActiveContextUnits({ limit: opts.limit ?? DEFAULT_LIMIT });
  // MVP4 §6.5: paused 时把已有的 emotion / self_narrative 全部排除注入
  if (isCaringPaused()) {
    candidates = candidates.filter(
      (u) => u.kind !== 'emotion' && u.kind !== 'self_narrative'
    );
  }
  const now = Date.now();
  const scored: ActiveContextItem[] = candidates.map((u) => ({
    ...u,
    _score: score(u, now),
  }));
  scored.sort((a, b) => b._score - a._score);

  // 累加 token 上限
  const picked: ActiveContextItem[] = [];
  let used = 0;
  let truncated = 0;
  for (const u of scored) {
    const est = estimateTokens(u);
    if (used + est <= budget) {
      picked.push(u);
      used += est;
    } else {
      truncated++;
    }
  }

  const summary = renderSummary(picked, truncated);
  return { items: picked, summary, tokenEstimate: used };
}

function score(u: ContextUnit, now: number): number {
  const created = new Date(u.updatedAt).getTime();
  const ageHours = Math.max(0, (now - created) / 3600_000);
  const recency = Math.exp(-ageHours / 48);
  const actionability = ACTIONABILITY_WEIGHT[u.actionability] ?? 0;
  const due = dueProximityWeight(u, now);
  const confidence = u.confidence ?? 0.5;
  const pinned = 0; // MVP2 没引入 pinned 字段
  return (
    W.recency * recency +
    W.actionability * actionability +
    W.due * due +
    W.confidence * confidence +
    W.pinned * pinned
  );
}

function dueProximityWeight(u: ContextUnit, now: number): number {
  const due = u.time?.dueAt;
  if (!due) return 0;
  const dueT = new Date(due).getTime();
  if (Number.isNaN(dueT)) return 0;
  const diffH = (dueT - now) / 3600_000;
  if (diffH < -168) return 0;          // 逾期 1 周后衰减
  if (diffH < 0) return 0.8;            // 已经逾期，重点关注
  if (diffH <= 24) return 1.0;          // 24h 内
  if (diffH <= 72) return 0.7;
  if (diffH <= 168) return 0.4;
  return 0.1;
}

// 粗估 token：中文 ~2 char/token，英文 ~4 char/token；统一按 (title.length + content.length/2)
function estimateTokens(u: ContextUnit): number {
  const titleLen = u.title?.length ?? 0;
  const contentLen = u.content?.length ?? 0;
  return Math.ceil(titleLen + contentLen / 2);
}

// §4.6.1 summary 必须人也能读懂
function renderSummary(items: ActiveContextItem[], truncated: number): string {
  if (items.length === 0) return '';
  const groups = new Map<ContextUnitKind, ActiveContextItem[]>();
  for (const u of items) {
    const arr = groups.get(u.kind) ?? [];
    arr.push(u);
    groups.set(u.kind, arr);
  }
  const orderedKinds: ContextUnitKind[] = [
    'commitment',
    'goal',
    'intent',
    'state',
    'event',
    'uncertainty',
    'constraint',
    'decision',
    'relationship',
    'emotion',
    'memory',
    'action_result',
    'self_narrative',
    'routine',
    'preference',
  ];

  const lines: string[] = ['<active_context>'];
  for (const kind of orderedKinds) {
    const arr = groups.get(kind);
    if (!arr || arr.length === 0) continue;
    const top = arr.slice(0, 3);
    lines.push(`【${labelOf(kind)}】`);
    for (const u of top) {
      const time = u.time?.dueAt
        ? ` (due ${formatTime(u.time.dueAt)})`
        : u.time?.occurredAt
          ? ` (${formatTime(u.time.occurredAt)})`
          : '';
      const ent =
        u.entities && u.entities.length > 0
          ? ` 相关：${u.entities.slice(0, 3).map((e) => e.name).join('、')}`
          : '';
      lines.push(`- ${u.title}${time}${ent}`);
    }
  }
  if (truncated > 0) {
    lines.push(`...还有 ${truncated} 条更低相关性 context 未带入。`);
  }
  lines.push('</active_context>');
  return lines.join('\n');
}

function labelOf(kind: ContextUnitKind): string {
  switch (kind) {
    case 'commitment': return '近期承诺';
    case 'goal': return '目标';
    case 'intent': return '意图';
    case 'state': return '当前状态';
    case 'event': return '近期事件';
    case 'uncertainty': return '不确定';
    case 'constraint': return '约束';
    case 'decision': return '决策';
    case 'relationship': return '关系';
    case 'emotion': return '情绪意义';
    case 'memory': return '记忆';
    case 'action_result': return 'Agent 处理结果';
    case 'self_narrative': return '自我叙事';
    case 'routine': return '日常节奏';
    case 'preference': return '偏好';
    default: return String(kind);
  }
}

function formatTime(iso: string): string {
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
