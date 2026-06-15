import { useState } from 'react';
import type { CardAction, ContextUnit, SignalCard as SignalCardT } from '../types';
import {
  fetchAttentionOriginItems,
  fetchCardContext,
  postCardLarkTask,
  postActionItemsConfirm,
  postAttentionFeedback,
  postCardCorrection,
  postContextFeedback,
  previewImReply,
  postImReply,
  postCardLarkDoc,
  type AttentionConversation,
  type AttentionOriginItem,
  type AttentionSignalDetail,
  type ImReplyTarget,
  type LarkTaskCreateResult,
  type CorrectionApplyResult,
} from '../lib/api';
import { ResolvedText } from './ResolvedText';

const SOURCE_LABEL: Record<SignalCardT['source'], string> = {
  calendar: '日历',
  im: '@我',
  mail: '邮件',
  drive: '文档',
  manual: '手动',
  agent: 'Agent',
};

/**
 * 卡片来源描述：MVP3 起卡片可能来自 triage（信息流判断）或 agent_run
 * （承诺追踪 / 会前准备）。
 */
function lineageLabel(card: SignalCardT): string {
  if (card.sourceKind === 'agent_run') {
    // proposal_type 我们没在 card 里，靠 title 猜
    if (card.title.startsWith('会前准备')) return '会前准备';
    if (card.title.includes('承诺')) return '承诺追踪';
    if (card.title.startsWith('我看到了')) return '陪伴';
    if (card.title.startsWith('同步草稿')) return '同步草稿';
    return 'Agent';
  }
  if (card.sourceKind === 'manual') return '手动';
  return '信息流';
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

const REOPEN_ACTION: CardAction = { id: '__reopen', label: '标记未读', kind: 'ack' };

// MVP32：done 卡（已处理且事项办结）的撤销入口——从 Matter 层重开（__reopen 只翻卡片状态，
// 对 attention 卡不可用，且事项还 resolved 着下轮 tick 又会清卡，撤销必须落 matter 层才有意义）。
const UNDO_DONE_ACTION: CardAction = { id: 'matter_reopen', label: '撤销已处理', kind: 'matter_reopen' };

const FEEDBACK_REASONS: Array<{ id: string; label: string }> = [
  { id: 'wrong_entity', label: '人/项目认错了' },
  { id: 'wrong_priority', label: '优先级不对' },
  { id: 'wrong_meaning', label: '意思理解错了' },
  { id: 'other', label: '其他' },
];

export function SignalCardView(props: {
  card: SignalCardT;
  onAction: (
    cardId: string,
    actionId: string,
    opts?: { extraPrompt?: string; note?: string }
  ) => Promise<void>;
}) {
  const { card } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // MVP11.0-b：ask_agent / draft_reply 类 action，用户可输入额外指令覆盖默认 prompt
  const [askPrompts, setAskPrompts] = useState<Record<string, string>>({});
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxUnits, setCtxUnits] = useState<ContextUnit[] | null>(null);
  const [ctxErr, setCtxErr] = useState<string | null>(null);
  const [fbOpen, setFbOpen] = useState(false);
  const [fbSent, setFbSent] = useState<string | null>(null);
  // MVP10.0 inline correction state（针对老 cards 表的卡片）
  const [corrType, setCorrType] = useState<'wrong_priority' | 'wrong_meaning' | null>(null);
  const [corrPriority, setCorrPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2');
  const [corrLearnRule, setCorrLearnRule] = useState(false);
  const [corrMeaning, setCorrMeaning] = useState('');
  const [corrPreview, setCorrPreview] = useState<CorrectionApplyResult | null>(null);
  const [corrApplied, setCorrApplied] = useState<CorrectionApplyResult | null>(null);
  const [corrBusy, setCorrBusy] = useState(false);
  const [corrErr, setCorrErr] = useState<string | null>(null);

  // MVP34：AI 代发飞书 IM 回复（执行腿首个对外动作）。preview→展示目标→用户确认→send。
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ImReplyTarget | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const [replySent, setReplySent] = useState(false);

  // MVP14 Step 4 attention feedback state
  const isAttention = card.source === 'agent' && card.sourceKind === 'agent_run';

  async function openReply() {
    setReplyBusy(true);
    setReplyErr(null);
    try {
      const { target, suggestedText } = await previewImReply(card.id);
      setReplyTarget(target);
      setReplyText(suggestedText || card.draftReply || '');
      setReplyOpen(true);
    } catch (e) {
      // 非 IM 卡 / 会话不唯一 → 展示原因，不开编辑框
      setReplyTarget(null);
      setReplyErr(e instanceof Error ? e.message : String(e));
      setReplyOpen(true);
    } finally {
      setReplyBusy(false);
    }
  }

  async function sendReply() {
    if (!replyText.trim()) {
      setReplyErr('回复内容不能为空');
      return;
    }
    setReplyBusy(true);
    setReplyErr(null);
    try {
      await postImReply({ cardId: card.id, text: replyText.trim() });
      setReplySent(true);
      setReplyOpen(false);
    } catch (e) {
      setReplyErr(e instanceof Error ? e.message : String(e));
    } finally {
      setReplyBusy(false);
    }
  }

  // MVP35：AI 起草并新建飞书文档（内部可逆，单击确认即创建）
  const [docBusy, setDocBusy] = useState(false);
  const [docResult, setDocResult] = useState<{ url?: string; title: string } | null>(null);
  const [docErr, setDocErr] = useState<string | null>(null);
  async function makeDoc() {
    setDocBusy(true);
    setDocErr(null);
    try {
      const r = await postCardLarkDoc({ cardId: card.id });
      setDocResult({ url: r.url, title: r.title });
    } catch (e) {
      setDocErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDocBusy(false);
    }
  }
  const [attnFbBusy, setAttnFbBusy] = useState<string | null>(null);
  const [attnFbDone, setAttnFbDone] = useState<string | null>(null);
  const [attnFbErr, setAttnFbErr] = useState<string | null>(null);
  const [prefMode, setPrefMode] = useState(false);
  const [prefText, setPrefText] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskResult, setTaskResult] = useState<LarkTaskCreateResult | null>(null);
  const [moreOpen, setMoreOpen] = useState(false); // MVP23 M1.5：角度「⋯更多」溢出菜单
  const [askFocused, setAskFocused] = useState(false); // MVP23：行尾指令框聚焦→同行铺满、隐藏其它按钮
  // MVP32：「已处理」点击后展开可选处理说明输入
  const [markDoneOpen, setMarkDoneOpen] = useState(false);
  const [markDoneNote, setMarkDoneNote] = useState('');

  // "查看原始信息"：抽屉里列出 signalIds 对应的原始 events（含飞书原文 URL）
  // items 是混排块（IM conversation 合并 + 其他单条 signal，按最新动静倒序）；
  // originSignals 留着给"为什么相关"做 signalId → url 反查。
  const [originOpen, setOriginOpen] = useState(false);
  const [originItems, setOriginItems] = useState<AttentionOriginItem[] | null>(null);
  const [originSignals, setOriginSignals] = useState<AttentionSignalDetail[] | null>(null);
  const [originErr, setOriginErr] = useState<string | null>(null);
  // 单条原始信号是否展开成完整原文（默认收起，只显示一行 excerpt）
  const [originExpanded, setOriginExpanded] = useState<Record<string, boolean>>({});

  async function ensureOriginLoaded() {
    if (originItems !== null) return;
    try {
      const { items, signals } = await fetchAttentionOriginItems(card.id);
      setOriginItems(items);
      setOriginSignals(signals);
    } catch (e) {
      setOriginErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleOrigin() {
    const next = !originOpen;
    setOriginOpen(next);
    if (next) await ensureOriginLoaded();
  }

  // "为什么相关"列表项尝试匹配到 signal 的 url（两个面板共享底层 signalIds）
  function urlForUnit(unitId: string): string | undefined {
    if (!originSignals) return undefined;
    const hit = originSignals.find((d) => d.signalId === unitId);
    return hit?.url;
  }

  async function submitAttentionFeedback(
    type: 'not_relevant' | 'add_preference',
    payload: Record<string, unknown>
  ) {
    setAttnFbBusy(type);
    setAttnFbErr(null);
    try {
      const r = await postAttentionFeedback({
        attentionId: card.id,
        type,
        payload,
        confirm: true,
      });
      if (r.applied) {
        setAttnFbDone(type);
        // not_relevant 后卡片会被 dismissed，下一轮 WS attention_updated 会刷
        setTimeout(() => {
          setAttnFbDone(null);
          setFbOpen(false);
          setPrefMode(false);
          setPrefText('');
        }, 1200);
      } else {
        setAttnFbErr('未生效');
      }
    } catch (e) {
      setAttnFbErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAttnFbBusy(null);
    }
  }

  async function ensureCtxLoaded() {
    if (ctxUnits !== null) return;
    try {
      const p = await fetchCardContext(card.id);
      setCtxUnits(p.relatedUnits);
      // 同时把 originList 拉起来（attention 卡片二者共享 signalIds），
      // 让"为什么相关"列表里的每项也能直接给出原文链接。
      if (isAttention) void ensureOriginLoaded();
    } catch (e) {
      setCtxErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleCtx() {
    const next = !ctxOpen;
    setCtxOpen(next);
    if (next) await ensureCtxLoaded();
  }

  async function sendFeedback(reason: string) {
    // MVP10.0：把 wrong_priority / wrong_meaning 走 inline correction UI；
    // 其它类型仍走旧 context_feedback 记录通道（待 entity picker 完成后再迁）。
    if (reason === 'wrong_priority') {
      setCorrType('wrong_priority');
      setCorrPriority(card.priority);
      setCorrLearnRule(false);
      setCorrPreview(null);
      setCorrApplied(null);
      setCorrErr(null);
      return;
    }
    if (reason === 'wrong_meaning') {
      setCorrType('wrong_meaning');
      setCorrMeaning('');
      setCorrPreview(null);
      setCorrApplied(null);
      setCorrErr(null);
      return;
    }
    setFbSent(null);
    try {
      await postContextFeedback({ cardId: card.id, reason });
      setFbSent(reason);
      setTimeout(() => setFbOpen(false), 800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitCorrection(confirm: boolean) {
    if (!corrType) return;
    setCorrBusy(true);
    setCorrErr(null);
    try {
      let payload: Record<string, unknown> = {};
      if (corrType === 'wrong_priority') {
        payload = { newPriority: corrPriority, learnRule: corrLearnRule };
      } else if (corrType === 'wrong_meaning') {
        payload = { newMeaning: corrMeaning.trim() };
      }
      const r = await postCardCorrection({
        cardId: card.id,
        type: corrType,
        payload,
        confirm,
      });
      if (r.requiresConfirm && !r.applied) {
        setCorrPreview(r);
      } else {
        setCorrApplied(r);
        setCorrPreview(null);
        setTimeout(() => {
          setCorrType(null);
          setCorrApplied(null);
          setFbOpen(false);
        }, 1200);
      }
    } catch (e) {
      setCorrErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCorrBusy(false);
    }
  }

  function cancelCorrection() {
    setCorrType(null);
    setCorrPreview(null);
    setCorrApplied(null);
    setCorrErr(null);
  }

  async function run(actionId: string, kind: string) {
    if (kind === 'open_source' && card.sourceUrl) {
      window.open(card.sourceUrl, '_blank', 'noreferrer');
      return;
    }
    setBusy(actionId);
    setErr(null);
    try {
      // MVP11.1：会议 ask 卡片专用确认通道，绕开标准 action endpoint
      if (actionId === 'action_items_confirm_all' || actionId === 'action_items_confirm_none') {
        const accept: 'all' | 'none' =
          actionId === 'action_items_confirm_all' ? 'all' : 'none';
        await postActionItemsConfirm(card.id, accept);
        return;
      }
      const extra = askPrompts[actionId]?.trim();
      const opts =
        (kind === 'ask_agent' || kind === 'draft_reply') && extra ? { extraPrompt: extra } : undefined;
      await props.onAction(card.id, actionId, opts);
      // 触发成功后清空输入
      if (opts) {
        setAskPrompts((p) => ({ ...p, [actionId]: '' }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // MVP32：提交「已处理」（可带一句话处理说明）。后端 resolve matter + 落库 + 清同事项催办。
  async function submitMarkDone(actionId: string) {
    setBusy(actionId);
    setErr(null);
    try {
      const note = markDoneNote.trim();
      await props.onAction(card.id, actionId, note ? { note } : undefined);
      setMarkDoneOpen(false);
      setMarkDoneNote('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // MVP23 M2：opt 参数来自「拟成待办」角度（create_task 执行器）；缺省=常驻「加入任务」按钮。
  async function createLarkTask(opt?: { optionId: string; label: string }) {
    const ok = window.confirm(`确认把「${card.title}」加入飞书任务？`);
    if (!ok) return;
    setTaskBusy(true);
    setErr(null);
    setTaskResult(null);
    try {
      const result = await postCardLarkTask({ cardId: card.id, optionId: opt?.optionId });
      setTaskResult(result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskBusy(false);
    }
  }

  const isAcked =
    card.status === 'acknowledged' || card.status === 'snoozed' || card.status === 'done';

  // For acked/snoozed cards keep only "active" actions (the ones that still make
  // sense after you've already ack'd — i.e. ask agent / draft reply), and add a
  // reopen button so it's obvious the state changed and can be undone.
  // MVP23：已处理卡若有多个处理角度（opt:* 按钮），折叠成单个「再让 AI 处理」，
  //   避免在「已处理」抽屉里平铺三四个角度按钮。
  // MVP32：done（已处理且事项办结）的 attention 卡，撤销入口换成 matter 层重开。
  const ackedAskActions = (() => {
    const asks = card.actions.filter((a) => a.kind === 'ask_agent' || a.kind === 'draft_reply');
    if (asks.length <= 1) return asks;
    return [{ id: asks[0].id, label: '再让 AI 处理', kind: asks[0].kind }];
  })();
  const undoAction = card.status === 'done' && isAttention ? UNDO_DONE_ACTION : REOPEN_ACTION;
  const visibleActions: CardAction[] = isAcked
    ? [...ackedAskActions, undoAction]
    : card.actions;

  return (
    <article className={`card card--${card.priority.toLowerCase()} card--status-${card.status}`}>
      <header className="card__head">
        <span className={`badge badge--${card.priority.toLowerCase()}`}>{card.priority}</span>
        <span className="card__source">{SOURCE_LABEL[card.source]}</span>
        {lineageLabel(card) !== SOURCE_LABEL[card.source] && (
          <span className={`card__lineage card__lineage--${card.sourceKind ?? 'triage'}`}>
            {lineageLabel(card)}
          </span>
        )}
        <span className="card__time">{fmtTime(card.createdAt)}</span>
        {card.status !== 'new' && (
          <span className={`status-pill status-pill--${card.status}`}>
            {statusIcon(card.status)} {statusLabel(card.status)}
          </span>
        )}
        {card.verification?.verdict === 'confirmed' && (
          <span
            className="status-pill status-pill--verified"
            title={card.verification.evidence ? `核实依据：${card.verification.evidence}` : '系统已核实该事项确已完成'}
          >
            ✓ 已核实
          </span>
        )}
      </header>
      <h3 className="card__title">
        <ResolvedText text={card.title} />
      </h3>
      {card.summary && (
        <p className="card__summary">
          <ResolvedText text={card.summary} />
        </p>
      )}
      {card.reason && card.reason !== card.summary && (
        <p className="card__reason">
          <span className="card__label">为什么：</span>
          <ResolvedText text={card.reason} />
        </p>
      )}
      {card.suggestedAction && (
        <p className="card__suggest">
          <span className="card__label">建议：</span>
          <ResolvedText text={card.suggestedAction} />
        </p>
      )}
      {card.draftReply && (
        <details className="card__draft">
          <summary>回复草稿</summary>
          <pre>
            <ResolvedText text={card.draftReply} />
          </pre>
        </details>
      )}
      {/* MVP34：AI 代发飞书 IM 回复 —— 先看清回复给谁，确认后才真正发送 */}
      {(isAttention || card.draftReply) && !replySent && (
        <div className="card__reply">
          {!replyOpen ? (
            <button
              type="button"
              className="btn btn--card btn--reply"
              disabled={replyBusy}
              onClick={() => void openReply()}
              title="由 AI 代你在飞书发送回复（发送前你会先看到回复给谁）"
            >
              {replyBusy ? '解析中…' : '🤖 代我回复飞书'}
            </button>
          ) : (
            <div className="card__reply-panel">
              {replyErr ? (
                <p className="card__reply-err">⚠ {replyErr}</p>
              ) : (
                <>
                  <p className="card__reply-target">
                    回复给：<b>{replyTarget?.chatName || replyTarget?.chatId}</b>
                    {replyTarget?.replyToActor ? ` · 回应 ${replyTarget.replyToActor}` : ''}
                  </p>
                  {replyTarget?.replyToText && (
                    <p className="card__reply-quote">「{replyTarget.replyToText}」</p>
                  )}
                  <textarea
                    className="card__reply-text"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    rows={3}
                    placeholder="编辑要发送到飞书的回复…"
                  />
                </>
              )}
              <div className="card__reply-actions">
                {!replyErr && (
                  <button
                    type="button"
                    className="btn btn--card btn--reply-send"
                    disabled={replyBusy || !replyText.trim()}
                    onClick={() => void sendReply()}
                  >
                    {replyBusy ? '发送中…' : '确认发送'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--card"
                  disabled={replyBusy}
                  onClick={() => {
                    setReplyOpen(false);
                    setReplyErr(null);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {replySent && <p className="card__reply-sent">✓ 已通过飞书发送回复</p>}
      {/* MVP35：AI 起草并新建飞书文档（内部可逆） */}
      {isAttention && !docResult && (
        <div className="card__doc">
          <button
            type="button"
            className="btn btn--card btn--doc"
            disabled={docBusy}
            onClick={() => void makeDoc()}
            title="由 AI 把该事项整理成一份飞书文档草稿（草稿态，可改可删）"
          >
            {docBusy ? '创建中…' : '📄 起草成飞书文档'}
          </button>
          {docErr && <p className="card__reply-err">⚠ {docErr}</p>}
        </div>
      )}
      {docResult && (
        <p className="card__reply-sent">
          ✓ 已新建文档「{docResult.title}」
          {docResult.url && (
            <>
              {' '}
              <a href={docResult.url} target="_blank" rel="noreferrer">
                打开 ↗
              </a>
            </>
          )}
        </p>
      )}
      {card.sourceUrl && (
        <a className="card__link" href={card.sourceUrl} target="_blank" rel="noreferrer">
          打开原文 ↗
        </a>
      )}
      {isAttention && (
        <div className="card__origin">
          <button
            type="button"
            className="card__origin-toggle"
            onClick={() => void toggleOrigin()}
            aria-expanded={originOpen}
          >
            {originOpen ? '▾' : '▸'} 查看原始信息
            {originItems !== null && originItems.length > 0
              ? ` · ${originItems.length}`
              : ''}
          </button>
          {originOpen && (
            <div className="card__origin-body">
              {originErr && <div className="card__origin-err">{originErr}</div>}
              {originItems === null && !originErr && (
                <div className="card__origin-empty">加载中…</div>
              )}
              {originItems !== null && originItems.length === 0 && !originErr && (
                <div className="card__origin-empty">未找到关联的原始信号。</div>
              )}
              {originItems && originItems.length > 0 && (
                <div className="card__origin-list">
                  {originItems.map((item) =>
                    item.kind === 'conversation'
                      ? renderConversation(item.conversation)
                      : renderSignal(
                          item.signal,
                          !!originExpanded[item.signal.signalId],
                          (next) =>
                            setOriginExpanded((m) => ({
                              ...m,
                              [item.signal.signalId]: next,
                            }))
                        )
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="card__ctx">
        <button
          type="button"
          className="card__ctx-toggle"
          onClick={() => void toggleCtx()}
          aria-expanded={ctxOpen}
        >
          {ctxOpen ? '▾' : '▸'} 为什么相关
          {ctxUnits !== null && ctxUnits.length > 0 ? ` · ${ctxUnits.length}` : ''}
        </button>
        {ctxOpen && (
          <div className="card__ctx-body">
            {ctxErr && <div className="card__ctx-err">{ctxErr}</div>}
            {ctxUnits === null && !ctxErr && <div className="card__ctx-empty">加载中…</div>}
            {ctxUnits !== null && ctxUnits.length === 0 && !ctxErr && (
              <div className="card__ctx-empty">
                这条卡片暂未关联到额外 context（事件本身已记录）。
              </div>
            )}
            {ctxUnits && ctxUnits.length > 0 && (
              <ul className="card__ctx-list">
                {ctxUnits.map((u) => {
                  const link = urlForUnit(u.id);
                  return (
                    <li key={u.id} className="card__ctx-item">
                      <span className={`ctx-kind ctx-kind--${u.kind}`}>{u.kind}</span>
                      <span className="card__ctx-title">
                        <ResolvedText text={u.title} />
                      </span>
                      {u.time?.dueAt && (
                        <span className="card__ctx-due">due {fmtDate(u.time.dueAt)}</span>
                      )}
                      {link && (
                        <a
                          className="card__ctx-link"
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                        >
                          原文 ↗
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              type="button"
              className="card__ctx-feedback"
              onClick={() => setFbOpen((v) => !v)}
            >
              {fbOpen ? '收起' : '理解错了？'}
            </button>
            {fbOpen && !corrType && !isAttention && (
              <div className="card__ctx-fb-options">
                {fbSent ? (
                  <span className="card__ctx-fb-done">已记下，谢谢。</span>
                ) : (
                  FEEDBACK_REASONS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="btn btn--ghost card__ctx-fb-chip"
                      onClick={() => void sendFeedback(r.id)}
                    >
                      {r.label}
                    </button>
                  ))
                )}
              </div>
            )}
            {fbOpen && isAttention && (
              <div className="card__ctx-fb-options card__ctx-fb-attn">
                {attnFbDone ? (
                  <span className="card__ctx-fb-done">
                    {attnFbDone === 'not_relevant'
                      ? '已忽略并降低相关实体权重，下次 attention 会刷新。'
                      : '偏好已加入 Work Map，下次推理会带上。'}
                  </span>
                ) : !prefMode ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost card__ctx-fb-chip"
                      disabled={!!attnFbBusy}
                      onClick={() => void submitAttentionFeedback('not_relevant', {})}
                    >
                      {attnFbBusy === 'not_relevant' ? '…' : '忽略并降权'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost card__ctx-fb-chip"
                      onClick={() => setPrefMode(true)}
                    >
                      写条偏好规则…
                    </button>
                  </>
                ) : (
                  <div className="correction-inline" style={{ width: '100%' }}>
                    <textarea
                      rows={2}
                      className="correction-inline__textarea"
                      placeholder='告诉 attention 引擎你的偏好，例如"我不关心 docComment 类的提醒"'
                      value={prefText}
                      onChange={(e) => setPrefText(e.target.value)}
                    />
                    <div className="correction-inline__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!!attnFbBusy || !prefText.trim()}
                        onClick={() =>
                          void submitAttentionFeedback('add_preference', {
                            text: prefText.trim(),
                          })
                        }
                      >
                        {attnFbBusy === 'add_preference' ? '…' : '加入 Work Map'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => {
                          setPrefMode(false);
                          setPrefText('');
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
                {attnFbErr && <div className="card__ctx-fb-err">{attnFbErr}</div>}
              </div>
            )}
            {corrType === 'wrong_priority' && (
              <div className="correction-inline">
                <div className="correction-inline__row">
                  <label>实际优先级</label>
                  <select
                    value={corrPriority}
                    onChange={(e) =>
                      setCorrPriority(e.target.value as 'P0' | 'P1' | 'P2' | 'P3')
                    }
                  >
                    {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="correction-inline__check">
                  <input
                    type="checkbox"
                    checked={corrLearnRule}
                    onChange={(e) => setCorrLearnRule(e.target.checked)}
                  />
                  以后类似 {card.source} 卡片都按这个 priority 处理（学规则）
                </label>
                {corrPreview && (
                  <div className="correction-inline__preview">
                    {String((corrPreview.preview as { ruleSummary?: string }).ruleSummary ?? '')}
                    {corrPreview.tier !== 'low' && <em>（需要确认）</em>}
                  </div>
                )}
                {corrApplied && (
                  <div className="correction-inline__done">
                    已生效（tier={corrApplied.tier}, journal=
                    {corrApplied.journal?.id.slice(0, 8)}）
                  </div>
                )}
                {corrErr && <div className="correction-inline__err">{corrErr}</div>}
                <div className="correction-inline__actions">
                  {!corrPreview && !corrApplied && (
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={corrBusy}
                      onClick={() => void submitCorrection(!corrLearnRule)}
                    >
                      {corrBusy ? '…' : corrLearnRule ? '预览规则' : '应用'}
                    </button>
                  )}
                  {corrPreview && (
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={corrBusy}
                      onClick={() => void submitCorrection(true)}
                    >
                      {corrBusy ? '…' : '确认写入'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={cancelCorrection}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {corrType === 'wrong_meaning' && (
              <div className="correction-inline">
                <textarea
                  rows={2}
                  className="correction-inline__textarea"
                  placeholder="它真正的意思是…"
                  value={corrMeaning}
                  onChange={(e) => setCorrMeaning(e.target.value)}
                />
                {corrApplied && (
                  <div className="correction-inline__done">
                    已生效（journal={corrApplied.journal?.id.slice(0, 8)}）
                  </div>
                )}
                {corrErr && <div className="correction-inline__err">{corrErr}</div>}
                <div className="correction-inline__actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={corrBusy || !corrMeaning.trim()}
                    onClick={() => void submitCorrection(true)}
                  >
                    {corrBusy ? '…' : '应用'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={cancelCorrection}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <footer className={`card__actions${askFocused ? ' card__actions--asking' : ''}`}>
        <button
          type="button"
          className="btn btn--card btn--create-task"
          onClick={() => void createLarkTask()}
          disabled={!!busy || taskBusy}
          title="创建飞书任务并回写 Context"
        >
          {taskBusy ? '…' : '加入任务'}
        </button>
        {(() => {
          // MVP23：把「处理角度」按钮（id 以 opt: 开头）单独分组，
          //   前 2 个直出、第 3+ 收进「⋯更多」；非角度动作（ack/dismiss/单个 ask_agent）按原样渲染。
          const isAngle = (a: CardAction) => a.id.startsWith('opt:');
          const angles = visibleActions.filter(isAngle);
          const firstAngleIdx = visibleActions.findIndex(isAngle);
          const leading = firstAngleIdx >= 0 ? visibleActions.slice(0, firstAngleIdx) : visibleActions;
          const trailing =
            firstAngleIdx >= 0 ? visibleActions.slice(firstAngleIdx + angles.length) : [];
          const inlineAngles = angles.slice(0, 2);
          const overflowAngles = angles.slice(2);

          // 角度按钮：紧凑（无内联指令输入）。create_task 角度走建任务通道，其余走右侧 Claude。
          const renderAngle = (a: CardAction) => (
            <button
              key={a.id}
              className={`btn btn--card btn--${a.kind === 'create_task' ? 'create-task' : 'ask_agent'} btn--angle`}
              onClick={() =>
                a.kind === 'create_task'
                  ? void createLarkTask({ optionId: a.id, label: a.label })
                  : void run(a.id, a.kind)
              }
              disabled={!!busy || taskBusy}
              title={a.kind === 'create_task' ? '创建飞书任务' : '让 AI 按这个角度处理'}
            >
              {busy === a.id ? '…' : a.label}
            </button>
          );

          // MVP23：统一的「让 AI 处理」指令框，放在按钮行最后面。
          //   actionId：非角度卡用其自带的 ask_agent 动作 id；角度卡用通用 'ask_agent'。
          const plainAsk = visibleActions.find(
            (a) => a.kind === 'ask_agent' && !isAngle(a)
          );
          const askActionId = plainAsk?.id ?? 'ask_agent';
          const showEndAsk = !!plainAsk || angles.length > 0;
          // 默认：行尾一个紧凑输入框、不带按钮；聚焦后整条展开到第二行 + 右侧出现「让 AI 处理」。
          const endAsk = showEndAsk && (
            <div key="__ask" className="card__ask-end">
              <input
                type="text"
                className="card__ask-input"
                placeholder="输入指令让 AI 处理…"
                value={askPrompts[askActionId] ?? ''}
                onChange={(e) => setAskPrompts((p) => ({ ...p, [askActionId]: e.target.value }))}
                onFocus={() => setAskFocused(true)}
                onBlur={() => setAskFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void run(askActionId, 'ask_agent');
                }}
                disabled={!!busy}
              />
              {askFocused && (
                <button
                  className="btn btn--card btn--ask_agent"
                  // 防止点击按钮时 input 先 blur 导致按钮在 click 前消失
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void run(askActionId, 'ask_agent')}
                  disabled={!!busy}
                >
                  {busy === askActionId ? '…' : '让 AI 处理'}
                </button>
              )}
            </div>
          );

          // 非角度、非 ask_agent 动作：ask_agent 由行尾 endAsk 统一承载（这里跳过）；
          //   ack/dismiss/reopen 纯按钮；draft_reply 保留自己的指令输入。
          //   MVP32：mark_done 点击后展开可选处理说明输入（确认/Esc 取消）。
          const renderOther = (a: CardAction) => {
            if (a.kind === 'ask_agent' && !isAngle(a)) {
              return null; // 交给行尾 endAsk
            }
            if (a.kind === 'mark_done') {
              if (!markDoneOpen) {
                return (
                  <button
                    key={a.id}
                    className="btn btn--card btn--mark_done"
                    onClick={() => setMarkDoneOpen(true)}
                    disabled={!!busy || taskBusy}
                    title="我已在外部处理完——标记办结、记录处理结果、停掉这类催办"
                  >
                    {a.label}
                  </button>
                );
              }
              return (
                <div key={a.id} className="card__ask-inline card__markdone">
                  <input
                    type="text"
                    className="card__ask-input"
                    placeholder="（可选）一句话：怎么处理的？"
                    value={markDoneNote}
                    autoFocus
                    onChange={(e) => setMarkDoneNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) void submitMarkDone(a.id);
                      if (e.key === 'Escape') {
                        setMarkDoneOpen(false);
                        setMarkDoneNote('');
                      }
                    }}
                    disabled={!!busy}
                  />
                  <button
                    className="btn btn--card btn--mark_done"
                    onClick={() => void submitMarkDone(a.id)}
                    disabled={!!busy}
                  >
                    {busy === a.id ? '…' : '确认'}
                  </button>
                  <button
                    className="btn btn--card btn--ghost"
                    onClick={() => {
                      setMarkDoneOpen(false);
                      setMarkDoneNote('');
                    }}
                    disabled={!!busy}
                  >
                    取消
                  </button>
                </div>
              );
            }
            if (a.kind === 'draft_reply') {
              return (
                <div key={a.id} className="card__ask-inline">
                  <input
                    type="text"
                    className="card__ask-input"
                    placeholder="（可选）额外指令，留空走默认 prompt"
                    value={askPrompts[a.id] ?? ''}
                    onChange={(e) => setAskPrompts((p) => ({ ...p, [a.id]: e.target.value }))}
                    disabled={!!busy}
                  />
                  <button
                    className={`btn btn--card btn--${a.kind}`}
                    onClick={() => run(a.id, a.kind)}
                    disabled={!!busy}
                  >
                    {busy === a.id ? '…' : a.label}
                  </button>
                </div>
              );
            }
            return (
              <button
                key={a.id}
                className={`btn btn--card btn--${a.kind} ${a.id === '__reopen' ? 'btn--reopen' : ''}`}
                onClick={() => run(a.id, a.kind)}
                disabled={!!busy}
              >
                {busy === a.id ? '…' : a.label}
              </button>
            );
          };

          return (
            <>
              {leading.map(renderOther)}
              {inlineAngles.map(renderAngle)}
              {overflowAngles.length > 0 && (
                <div className="card__more">
                  <button
                    type="button"
                    className="btn btn--card btn--more"
                    onClick={() => setMoreOpen((v) => !v)}
                    disabled={!!busy || taskBusy}
                  >
                    ⋯更多
                  </button>
                  {moreOpen && (
                    <div className="card__more-menu" onMouseLeave={() => setMoreOpen(false)}>
                      {overflowAngles.map(renderAngle)}
                    </div>
                  )}
                </div>
              )}
              {trailing.map(renderOther)}
              {/* 行尾统一指令框：默认紧凑无按钮，聚焦后第二行展开 + 「让 AI 处理」 */}
              {endAsk}
            </>
          );
        })()}
      </footer>
      {taskResult && (
        <div className="card__task-done">
          已加入飞书任务
          {taskResult.task.url && (
            <>
              {' · '}
              <a href={taskResult.task.url} target="_blank" rel="noreferrer">
                打开任务 ↗
              </a>
            </>
          )}
        </div>
      )}
      {err && <div className="card__err">{err}</div>}
    </article>
  );
}

function fmtDate(iso: string) {
  try {
    const d = new Date(iso);
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

function statusLabel(s: SignalCardT['status']) {
  switch (s) {
    case 'acknowledged':
      return '已查看';
    case 'snoozed':
      return '稍后处理';
    case 'dismissed':
      return '已忽略';
    case 'done':
      return '已完成';
    default:
      return '';
  }
}

function statusIcon(s: SignalCardT['status']) {
  switch (s) {
    case 'acknowledged':
      return '✓';
    case 'snoozed':
      return '🌙';
    case 'dismissed':
      return '×';
    case 'done':
      return '✓';
    default:
      return '';
  }
}

/**
 * "查看原始信息"：把 imCollector 写入的 "HH:MM" 时间字符串渲染到分钟。
 * events.text 里的时间一般是 "2026-05-27 21:07" 这种本地化字符串，已是分钟级，
 * 这里只截尾 5 位（"21:07"）。无法解析时原样回退。
 */
function fmtConvTime(t: string): string {
  // 已经是 "HH:MM" 形式
  if (/^\d{2}:\d{2}$/.test(t)) return t;
  // "YYYY-MM-DD HH:MM" 形式
  const m = t.match(/(\d{2}:\d{2})(?::\d{2})?$/);
  if (m) return m[1];
  return t;
}

function renderConversation(conv: AttentionConversation) {
  return (
    <div key={conv.groupKey} className="card__origin-conv">
      <div className="card__origin-conv-head">
        <span className="ctx-kind ctx-kind--event">{conv.source}</span>
        <span className="card__origin-title">{conv.chatName}</span>
        <span className="card__origin-time">{conv.messages.length} 条</span>
        {conv.url ? (
          <a
            className="card__origin-link"
            href={conv.url}
            target="_blank"
            rel="noreferrer"
          >
            打开聊天 ↗
          </a>
        ) : (
          <span className="card__origin-nourl">无原文链接</span>
        )}
      </div>
      <ul className="card__origin-conv-msgs">
        {conv.messages.map((m, i) => (
          <li
            key={`${conv.groupKey}:${i}`}
            className={`card__origin-msg${m.isFocus ? ' card__origin-msg--focus' : ''}`}
          >
            <span className="card__origin-msg-time">{fmtConvTime(m.time)}</span>
            <span className="card__origin-msg-sender">{m.sender}</span>
            <span className="card__origin-msg-content">{m.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderSignal(
  d: AttentionSignalDetail,
  expanded: boolean,
  setExpanded: (next: boolean) => void
) {
  const hasMore = !!d.text && d.text.length > (d.excerpt?.length ?? 0);
  return (
    <div key={d.signalId} className="card__origin-item">
      <div className="card__origin-row">
        <span className={`ctx-kind ctx-kind--${d.kind}`}>{d.source ?? d.kind}</span>
        <span className="card__origin-title">{d.title}</span>
        {d.occurredAt && (
          <span className="card__origin-time">
            {(() => {
              try {
                return new Date(d.occurredAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                });
              } catch {
                return '';
              }
            })()}
          </span>
        )}
        {d.url ? (
          <a className="card__origin-link" href={d.url} target="_blank" rel="noreferrer">
            打开 ↗
          </a>
        ) : (
          <span className="card__origin-nourl">无原文链接</span>
        )}
      </div>
      {d.excerpt && !expanded && (
        <div className="card__origin-excerpt-row">
          <span className="card__origin-excerpt">{d.excerpt}</span>
          {hasMore && (
            <button
              type="button"
              className="card__origin-more"
              onClick={() => setExpanded(true)}
            >
              展开
            </button>
          )}
        </div>
      )}
      {expanded && d.text && (
        <div className="card__origin-full-row">
          <pre className="card__origin-full">{d.text}</pre>
          <button
            type="button"
            className="card__origin-more"
            onClick={() => setExpanded(false)}
          >
            收起
          </button>
        </div>
      )}
    </div>
  );
}
