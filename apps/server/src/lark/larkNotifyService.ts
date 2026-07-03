/**
 * MVP77 —— 把结果送到你面前：飞书 bot DM 推送通道。
 *
 * 实测断裂（2026-07-03 取证）：用户 7 天没打开 web UI（attention_interactions 最后一条 06-26），
 * 期间 AI 自主办结 13 件、产出 7 件方案/建议、升过求助卡——用户全部没看到，大量卡片静默过期
 * （needhelp 历史 2/3 过期、dangling 近 7 天过期 20 张）。「感觉不到 AI 做了事」的第一根因是投递通道，
 * 不是产出能力。
 *
 * 通道合规：bot 以**自己身份**给用户本人发 DM（appId cli_aa8b19e7057a1bb7 的 bot 身份，2026-07-03 实测可发）。
 * 这不是被公司策略永久禁止的「以用户身份代发给他人」（larkImReplyService 已下线的那种）——不冒充、只送达本人。
 *
 * 推送纪律（MVP75 第一性原理，铁律）：只推两类——①结果（已办结/修复方案/建议）②需要你的（求助/确认）。
 * 过程（progress 进展回执、dangling 高频提醒、查了没查到）绝不即时推，进每日汇报兜底或不出现。
 * 防骚扰：即时推送日配额（notifyInstantDailyMax）+ 每 (kind, matter, 天) 幂等一条；日报每天至多一条。
 *
 * armed 模式：只有服务进程启动时显式 armNotifyService() 后才真发。测试/脚本 import 升卡函数时天然 no-op，
 * 现有测试零改动也绝不会误发真实 DM（确定性保证，不靠环境变量猜测）。
 */
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { runLarkCliJson } from '../util/larkCli.js';
import { getMyOpenId } from '../util/identity.js';
import { writeAudit } from '../boundary/auditLog.js';
import {
  countNotifyPushedSince,
  getSetting,
  listAiResolvedMattersSince,
  listProposalItemsByPrefixes,
  setSetting,
  wasNotifyPushed,
} from '../db.js';

export type NotifyKind =
  | 'needhelp'
  | 'artifact'
  | 'reco'
  | 'autoresolved'
  | 'resolve_proposal'
  | 'daily_report'
  | 'sweep_list' // MVP78 积压大扫除清单（一天至多一批）
  | 'reply_ack'; // MVP78 对用户回复的应答（用户主动发起，不设量）

/** 不占即时推送日配额的类型：日报/清单每天至多一条自限；ack 是对用户动作的应答，限了会静默失联。 */
const QUOTA_EXEMPT_KINDS: ReadonlySet<NotifyKind> = new Set(['daily_report', 'sweep_list', 'reply_ack']);

// 前缀常量定义在 matter/matterResolveProposal.ts；这里用字面量映射避免环形依赖
// （前缀是落库 input_hash 的稳定契约，不会静默漂移）。progress / dangling 故意不在表里：不即时推。
const KIND_BY_PREFIX: Record<string, NotifyKind> = {
  'proposal:matter-needhelp:': 'needhelp',
  'proposal:matter-artifact:': 'artifact',
  'proposal:matter-reco:': 'reco',
  'proposal:matter-autoresolved:': 'autoresolved',
  'proposal:matter-resolve:': 'resolve_proposal',
};

const HEADLINE: Record<Exclude<NotifyKind, 'daily_report' | 'sweep_list' | 'reply_ack'>, string> = {
  needhelp: '🙋 需要你补一手，AI 就能接着办',
  artifact: '🔧 AI 已定位根因，替你起草了修复方案',
  reco: '💡 AI 给你一条建议',
  autoresolved: '✅ AI 已替你办结一件事',
  resolve_proposal: '✋ 一件事疑似已完成，等你确认办结',
};

type SendFn = (args: string[]) => Promise<Record<string, unknown>>;
let sender: SendFn = (args) => runLarkCliJson(args);
let openIdProvider: () => Promise<string> = getMyOpenId;
let armed = false;

