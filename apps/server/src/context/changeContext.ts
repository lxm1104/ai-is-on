/**
 * MVP8 §5.2 ChangeContext —— ContextUnit upsert 时计算的字段级 diff。
 *
 * 关键点：
 * - **不**新建 context_deltas 表；only 挂在新生成的 trigger payload 上。
 * - before snapshot 字段严格白名单（不含 content，避免 trigger payload 膨胀）。
 * - 无 trigger 的 upsert（evaluator 没产出 draft、纯 pull 扫描）diff 直接丢失，
 *   这是 doc §5.2 "持久性边界" 明确约定。
 *
 * 持久层接口（triggers.payload_json）由 triggerEvaluator 负责 size cap，
 * 此模块只生成结构，不关心序列化大小。
 */

import type { ContextUnit, ContextUnitKind, ContextActionability, ContextStatus, ContextEntityRef, ContextTimeInfo } from './ContextUnit.js';

export type ContextUnitSnapshot = {
  kind: ContextUnitKind;
  title: string;
  meaning?: string;
  actionability: ContextActionability;
  time?: ContextTimeInfo;
  confidence: number;
  entities: Array<{ type: string; name: string; role?: string }>;
  status: ContextStatus;
  version: number;
};

export type ChangeContext = {
  isUpdate: boolean;
  changedFields: string[];
  before?: ContextUnitSnapshot;
};

const CREATED_MARKER = '*created*';

export function snapshotOf(u: ContextUnit): ContextUnitSnapshot {
  return {
    kind: u.kind,
    title: u.title,
    meaning: u.meaning,
    actionability: u.actionability,
    time: u.time,
    confidence: u.confidence,
    entities: (u.entities ?? []).map((e) => ({ type: e.type, name: e.name, role: e.role })),
    status: u.status,
    version: u.version,
  };
}

/** for the INSERT path — caller passes the freshly-inserted unit only. */
export function createdChangeContext(): ChangeContext {
  return { isUpdate: false, changedFields: [CREATED_MARKER] };
}

/**
 * Diff two snapshots on the **whitelisted** fields above.
 * - 标量字段：字符串 / 数字直接 !==
 * - time：分别比较每个子字段（occurredAt / startsAt / endsAt / dueAt / expiresAt）
 *   会输出形如 ['time.dueAt']
 * - entities：按 (type,name,role) 多重集合判等；变了就追加 'entities'
 */
export function computeChangeContext(
  before: ContextUnitSnapshot,
  after: ContextUnit
): ChangeContext {
  const changed: string[] = [];

  if (before.kind !== after.kind) changed.push('kind');
  if (before.title !== after.title) changed.push('title');
  if ((before.meaning ?? '') !== (after.meaning ?? '')) changed.push('meaning');
  if (before.actionability !== after.actionability) changed.push('actionability');
  if (before.confidence !== after.confidence) changed.push('confidence');
  if (before.status !== after.status) changed.push('status');

  for (const key of ['occurredAt', 'startsAt', 'endsAt', 'dueAt', 'expiresAt'] as const) {
    if ((before.time?.[key] ?? null) !== (after.time?.[key] ?? null)) {
      changed.push(`time.${key}`);
    }
  }

  if (!sameEntitySet(before.entities, after.entities)) changed.push('entities');

  return {
    isUpdate: true,
    changedFields: changed.length ? changed : [],
    before,
  };
}

function sameEntitySet(
  a: Array<{ type: string; name: string; role?: string }>,
  b: ContextEntityRef[] | undefined
): boolean {
  const aKey = (a ?? []).map((x) => `${x.type}|${x.name}|${x.role ?? ''}`).sort();
  const bKey = (b ?? []).map((x) => `${x.type}|${x.name}|${x.role ?? ''}`).sort();
  if (aKey.length !== bKey.length) return false;
  for (let i = 0; i < aKey.length; i++) {
    if (aKey[i] !== bKey[i]) return false;
  }
  return true;
}

/**
 * doc §5.2: triggers.payload_json 整体 4 KB cap，超出对 before.title/meaning 截断。
 * 此函数原地返回**新对象**（不修改入参）。caller 决定塞入 payload 后是否再 stringify 验大小。
 */
export function shrinkChangeContextForPayload(
  cc: ChangeContext,
  maxTitle = 60,
  maxMeaning = 120
): ChangeContext {
  if (!cc.before) return cc;
  const b = cc.before;
  return {
    ...cc,
    before: {
      ...b,
      title: b.title.length > maxTitle ? b.title.slice(0, maxTitle) + '…' : b.title,
      meaning:
        b.meaning && b.meaning.length > maxMeaning
          ? b.meaning.slice(0, maxMeaning) + '…'
          : b.meaning,
    },
  };
}
