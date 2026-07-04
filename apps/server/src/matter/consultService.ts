/**
 * MVP79 —— 小助理拦一道：有人在 IM 里请你办事 → AI 先收集必要信息，来飞书征询你怎么处理 → 按你的意见办。
 *
 * 用户原话（2026-07-03）："他看到我在IM里面有人问我的时候，可以主动站出来问问我可以怎么处理，然后他直接帮我处理…
 * 先帮我拦一道，帮我收集一些必要的信息…如果有不太了解的，应该问我，或者确认一下。"
 *
 * 触发窄门（降噪三闸）：
 *  1) 角色门：新建 matter 且「具名他人是 requester + 你是 executor」——即有人当面请你办事（needHelpClassifier
 *     owned_by_other 的镜像判定：那边是"我委派他人"，这边是"他人委派我"）。
 *  2) 终身一次 / matter（幂等键不带日期）。
 *  3) 日配额 consultDailyMax（默认 3），配额外的事项仍走既有卡片/日报，不丢。
 *
 * 处理选项（全部复用已验证的机器）：
 *  1 起草回复 → aiisn-push 全 deny 沙箱起草话术 → DM 草稿（你确认后自己发，绝不代发——公司红线）；
 *  2 先查清楚 → 指示落为 card_action 证据 + kickInvestigation（KEYSTONE 路径）；
 *  3 不用管   → userDropMatter（可用「恢复 <关键词>」找回）；
 *  自由文本   → 作为你的处理指示回填，AI 照办。每次选择都落 consult_choice 审计——习惯学习的原料。
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { writeAudit } from '../boundary/auditLog.js';
import {
  countAuditActionSince,
  getContextEntityById,
  getMatterOriginHint,
  getMatterOriginUrl,
  wasNotifyPushed,
} from '../db.js';
import { getMatterById, listMatterEntities, attachMatterContextLink } from './matterStore.js';
import { userDropMatter } from './matterActions.js';
import { getSelfEntityIds, isSelf, isNamedOtherPerson } from '../investigation/needHelpClassifier.js';
import { makeIdempotencyKey, sendBotDm } from '../lark/larkNotifyService.js';
import { upsertContextUnit } from '../context/contextStore.js';
import { kickInvestigation } from '../investigation/investigationKick.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import type { Matter } from './matterTypes.js';

function clip(s: string, n: number): string {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function startOfTodayIso(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** 角色门：具名他人 requester（1~2 个，≥3 视为群发不打扰）+ 我是 executor。命中返回 requester 名单。 */
export function consultRequestersFor(matter: Matter): Array<{ id: string; name: string }> | null {
  const links = listMatterEntities(matter.id);
  const selfSet = getSelfEntityIds();
  const iAmExecutor =
    links.some((l) => l.role === 'executor' && isSelf(l.entityId, selfSet)) ||
    (!!matter.ownerEntityId && isSelf(matter.ownerEntityId, selfSet)); // reducer：selfRole=executor 才置 owner
  if (!iAmExecutor) return null;
  const requesters = links
    .filter((l) => l.role === 'requester')
    .map((l) => getContextEntityById(l.entityId))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .filter((e) => isNamedOtherPerson({ id: e.id, name: e.name, type: e.type }, selfSet))
    .map((e) => ({ id: e.id, name: e.name }));
  if (requesters.length < 1 || requesters.length > 2) return null;
  return requesters;
}

/**
 * 新 matter 创建后调用（fire-and-forget）：过三闸 → 收集必要信息 → 飞书征询。
 * 永不 throw（征询失败绝不影响 matter 创建主链路）。
 */
