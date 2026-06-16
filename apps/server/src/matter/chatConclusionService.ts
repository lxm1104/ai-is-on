// MVP31：「提案-动作」回流通道（最小版）。
//
// 缺口（2026-06-10 质检发现）：用户点「让 AI 处理」后，AI 在聊天里得出「这事已办完/过时」
// 的结论，但结论停留在聊天里 —— 底层 Matter 仍 open，之后还会继续生成卡片催办。
//
// 闭环：topic turn_done → 该 topic 源自带 matterId 的 attention 卡 → 取最后一条 assistant
// 消息 → 小型 LLM 判定（resolved/progressed/blocked/no_change + confidence）→
//   · resolved≥0.75 → 「确认办结」提案卡 → 用户确认 = userResolveMatter；
//   · progressed/blocked≥0.6 → 「AI 已查清进展」回执卡（MVP40 同款，可「知道了/办结/继续跟进」）。
// 两类都先把对话结论本体确定性回写进 matter（证据 unit + 摘要），再升卡。
//
// 缺口修复（本轮）：原先只认 resolved≥0.75、把 progressed/blocked 全静默丢弃 —— ask_agent 是用量
// 最高的通道（实测 23 次交互/24 topic 全有产出），其有意义结论几乎 100% 不计入完成。现对齐
// investigationWriteback：自主排查与用户请求两条管线对同一类 verdict 行为一致。
//
// 设计约束：
// - 用户始终在环：本服务只产「提案」，从不直接改 matter 状态（渐进放权第一档）。
// - 反射式回执护栏：仅 matter 仍活跃、无在场办结提案、无被 dismiss 的提案史时才升卡；
//   no_change / 低置信静默丢弃（不给用户刚在聊天里亲眼看完的事重复发卡）。
import { claudeRuntime } from '../claude/ClaudeRuntime.js';
import type { RuntimeEvent } from '../claude/protocol.js';
import { db, matchMatterId } from '../db.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { getAttentionItem } from '../attention/attentionStore.js';
import { getMatterById, attachMatterContextLink, saveMatter } from './matterStore.js';
import {
  raiseMatterResolveProposal,
  raiseMatterProgressProposal,
  MATTER_RESOLVE_PROPOSAL_PREFIX,
} from './matterResolveProposal.js';
import { upsertContextUnit } from '../context/contextStore.js';
import { writeAudit } from '../boundary/auditLog.js';
import type { Matter } from './matterTypes.js';
import { broadcast } from '../ws.js';

// 办结提案门槛沿用 MVP31；进展回执门槛沿用 MVP40（investigationWriteback 同口径 0.6）。
const RESOLVE_GATE = 0.75;
const PROGRESS_GATE = 0.6;
const ASSISTANT_TEXT_CAP = 2500;
const EXTRACT_TIMEOUT_MS = 90_000;

/** 提案卡固定 hash 前缀（再导出，兼容历史引用）。 */
export { MATTER_RESOLVE_PROPOSAL_PREFIX };

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// 同一 topic 的 turn_done 可能与下一轮重叠；in-flight 去重。
const inFlightTopics = new Set<string>();

type ConclusionVerdict = {
  verdict: 'resolved' | 'progressed' | 'blocked' | 'no_change';
  confidence: number;
  evidence: string;
};

let registered = false;

export function startChatConclusionService(): void {
  if (registered) return;
  registered = true;
  claudeRuntime.on('runtime_event', (e: RuntimeEvent) => {
    if (e.type !== 'turn_done') return;
    const topicId = e.topicId;
    if (!topicId || inFlightTopics.has(topicId)) return;
    inFlightTopics.add(topicId);
    void handleTurnDone(topicId)
      .catch((err) => {
        console.warn(
          '[chat-conclusion] failed:',
          err instanceof Error ? err.message : String(err)
        );
      })
      .finally(() => {
        inFlightTopics.delete(topicId);
      });
  });
  console.log('[chat-conclusion] MVP31 回流服务已注册（turn_done → 办结提案）');
}

