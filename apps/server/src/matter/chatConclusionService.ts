// MVP31：「提案-动作」回流通道（最小版）。
//
// 缺口（2026-06-10 质检发现）：用户点「让 AI 处理」后，AI 在聊天里得出「这事已办完/过时」
// 的结论，但结论停留在聊天里 —— 底层 Matter 仍 open，之后还会继续生成卡片催办。
//
// 闭环：topic turn_done → 该 topic 源自带 matterId 的 attention 卡 → 取最后一条 assistant
// 消息 → 小型 LLM 判定（resolved/progressed/blocked/no_change + confidence）→ 高置信
// resolved 时升一张「确认办结」提案卡 → 用户点确认 = userResolveMatter → 下一轮 attention
// tick 经 markAttentionItemsSupersededForResolvedMatters 自动清掉该事项全部催办卡。
//
// 设计约束：
// - 用户始终在环：本服务只产「提案」，从不直接改 matter 状态（渐进放权第一档）。
// - 判定失败/低置信 → 静默放弃（提案卡宁缺毋滥）。
import { randomUUID } from 'node:crypto';
import { claudeRuntime } from '../claude/ClaudeRuntime.js';
import type { RuntimeEvent } from '../claude/protocol.js';
import { db, matchMatterId } from '../db.js';
import { runOneShot } from '../triage/backgroundRuntime.js';
import { getAttentionItem, insertAttentionItem } from '../attention/attentionStore.js';
import { getMatterById } from './matterStore.js';
import { broadcast } from '../ws.js';

const CONFIDENCE_GATE = 0.75;
const ASSISTANT_TEXT_CAP = 2500;
const EXTRACT_TIMEOUT_MS = 90_000;

/** 提案卡固定 hash 前缀：去重 + projection/action 层识别提案卡。 */
export const MATTER_RESOLVE_PROPOSAL_PREFIX = 'proposal:matter-resolve:';

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

  // 3) 已有同事项的在场提案 → 不重复
  const proposalHash = `${MATTER_RESOLVE_PROPOSAL_PREFIX}${matter.id}`;
  const existing = db
    .prepare(`SELECT 1 FROM attention_items WHERE status='live' AND input_hash = ? LIMIT 1`)
    .get(proposalHash);
  if (existing) return;

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
  if (verdict.verdict !== 'resolved' || verdict.confidence < CONFIDENCE_GATE) {
    if (verdict.verdict !== 'no_change') {
      console.log(
        `[chat-conclusion] matter=${matter.id.slice(0, 8)} verdict=${verdict.verdict} conf=${verdict.confidence} — 低于提案门槛，跳过`
      );
    }
    return;
  }

  // 6) 升提案卡（确定性插入，走既有投影/动作通道）
  const now = new Date().toISOString();
  insertAttentionItem({
    id: randomUUID(),
    generation: 0, // 系统提案不参与 LLM 代际
    llmRunId: null,
    inputHash: proposalHash,
    llmItem: {
      priority: 'P1',
      title: `确认办结：${matter.title.slice(0, 40)}`,
      why:
        `AI 在「${topic.title.slice(0, 30)}」对话中的结论：${verdict.evidence.slice(0, 100)}` +
        '。确认后该事项将标记为已解决，相关催办卡自动清除。',
      suggestedAction: '确认办结，或忽略保持跟进',
      signalIds: [],
      matterId: matter.id,
    },
    now,
  });
  broadcast({ type: 'attention_updated', generation: 0, itemsEmitted: 1 });
  console.log(
    `[chat-conclusion] 升办结提案：matter=${matter.id.slice(0, 8)}「${matter.title.slice(0, 24)}」conf=${verdict.confidence}`
  );
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
