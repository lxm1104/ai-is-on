/**
 * MVP26 §4 — Matter 事务状态层领域类型 + 纯函数。
 *
 * Matter 是「这件正在发生的事」的当前状态本体：不是 raw event，不是单条 context，
 * 也不是 attention item。它把同一件事的多条 ContextUnit 证据收拢成一等实体。
 *
 * 本文件只放类型与无副作用的纯函数（canonicalize / classify / infer）。
 * SQL 在 db.ts，业务逻辑 / row↔domain 在 matterStore.ts，read model 在 matterProjection.ts。
 *
 * 详见 docs/MVP26-MVP29-Matter事务状态层技术方案.md。
 */
import { createHash } from 'node:crypto';

// ---- §4.1 Matter ----

export type MatterType =
  | 'follow_up'
  | 'discussion'
  | 'review'
  | 'delivery'
  | 'decision'
  | 'coordination'
  | 'blocker'
  | 'other';

export type MatterStatus =
  | 'open'
  | 'acknowledged'
  | 'in_progress'
  | 'waiting'
  | 'blocked'
  | 'resolved'
  | 'dropped';

export type MatterPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type MatterScope = 'personal' | 'work' | 'team';

export type Matter = {
  id: string;
  subjectId: string;
  scope: MatterScope;
  type: MatterType;
  title: string;
  canonicalKey: string;

  status: MatterStatus;
  priority: MatterPriority;

  ownerEntityId?: string | null;
  primarySpaceId?: string | null;
  dueAt?: string | null;

  currentSummary: string;
  nextAction?: string | null;

  createdFromContextUnitId: string;
  lastEvidenceContextUnitId?: string | null;
  lastEvidenceAt?: string | null;

  confidence: number;
  reopenedCount: number;
  version: number;

  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  droppedAt?: string | null;
};

// ---- §4.2 Matter Entity Link ----

export type MatterEntityRole =
  | 'owner'
  | 'requester'
  | 'executor'
  | 'reviewer'
  | 'participant'
  | 'target'
  | 'about'
  | 'container';

export type MatterEntityLink = {
  matterId: string;
  entityId: string;
  role: MatterEntityRole;
  confidence: number;
  createdAt: string;
};

// ---- §4.3 Matter Context Link ----

export type MatterContextRelation =
  | 'created_by'
  | 'evidence'
  | 'progressed_by'
  | 'resolved_by'
  | 'blocked_by'
  | 'reopened_by'
  | 'contradicted_by'
  | 'dismissed_by';

export type MatterContextEffect =
  | 'create'
  | 'progress'
  | 'resolve'
  | 'block'
  | 'reopen'
  | 'drop'
  | 'no_change';

export type MatterContextLink = {
  matterId: string;
  contextUnitId: string;
  relation: MatterContextRelation;
  effect: MatterContextEffect;
  confidence: number;
  reason: string;
  createdAt: string;
};

// ---- §4.4 Matter Transition ----

export type MatterTransition = {
  id: string;
  matterId: string;
  fromStatus: MatterStatus | null;
  toStatus: MatterStatus;
  triggerContextUnitId: string;
  effect: MatterContextEffect;
  reason: string;
  confidence: number;
  createdAt: string;
};

// ---- §4.5 Matter Observation（MVP29 才让 Triage 直接输出；此处先定义类型）----

export type MatterObservationType =
  | 'possible_new_matter'
  | 'progress'
  | 'resolution'
  | 'blocker'
  | 'reopen'
  | 'status_hint';

export type MatterObservation = {
  sourceEventId: string;
  contextUnitIds: string[];
  observationType: MatterObservationType;
  matterType: MatterType;
  title: string;
  candidateAction?: string;
  lifecycleEffect?: 'create' | 'advance' | 'resolve' | 'block' | 'reopen';
  evidence: string;
  confidence: number;
};

// ============ 纯函数 ============

function canonical(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').normalize('NFKC');
}