/** 导出仅为测试：生产路径走 startChatConclusionService 的事件订阅。 */
export async function handleTurnDone(topicId: string): Promise<void> {
  // 1) topic 必须源自 attention 卡
  const topic = db
    .prepare(
      `SELECT source_kind, source_ref_id, title FROM chat_topics WHERE id = ?`
    )
    .get(topicId) as
    | { source_kind: string; source_ref_id: string | null; title: string }
    | undefined;
  if (!topic || topic.source_kind !== 'attention' || !topic.source_ref_id) return;

  // 2) 源 attention 卡必须绑定 matter，且 matter 仍活跃
  const attn = getAttentionItem(topic.source_ref_id);
  if (!attn?.matterId) return;
  // MVP32 顺带修复：matter_id 可能是 LLM 截断前缀（MVP29D），精确查不到会静默漏提案。
  const fullMatterId = matchMatterId(attn.matterId);
  const matter = fullMatterId ? getMatterById(fullMatterId) : null;
  if (!matter || matter.status === 'resolved' || matter.status === 'dropped') return;

  // （在场提案/ dismiss 抑制的守卫移入 applyChatConclusion，便于单测且为唯一真相源。）

  // 4) 取该 turn 的最后一条 assistant 消息
  const lastAssistant = db
    .prepare(
      `SELECT text FROM runtime_messages WHERE topic_id = ? AND role = 'assistant'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(topicId) as { text: string } | undefined;
  const conclusion = lastAssistant?.text?.trim();
  if (!conclusion || conclusion.length < 40) return; // 太短不可能是结论

  // 5) LLM 判定
  const userMsg = [
    '【事项】',
    `标题：${matter.title}`,
    `状态：${matter.status}`,
    matter.currentSummary ? `当前摘要：${matter.currentSummary}` : '',
    '',
    '【AI 处理结论】',
    conclusion.slice(0, ASSISTANT_TEXT_CAP),
  ]
    .filter(Boolean)
    .join('\n');

  const shot = await runOneShot(userMsg, {
    agentName: 'aiisn-chat-conclusion',
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  const verdict = parseVerdict(shot.text);
  if (!verdict) return;

  // 6) 路由 + 回写 + 升卡（抽成可单测的纯函数，不含 LLM）。
  applyChatConclusion({ matter, verdict, topicTitle: topic.title, topicId });
}

export type ChatConclusionOutcome = 'resolve' | 'progress' | 'skip';

/**
 * 对话结论的决策核心（导出供单测；不含 LLM）：守卫 → 路由 → 确定性回写 → 升提案卡。
 * 对齐 MVP40 investigationWriteback：resolved≥0.75→办结提案；progressed/blocked≥0.6→进展回执；
 * no_change / 低置信 → skip。缺口修复：原先只认 resolved，progressed/blocked 全被静默丢弃。
 */
export function applyChatConclusion(input: {
  matter: Matter;
  verdict: ConclusionVerdict;
  topicTitle: string;
  topicId: string;
}): { outcome: ChatConclusionOutcome; raised: boolean; reason?: string } {
  const { matter, verdict, topicTitle, topicId } = input;

  // 守卫① 已有在场办结提案 → 不重复（结论已交用户裁决）。
  const hasLiveResolve = db
    .prepare(
      `SELECT 1 FROM attention_items WHERE status='live'
         AND input_hash = ? LIMIT 1`
    )
    .get(`${MATTER_RESOLVE_PROPOSAL_PREFIX}${matter.id}`);
  if (hasLiveResolve) return { outcome: 'skip', raised: false, reason: 'has_live_resolve' };

  // 守卫② dismiss 抑制：用户已亲手关掉该事项的某张提案卡 → 不再从聊天回发（防对已关闭项反射式重提）。
  const dismissed = db
    .prepare(
      `SELECT 1 FROM attention_items WHERE status='dismissed' AND matter_id = ?
         AND input_hash LIKE 'proposal:%' LIMIT 1`
    )
    .get(matter.id);
  if (dismissed) return { outcome: 'skip', raised: false, reason: 'dismissed' };

  // 路由
  const isResolve = verdict.verdict === 'resolved' && verdict.confidence >= RESOLVE_GATE;
  const isProgress =
    (verdict.verdict === 'progressed' || verdict.verdict === 'blocked') &&
    verdict.confidence >= PROGRESS_GATE;
  if (!isResolve && !isProgress) {
    if (verdict.verdict !== 'no_change') {
      console.log(
        `[chat-conclusion] matter=${matter.id.slice(0, 8)} verdict=${verdict.verdict} conf=${verdict.confidence} — 低于提案门槛，跳过`
      );
    }
    return { outcome: 'skip', raised: false, reason: 'low_conf_or_no_change' };
  }

  // 确定性回写：把对话结论本体落进 matter（证据 unit + 摘要），补「matter 看不到 AI 在聊天做了什么」。
  const summary = writeChatConclusionToMatter(matter, verdict, topicTitle, topicId);
  const proposalMatter: Matter = {
    ...matter,
    currentSummary: summary,
    version: matter.version + 1,
    updatedAt: new Date().toISOString(),
  };

  // 升卡 —— 复用共享 helper 的幂等/让位门（resolved>progress supersede、每 matter 单卡）。
  const raised = isResolve
    ? raiseMatterResolveProposal(proposalMatter, {
        why: `AI 在「${clip(topicTitle, 30)}」对话中的结论：${clip(verdict.evidence, 100)}。确认后该事项标记为已解决、相关催办卡自动清除。`,
        suggestedAction: '确认办结，或忽略保持跟进',
      })
    : raiseMatterProgressProposal(proposalMatter, {
        verdict: verdict.verdict as 'progressed' | 'blocked',
        factSummary: verdict.evidence,
        evidence: [verdict.evidence],
        confidence: verdict.confidence,
      });
  try {
    broadcast({ type: 'matter_updated', matterId: matter.id });
  } catch {}
  console.log(
    `[chat-conclusion] ${isResolve ? '办结' : '进展'}提案 matter=${matter.id.slice(0, 8)}` +
      `「${clip(matter.title, 24)}」conf=${verdict.confidence} raised=${raised}`
  );
  return { outcome: isResolve ? 'resolve' : 'progress', raised };
}

/**
 * 把对话结论本体确定性回写进 matter（镜像 investigationWriteback，但用「［AI 对话］」措辞与
 * chat:${topicId} 来源区别于只读排查的「［AI 排查］」）。返回新的 currentSummary。
 */
function writeChatConclusionToMatter(
  matter: Matter,
  verdict: ConclusionVerdict,
  topicTitle: string,
  topicId: string
): string {
  const now = new Date().toISOString();
  const fact = verdict.evidence.trim() || '（未给出明确结论）';
  let resultUnitId: string | undefined;
  try {
    const unit = upsertContextUnit({
      kind: 'action_result',
      title: clip(`AI 对话：${fact}`, 60),
      content: [
        `AI 在「${clip(topicTitle, 30)}」对话中的结论（${verdict.verdict}，置信 ${verdict.confidence.toFixed(2)}）：`,
        fact,
      ].join('\n'),
      entities: [],
      scope: matter.scope,
      origin: { kind: 'agent_run', refId: `chat:${topicId}` },
      actionability: 'record',
      confidence: verdict.confidence,
      mergeHint: `chat:${matter.id}:${clip(fact, 40)}`,
      silent: true,
    }).unit;
    resultUnitId = unit.id;
    attachMatterContextLink({
      matterId: matter.id,
      contextUnitId: unit.id,
      relation: 'evidence',
      effect: 'no_change',
      confidence: verdict.confidence,
      reason: `AI 对话结论（${verdict.verdict}）`,
      now,
    });
  } catch (err) {
    console.warn('[chat-conclusion] 回写证据 unit 失败:', err instanceof Error ? err.message : String(err));
  }

  // 剥掉旧的「［AI 对话］…｜」前缀避免多次对话无限堆叠；并进 currentSummary。
  const stripped = (matter.currentSummary || '').replace(/^［AI 对话］[^｜]*｜?/, '').trim();
  const addon = `［AI 对话］${fact}`;
  const newSummary = clip(stripped ? `${addon}｜${stripped}` : addon, 400);
  saveMatter({
    ...matter,
    currentSummary: newSummary,
    lastEvidenceContextUnitId: resultUnitId ?? matter.lastEvidenceContextUnitId,
    lastEvidenceAt: now,
    version: matter.version + 1,
    updatedAt: now,
  });
  writeAudit({
    action: 'chat_conclusion_written_back',
    reason: `AI 对话结论回写 matter（${verdict.verdict}）：${clip(fact, 60)}`,
    payload: { matterId: matter.id, verdict: verdict.verdict, confidence: verdict.confidence, resultUnitId, topicId },
  });
  return newSummary;
}

/** 导出仅为单测。 */
export function parseVerdict(text: string): ConclusionVerdict | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const obj = JSON.parse(text.slice(s, e + 1)) as Partial<ConclusionVerdict>;
    if (
      (obj.verdict === 'resolved' ||
        obj.verdict === 'progressed' ||
        obj.verdict === 'blocked' ||
        obj.verdict === 'no_change') &&
      typeof obj.confidence === 'number'
    ) {
      return {
        verdict: obj.verdict,
        confidence: obj.confidence,
        evidence: typeof obj.evidence === 'string' ? obj.evidence : '',
      };
    }
  } catch {
    // fallthrough
  }
  return null;
}