export async function maybeConsultOnMatterCreated(matter: Matter): Promise<boolean> {
  try {
    if (!config.consultEnabled) return false;
    const requesters = consultRequestersFor(matter);
    if (!requesters) return false;
    const idempotencyKey = makeIdempotencyKey('aiisn', 'consult', matter.id); // 不带日期=终身一次
    if (wasNotifyPushed(idempotencyKey)) return false;
    if (countAuditActionSince('consult_asked', startOfTodayIso()) >= config.consultDailyMax) return false;
    const names = requesters.map((r) => r.name).join('、');
    const origin = getMatterOriginHint(matter.id);
    const originUrl = getMatterOriginUrl(matter.id); // 用户原话：能用链接定位就直接发链接
    const md = [
      `**🤝 有人找你：${names} 请你处理一件事**`,
      `「${clip(matter.title, 60)}」`,
      origin ? `来源：${clip(origin, 260)}` : '',
      originUrl ? `📍 [直达原会话](${originUrl})` : '',
      matter.currentSummary ? `我已了解到：${clip(matter.currentSummary, 200)}` : '',
      '',
      '怎么处理？直接回复：',
      '1 我来起草回复（草稿给你，你确认后自己发）',
      '2 先替你查清楚再汇报',
      '3 不用管（归档，可恢复）',
      '或直接说你的想法，我照办。',
    ]
      .filter((l) => l !== '')
      .join('\n')
      .replace('怎么处理？直接回复：', '\n怎么处理？直接回复：'); // 选项前空一行
    const ok = await sendBotDm(md, { kind: 'consult', refId: matter.id, idempotencyKey });
    if (ok) {
      writeAudit({
        action: 'consult_asked',
        reason: `${names} 请你处理「${clip(matter.title, 50)}」，已收集来源信息并发飞书征询`,
        payload: { matterId: matter.id, requesters: requesters.map((r) => r.name) },
      });
    }
    return ok;
  } catch (err) {
    console.warn('[consult] failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export type ConsultChoice = 'draft' | 'investigate' | 'ignore' | 'instruct';

export function classifyConsultChoice(text: string): ConsultChoice {
  const t = text.trim();
  if (/^1$|^(帮我)?起草|^回复他|^回复她|^拟(个)?回复/.test(t)) return 'draft';
  if (/^2$|^先查|^查清楚|^查一下|^先看看/.test(t)) return 'investigate';
  if (/^3$|^忽略$|^不用管|^不管$|^算了$/.test(t)) return 'ignore';
  return 'instruct';
}

/** 把你的指示落为该 matter 的外部证据（KEYSTONE 路径）并近实时触发重查。 */
function backfillInstruction(matter: Matter, instruction: string): void {
  const now = new Date().toISOString();
  const { unit } = upsertContextUnit({
    kind: 'action_result',
    origin: { kind: 'card_action', refId: `consult:${matter.id}` },
    title: `处理指示：${matter.title.slice(0, 60)}`,
    content: instruction,
    scope: 'work',
    actionability: 'record',
    confidence: 1,
    mergeHint: `consult-instruct:${matter.id}:${now}:${randomUUID().slice(0, 8)}`,
    silent: true,
  });
  attachMatterContextLink({
    matterId: matter.id,
    contextUnitId: unit.id,
    relation: 'evidence',
    effect: 'no_change',
    confidence: 1,
    reason: '用户在飞书征询中给出的处理指示',
    now,
  });
  kickInvestigation();
}

type OneShotFn = (
  msg: string,
  opts: { agentName: 'aiisn-push'; lane?: 'main' | 'investigation'; timeoutMs?: number }
) => Promise<{ text: string }>;

/** 选 1：aiisn-push 沙箱起草回复话术 → DM 草稿。async（LLM 慢），调用方先 ack「正在起草」。 */
export async function draftReplyForMatter(
  matter: Matter,
  deps: { oneShot?: OneShotFn } = {}
): Promise<boolean> {
  const oneShot = deps.oneShot ?? ((msg, opts) => runOneShot(msg, opts));
  const requesters = consultRequestersFor(matter);
  const names = requesters?.map((r) => r.name).join('、') || '对方';
  const origin = getMatterOriginHint(matter.id);
  const directive = [
    `有人在飞书找用户办事，请替用户起草回复话术。`,
    `事项「${matter.title}」`,
    origin ? `来源与原话：${origin.slice(0, 400)}` : '',
    matter.currentSummary ? `已知情况：${matter.currentSummary.slice(0, 400)}` : '',
    `请起草可直接发给 ${names} 的回复（口吻自然像同事说话，别写模板）；若信息不足以回复，改为列出需要用户补充的问题清单。只起草，绝不声称已发已办。`,
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const shot = await oneShot(directive, { agentName: 'aiisn-push', lane: 'investigation', timeoutMs: 240_000 });
    const body = (shot.text ?? '').trim();
    if (!body) return false;
    // 草稿要用户自己去原会话发——把直达链接一并给他，省去翻找会话这步
    const originUrl = getMatterOriginUrl(matter.id);
    return await sendBotDm(
      `**📝 回复草稿**——「${clip(matter.title, 40)}」（复制后你来发，我不代发）：\n\n${body.slice(0, 2500)}${originUrl ? `\n\n📍 [直达原会话去发送](${originUrl})` : ''}`,
      {
        kind: 'consult',
        refId: matter.id,
        idempotencyKey: makeIdempotencyKey('aiisn', 'consult-draft', matter.id, String(Date.now() % 1_000_000)),
      }
    );
  } catch (err) {
    console.warn('[consult] draft failed:', err instanceof Error ? err.message : String(err));
    await sendBotDm(`起草「${clip(matter.title, 40)}」的回复失败了（模型超时/出错），稍后可再回「1」重试。`, {
      kind: 'consult',
      refId: matter.id,
      idempotencyKey: makeIdempotencyKey('aiisn', 'consult-draft-fail', matter.id, String(Date.now() % 1_000_000)),
    });
    return false;
  }
}

/** 用户对征询的答复（来自 botReplyLoop）。ack 由调用方提供（线程回复）。 */
export async function handleConsultChoice(
  matterId: string,
  rawText: string,
  ack: (md: string) => Promise<void>,
  deps: { oneShot?: OneShotFn } = {}
): Promise<ConsultChoice | 'gone'> {
  const matter = getMatterById(matterId);
  if (!matter || matter.status === 'resolved' || matter.status === 'dropped') {
    await ack('这件事已办结/归档，不用处理了。');
    return 'gone';
  }
  const choice = classifyConsultChoice(rawText);
  writeAudit({
    action: 'consult_choice',
    reason: `你对「${clip(matter.title, 40)}」的处理选择：${choice}`,
    payload: { matterId, choice, text: clip(rawText, 80) }, // 习惯学习原料：谁请办的什么事→你怎么处理
  });
  if (choice === 'draft') {
    await ack(`收到，正在给「${clip(matter.title, 30)}」起草回复草稿，弄好发你（你确认后自己发，我不代发）。`);
    void draftReplyForMatter(matter, deps).catch(() => {});
  } else if (choice === 'investigate') {
    backfillInstruction(matter, '用户指示：先替我查清楚这件事再来汇报。');
    await ack('好，我先去查，有结论会来汇报。');
  } else if (choice === 'ignore') {
    userDropMatter(matter.id, '你在飞书征询中指示不用管');
    await ack('好，已归档不再跟进。误操作 7 天内可回复「恢复 <标题关键词>」找回。');
  } else {
    backfillInstruction(matter, `用户处理指示：${rawText.trim().slice(0, 500)}`);
    await ack('收到，照这个办。需要你确认的我会再来问。');
  }
  return choice;
}