/**
 * §5.1 canonical_key：候选召回 + 幂等提示，**不是** DB 硬唯一约束。
 *   hash(subjectId | sorted primary entity ids | canonical action phrase)
 *
 * 注意：不要把 `type` 放进 key（type 会随证据演进），也不要直接用 ContextUnit.mergeKey
 * （一个 Matter 可能跨 commitment / action_result / decision 多类 unit）。
 */
export function computeMatterCanonicalKey(opts: {
  subjectId: string;
  primaryEntityIds: string[];
  actionPhrase: string;
}): string {
  const entitiesPart = opts.primaryEntityIds.map((s) => canonical(s)).sort().join(',');
  const raw = [opts.subjectId, entitiesPart, canonical(opts.actionPhrase)].join('|');
  return createHash('sha1').update(raw).digest('hex');
}

// §9.2：事件化措辞前缀（"我直接拉 yufan 说一下？" → "拉 yufan 说一下"）。
// 保守：只削显著口语前缀，宁可少削不要误删动作核心。
const TITLE_PREFIX_FILLERS = [
  '我准备', '我打算', '我想', '我直接', '我先', '我来', '我去', '我要', '我会', '我',
  '要不要', '是否', '是不是', '需不需要', '能不能',
  '对方刚说', '对方说', '他说', '她说', '刚刚', '刚才',
];

// §9.2：不把状态尾巴写进 canonical title（"…（已完成）" / "…，还没回"）。
const TITLE_STATUS_TAILS = [
  '已完成', '没回', '在催', '还没回', '未完成', '已处理', '已解决', '待处理',
];

/**
 * §9.2 Matter 标题 canonicalization。比 ContextUnit title 稳定：去事件化措辞、去状态尾巴，
 * 保留动作核心与关键对象。MVP26 是确定性轻规则；MVP27/29 由 LLM 进一步归一。
 */
export function canonicalizeMatterTitle(raw: string): string {
  let t = (raw ?? '').trim();
  if (!t) return t;
  // 去成对引号/书名号包裹
  t = t.replace(/^[「『“"'《【\[(]+/, '').replace(/[」』”"'》】\])？?!！。.]+$/g, '').trim();
  // 反复削前缀填充词
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of TITLE_PREFIX_FILLERS) {
      if (t.startsWith(f) && t.length > f.length) {
        t = t.slice(f.length).replace(/^[，,、:：\s]+/, '').trim();
        changed = true;
        break;
      }
    }
  }
  // 去状态尾巴（含其前的逗号/括号）
  for (const tail of TITLE_STATUS_TAILS) {
    const re = new RegExp(`[，,（(\\s]*${tail}[）)]*\\s*$`);
    t = t.replace(re, '').trim();
  }
  return t || raw.trim();
}

type Bucket = { type: MatterType; kws: string[] };
// 顺序即优先级：先命中的 bucket 胜出。
const TYPE_BUCKETS: Bucket[] = [
  { type: 'review', kws: ['评审', '审阅', '审核', 'review', '过一遍', '把关', '验收'] },
  { type: 'coordination', kws: ['排期', '约时间', '约个', '约一下', '定时间', '确认时间', '日程', '安排会议', '对齐时间', '协调', '预约'] },
  { type: 'decision', kws: ['决定', '拍板', '定方案', '选型', '定下来', '拍个板', '做决策'] },
  { type: 'delivery', kws: ['交付', '提交', '发方案', '发出', '产出', '上线', '发布', '写文档', '出文档', 'pr', '部署'] },
  { type: 'discussion', kws: ['讨论', '沟通', '同步', '对齐', '商量', '碰一下', '聊一下', '聊聊', '过一下'] },
  { type: 'blocker', kws: ['阻塞', '卡住', '卡在', 'blocked', '受阻', '依赖未', '等不到'] },
  { type: 'follow_up', kws: ['跟进', '催', '确认进度', '盯一下', '提醒', '追一下', 'follow'] },
];

/**
 * §9.1 / §11.1 Matter type 分类（轻关键词规则，默认 follow_up）。
 * 仅用于 seed / 初值；后续证据可由 reducer 调整 type（所以 type 不进 canonical_key）。
 */
