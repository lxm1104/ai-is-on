import { createHash } from 'node:crypto';

// 与方案 §2.2 对齐。这是工程化子集，§2.1 的 12 类是产品语言。
export type ContextUnitKind =
  | 'event'
  | 'state'
  | 'goal'
  | 'intent'
  | 'commitment'
  | 'relationship'
  | 'memory'
  | 'emotion'
  | 'constraint'
  | 'uncertainty'
  | 'action_result'
  | 'self_narrative'   // MVP4 预留
  | 'routine'          // MVP4 预留
  | 'decision'         // MVP5 预留
  | 'preference';      // MVP4 预留

export type ContextScope = 'personal' | 'work' | 'team';

export type ContextOriginKind =
  | 'event'
  | 'chat'
  | 'card_action'
  | 'agent_run'
  | 'manual'
  | 'system';

export type ContextActionability = 'none' | 'record' | 'notify' | 'ask' | 'act';

export type ContextStatus = 'active' | 'archived' | 'superseded';

export type ContextEntityRef = {
  type: string;        // 'person' | 'project' | 'doc' | 'task' | 'org' | ...
  name: string;
  aliases?: string[];
  confidence?: number;
  role?: string;       // 'subject' | 'actor' | 'target' | 'about'
};

export type ContextRelationRef = {
  fromEntityName: string;
  toEntityName: string;
  relationType: string;   // 'owns' | 'reports_to' | 'depends_on' | ...
};

export type ContextTimeInfo = {
  occurredAt?: string;
  startsAt?: string;
  endsAt?: string;
  dueAt?: string;
  expiresAt?: string;
};

export type ContextEmotion = {
  valence?: 'positive' | 'neutral' | 'negative' | 'mixed';
  labels?: string[];
  intensity?: number;
};

// LLM 输出的"草稿"，subject/scope/origin 由后端补
export type ContextUnitDraft = {
  kind: ContextUnitKind;
  title: string;
  content: string;
  entities?: ContextEntityRef[];
  relations?: ContextRelationRef[];
  time?: ContextTimeInfo;
  emotion?: ContextEmotion | null;
  meaning?: string | null;
  actionability?: ContextActionability;
  confidence?: number;
  mergeHint?: string;           // LLM 给的 canonical 短语
};

// 完整内存表示
export type ContextUnit = {
  id: string;
  subjectId: string;
  scope: ContextScope;
  origin: {
    kind: ContextOriginKind;
    refId: string;
  };
  kind: ContextUnitKind;
  title: string;
  content: string;
  entities: ContextEntityRef[];
  relations: ContextRelationRef[];
  time?: ContextTimeInfo;
  emotion?: ContextEmotion;
  meaning?: string;
  actionability: ContextActionability;
  confidence: number;
  mergeKey?: string;
  version: number;
  supersedes?: string[];
  status: ContextStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

// §4.3.1 默认 expires
export function defaultExpiresAt(
  kind: ContextUnitKind,
  createdAt: string,
  dueAt?: string
): string | null {
  const created = new Date(createdAt);
  const addDays = (base: Date, days: number) =>
    new Date(base.getTime() + days * 86400_000).toISOString();
  switch (kind) {
    case 'event':
      return addDays(created, 30);
    case 'commitment':
      return dueAt ? addDays(new Date(dueAt), 14) : addDays(created, 60);
    case 'goal':
    case 'intent':
      return addDays(created, 90);
    case 'emotion':
    case 'self_narrative':
      return addDays(created, 14);
    case 'uncertainty':
    case 'action_result':
      return addDays(created, 30);
    case 'state':
    case 'relationship':
    case 'routine':
    case 'memory':
    case 'constraint':
    case 'preference':
    case 'decision':
      return null; // 长期事实
    default:
      return null;
  }
}

// §4.3.2 mergeKey 计算
export function computeMergeKey(opts: {
  subjectId: string;
  kind: ContextUnitKind;
  primaryEntityIds: string[];
  salientPhrase: string;
}): string {
  const entitiesPart = opts.primaryEntityIds
    .map((s) => canonical(s))
    .sort()
    .join(',');
  const raw = [
    opts.subjectId,
    opts.kind,
    entitiesPart,
    canonical(opts.salientPhrase),
  ].join('|');
  return createHash('sha1').update(raw).digest('hex');
}

function canonical(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .normalize('NFKC');
}

// 当某条 ContextUnit 没有 LLM mergeHint 时（如 collector 直写的 event），fallback 用 origin 唯一标识
export function fallbackSalientPhrase(
  kind: ContextUnitKind,
  origin: { kind: ContextOriginKind; refId: string }
): string {
  if (kind === 'event') return `event:${origin.refId}`;
  return `${origin.kind}:${origin.refId}`;
}