/** 服务进程启动时调用；未 arm 时一切推送都是 no-op（测试安全的确定性保证）。 */
export function armNotifyService(): void {
  armed = true;
}
export function __setNotifySenderForTest(fn: SendFn): void {
  sender = fn;
  openIdProvider = async () => 'ou_test_self'; // 测试不真跑 lark-cli auth status
  armed = true;
}
export function __disarmNotifyServiceForTest(): void {
  armed = false;
  sender = (args) => runLarkCliJson(args);
  openIdProvider = getMyOpenId;
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * 飞书消息幂等键（uuid 字段）**硬限 50 字符**，超长整个请求被拒（99992402 field validation failed，
 * 2026-07-03 实测：reply_ack 键 51 字符导致回执静默丢失、用户以为"没反应"）。
 * 超长时确定性哈希截短——同输入永远同键，两层幂等（audit + 飞书服务端）都不受影响。
 */
export function makeIdempotencyKey(...parts: string[]): string {
  const raw = parts.join(':');
  if (raw.length <= 50) return raw;
  const digest = createHash('sha1').update(raw).digest('hex').slice(0, 32);
  return `aiisn-${digest}`; // 38 字符，恒 ≤50
}
function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}
function localDateStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function startOfTodayIso(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * 发一条 bot DM 给用户本人。永不 throw（通道故障绝不能破坏升卡/办结等业务路径），失败落 notify_failed 审计。
 * 幂等：audit notify_pushed 里的 idempotencyKey 为准（第一层）；lark-cli --idempotency-key 服务端去重（第二层）。
 */
export async function sendBotDm(
  markdown: string,
  opts: { kind: NotifyKind; refId?: string; idempotencyKey: string; now?: Date }
): Promise<boolean> {
  if (!armed || !config.notifyPushEnabled) return false;
  // 防御性归一：任何调用方传超长键都在这里截短（audit 与飞书两层用同一个归一后键）。
  const idempotencyKey = makeIdempotencyKey(opts.idempotencyKey);
  try {
    if (wasNotifyPushed(idempotencyKey)) return false;
    if (
      !QUOTA_EXEMPT_KINDS.has(opts.kind) &&
      countNotifyPushedSince(startOfTodayIso(opts.now)) >= config.notifyInstantDailyMax
    ) {
      // 配额满不丢内容：这些卡仍在面板里，且每日工作汇报会兜底汇总。
      console.log(`[notify] 即时推送日配额已满，跳过（进日报兜底）：${opts.kind} ${opts.refId ?? ''}`);
      return false;
    }
    const openId = await openIdProvider();
    const resp = await sender([
      'im',
      '+messages-send',
      '--as',
      'bot',
      '--user-id',
      openId,
      '--markdown',
      markdown,
      '--idempotency-key',
      idempotencyKey,
    ]);
    const data = (resp as { data?: { message_id?: string; chat_id?: string } })?.data;
    const messageId = data?.message_id;
    // MVP78：留住 bot P2P 会话 id——回复闭环（botReplyLoop）靠它拉用户的回复。
    if (data?.chat_id) setSetting('notify:botChatId', data.chat_id);
    writeAudit({
      action: 'notify_pushed',
      reason: `已推送到你的飞书（${opts.kind}）：${clip(firstLine(markdown).replace(/\*/g, ''), 80)}`,
      payload: { kind: opts.kind, refId: opts.refId, idempotencyKey, messageId },
    });
    return true;
  } catch (err) {
    writeAudit({
      action: 'notify_failed',
      reason: `飞书推送失败（${opts.kind}）：${clip((err as Error)?.message ?? String(err), 200)}`,
      payload: { kind: opts.kind, refId: opts.refId, idempotencyKey },
    });
    return false;
  }
}

/**
 * 升卡钩子：结果/需要你 类 proposal 卡升起时即时推送到飞书。fire-and-forget，同步返回。
 * 每 (kind, matter, 天) 至多一条——同日幂等重升/更新不重复打扰。
 */
export function notifyProposalRaised(input: {
  prefix: string;
  matterId: string;
  title: string;
  why: string;
}): void {
  const kind = KIND_BY_PREFIX[input.prefix];
  if (!kind || !(kind in HEADLINE)) return;
  const md = [
    `**${HEADLINE[kind as keyof typeof HEADLINE]}**`,
    input.title,
    clip(input.why, 600),
    `👉 打开 AI is ON 处理：${config.webOrigin}`,
  ]
    .filter((l) => l && l.trim().length > 0)
    .join('\n');
  void sendBotDm(md, {
    kind,
    refId: input.matterId,
    // matterId 是 36 位 uuid，裸拼会超飞书 50 字符键上限（实测被整单拒收）——必须走 makeIdempotencyKey。
    idempotencyKey: makeIdempotencyKey('aiisn', kind, input.matterId, localDateStr()),
  });
}

/**
 * 每日工作汇报正文（近 24h）。三段式，全是「结果/需要你」：
 * ① AI 自主办结了哪几件（含依据）② 产出了哪些方案/建议 ③ 现在还需要你的哪几件（live 口径）。
 * 全空返回 null（不发空日报刷存在感）。
 */
export function composeDailyWorkReport(now = new Date()): string | null {
  const sinceIso = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const resolved = listAiResolvedMattersSince(sinceIso, 8);
  const produced = listProposalItemsByPrefixes(
    ['proposal:matter-artifact:', 'proposal:matter-reco:'],
    { sinceIso, limit: 8 }
  );
  const needYou = listProposalItemsByPrefixes(
    ['proposal:matter-needhelp:', 'proposal:matter-dangling:', 'proposal:matter-resolve:'],
    { limit: 8 } // live 口径：现在仍等你的，而非窗口内升过的
  );
  if (resolved.length === 0 && produced.length === 0 && needYou.length === 0) return null;
  const lines: string[] = [`**📋 AI is ON 工作汇报（${localDateStr(now)}）**`];
  if (resolved.length) {
    lines.push('', `**✅ 已替你办结 ${resolved.length} 件**`);
    for (const r of resolved) lines.push(`· ${clip(r.title, 40)}——${clip(firstLine(r.reason), 70)}`);
  }
  if (produced.length) {
    lines.push('', `**🔧💡 替你产出方案/建议 ${produced.length} 件**`);
    for (const p of produced) lines.push(`· ${clip(p.title, 64)}`);
  }
  if (needYou.length) {
    lines.push('', `**🙋 需要你 ${needYou.length} 件**（补一手 AI 就能接着办）`);
    for (const p of needYou) lines.push(`· ${clip(p.title, 40)}——${clip(firstLine(p.why), 70)}`);
  }
  lines.push('', `👉 打开处理：${config.webOrigin}`);
  return lines.join('\n');
}

export type DailyReportOutcome = 'sent' | 'empty' | 'disabled' | 'failed' | 'already_sent';

const LAST_REPORT_KEY = 'notify:lastDailyReportDate';

/** 发今天的工作汇报（幂等：每天至多一条；空日只标记不发）。失败不标记，由 job 带退避重试。 */
export async function sendDailyWorkReportNow(now = new Date()): Promise<DailyReportOutcome> {
  if (!config.notifyDailyReportEnabled || !config.notifyPushEnabled || !armed) return 'disabled';
  const today = localDateStr(now);
  if (getSetting(LAST_REPORT_KEY) === today) return 'already_sent';
  const idempotencyKey = `aiisn:daily_report:${today}`;
  if (wasNotifyPushed(idempotencyKey)) {
    // 崩溃恢复：audit 已留底但 setting 没写上——补标记，不重发。
    setSetting(LAST_REPORT_KEY, today);
    return 'already_sent';
  }
  const md = composeDailyWorkReport(now);
  if (!md) {
    setSetting(LAST_REPORT_KEY, today); // 空日标记，当天不再反复查
    return 'empty';
  }
  const ok = await sendBotDm(md, { kind: 'daily_report', idempotencyKey, now });
  if (!ok) return 'failed';
  setSetting(LAST_REPORT_KEY, today);
  return 'sent';
}

let reportTimer: NodeJS.Timeout | undefined;
let lastAttemptMs = 0;

/** 每分钟检查：到点（notifyDailyReportHour 后）且今天没发过 → 发。失败 10 分钟退避重试，不刷审计。 */
export function startDailyWorkReportJob(): void {
  if (reportTimer) return;
  reportTimer = setInterval(() => {
    const now = new Date();
    if (now.getHours() < config.notifyDailyReportHour) return;
    if (Date.now() - lastAttemptMs < 10 * 60_000) return;
    lastAttemptMs = Date.now();
    void sendDailyWorkReportNow(now)
      .then((r) => {
        if (r === 'sent') console.log('[notify] 每日工作汇报已推送到你的飞书');
      })
      .catch(() => {});
  }, 60_000);
  console.log(`[notify] 每日工作汇报任务已启动（每天 ${config.notifyDailyReportHour}:00 后推送）`);
}

export function stopDailyWorkReportJob(): void {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = undefined;
  }
}