export function classifyMatterType(opts: { title?: string; content?: string }): MatterType {
  const hay = `${opts.title ?? ''} ${opts.content ?? ''}`.toLowerCase();
  if (!hay.trim()) return 'follow_up';
  for (const b of TYPE_BUCKETS) {
    if (b.kws.some((k) => hay.includes(k))) return b.type;
  }
  return 'follow_up';
}

const PRIORITY_INDEX: Record<MatterPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const PRIORITY_BY_INDEX: MatterPriority[] = ['P0', 'P1', 'P2', 'P3'];

function clampPriorityIndex(i: number): number {
  return Math.max(0, Math.min(3, i));
}

/**
 * §11.1 priority 推断：dueAt 临近度 + actionability + selfRole 取最紧迫，
 * work_map_seed 上限 P2（不允许 seed 直接产出 P0/P1，避免历史种子刷高优先级）。
 * 数值越小越紧迫。
 */
export function inferMatterPriority(opts: {
  dueAt?: string | null;
  actionability?: string;
  selfRole?: 'executor' | 'requester' | 'reviewer' | 'observer' | null;
  isWorkMapSeed?: boolean;
  now: number;
}): MatterPriority {
  let idx = PRIORITY_INDEX.P2; // base

  // dueAt 临近度
  if (opts.dueAt) {
    const due = Date.parse(opts.dueAt);
    if (Number.isFinite(due)) {
      const hoursLeft = (due - opts.now) / 3_600_000;
      if (hoursLeft <= 24) idx = Math.min(idx, PRIORITY_INDEX.P0);
      else if (hoursLeft <= 72) idx = Math.min(idx, PRIORITY_INDEX.P1);
      else if (hoursLeft <= 24 * 7) idx = Math.min(idx, PRIORITY_INDEX.P2);
    }
  }

  // actionability：要动手/要问的事更紧
  if (opts.actionability === 'act' || opts.actionability === 'ask') {
    idx = Math.min(idx, PRIORITY_INDEX.P1);
  } else if (opts.actionability === 'none' || opts.actionability === 'record') {
    idx = Math.max(idx, PRIORITY_INDEX.P3);
  }

  // selfRole：我是执行方更紧迫；只是旁观则下调
  if (opts.selfRole === 'executor') idx = clampPriorityIndex(idx - 1);
  else if (opts.selfRole === 'observer') idx = clampPriorityIndex(idx + 1);

  // work_map_seed 上限 P2
  if (opts.isWorkMapSeed) idx = Math.max(idx, PRIORITY_INDEX.P2);

  return PRIORITY_BY_INDEX[clampPriorityIndex(idx)];
}

const PERSON_EXECUTOR = new Set([
  'actor', 'author', 'owner', 'assignee', 'handler', 'fixer', 'developer',
  'editor', 'tester', 'verifier', 'evaluator', 'responder', 'organizer',
  'coordinator', 'speaker',
]);
const PERSON_REQUESTER = new Set([
  'requester', 'reporter', 'proposer', 'initiator', 'source', 'target',
]);
const PERSON_REVIEWER = new Set(['reviewer', 'decision_maker', 'confirmer', 'gatekeeper']);

/**
 * 把 ContextUnit entity 的 (type, rawRole) 映射到 Matter entity role。
 * person → executor/requester/reviewer/participant；
 * 容器/对象类 entity → container/target/about。
 */
export function mapContextRoleToMatterRole(
  entityType: string,
  rawRole?: string
): MatterEntityRole {
  const t = entityType.trim().toLowerCase();
  if (t === 'chat') return 'container';
  if (t === 'doc' || t === 'task') return 'target';
  if (t === 'project' || t === 'org' || t === 'topic' || t === 'app') return 'about';
  // person（或未知 type 按人处理）
  const r = (rawRole ?? '').trim().toLowerCase();
  if (PERSON_EXECUTOR.has(r)) return 'executor';
  if (PERSON_REQUESTER.has(r)) return 'requester';
  if (PERSON_REVIEWER.has(r)) return 'reviewer';
  return 'participant';
}
