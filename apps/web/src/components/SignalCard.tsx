import { useState } from 'react';
import type { CardAction, ContextUnit, SignalCard as SignalCardT } from '../types';
import {
  fetchAttentionSignals,
  fetchCardContext,
  postCardLarkTask,
  postActionItemsConfirm,
  postAttentionFeedback,
  postCardCorrection,
  postContextFeedback,
  type AttentionSignalDetail,
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
    opts?: { extraPrompt?: string }
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

  // MVP14 Step 4 attention feedback state
  const isAttention = card.source === 'agent' && card.sourceKind === 'agent_run';
  const [attnFbBusy, setAttnFbBusy] = useState<string | null>(null);
  const [attnFbDone, setAttnFbDone] = useState<string | null>(null);
  const [attnFbErr, setAttnFbErr] = useState<string | null>(null);
  const [prefMode, setPrefMode] = useState(false);
  const [prefText, setPrefText] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskResult, setTaskResult] = useState<LarkTaskCreateResult | null>(null);

  // "查看原始信息"：抽屉里列出 signalIds 对应的原始 events（含飞书原文 URL）
  const [originOpen, setOriginOpen] = useState(false);
  const [originList, setOriginList] = useState<AttentionSignalDetail[] | null>(null);
  const [originErr, setOriginErr] = useState<string | null>(null);

  async function ensureOriginLoaded() {
    if (originList !== null) return;
    try {
      const list = await fetchAttentionSignals(card.id);
      setOriginList(list);
    } catch (e) {
      setOriginErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleOrigin() {
    const next = !originOpen;
    setOriginOpen(next);
    if (next) await ensureOriginLoaded();
  }

  // "为什么相关"列表项尝试匹配到 originList 里的 url（两个面板共享底层 signalIds）
  function urlForUnit(unitId: string): string | undefined {
    if (!originList) return undefined;
    const hit = originList.find((d) => d.signalId === unitId);
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

  async function createLarkTask() {
    const ok = window.confirm(`确认把「${card.title}」加入飞书任务？`);
    if (!ok) return;
    setTaskBusy(true);
    setErr(null);
    setTaskResult(null);
    try {
      const result = await postCardLarkTask({ cardId: card.id });
      setTaskResult(result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskBusy(false);
    }
  }

  const isAcked = card.status === 'acknowledged' || card.status === 'snoozed';

  // For acked/snoozed cards keep only "active" actions (the ones that still make
  // sense after you've already ack'd — i.e. ask agent / draft reply), and add a
  // reopen button so it's obvious the state changed and can be undone.
  const visibleActions: CardAction[] = isAcked
    ? [
        ...card.actions.filter((a) => a.kind === 'ask_agent' || a.kind === 'draft_reply'),
        REOPEN_ACTION,
      ]
    : card.actions;

  return (
    <article className={`card card--${card.priority.toLowerCase()} card--status-${card.status}`}>
      <header className="card__head">
        <span className={`badge badge--${card.priority.toLowerCase()}`}>{card.priority}</span>
        <span className="card__source">{SOURCE_LABEL[card.source]}</span>
        <span className={`card__lineage card__lineage--${card.sourceKind ?? 'triage'}`}>
          {lineageLabel(card)}
        </span>
        <span className="card__time">{fmtTime(card.createdAt)}</span>
        {card.status !== 'new' && (
          <span className={`status-pill status-pill--${card.status}`}>
            {statusIcon(card.status)} {statusLabel(card.status)}
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
      {card.reason && (
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
            {originList !== null && originList.length > 0 ? ` · ${originList.length}` : ''}
          </button>
          {originOpen && (
            <div className="card__origin-body">
              {originErr && <div className="card__origin-err">{originErr}</div>}
              {originList === null && !originErr && (
                <div className="card__origin-empty">加载中…</div>
              )}
              {originList !== null && originList.length === 0 && !originErr && (
                <div className="card__origin-empty">未找到关联的原始信号。</div>
              )}
              {originList && originList.length > 0 && (
                <ul className="card__origin-list">
                  {originList.map((d) => (
                    <li key={d.signalId} className="card__origin-item">
                      <span className={`ctx-kind ctx-kind--${d.kind}`}>
                        {d.source ?? d.kind}
                      </span>
                      <span className="card__origin-title">{d.title}</span>
                      {d.occurredAt && (
                        <span className="card__origin-time">{fmtTime(d.occurredAt)}</span>
                      )}
                      {d.url ? (
                        <a
                          className="card__origin-link"
                          href={d.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          打开 ↗
                        </a>
                      ) : (
                        <span className="card__origin-nourl">无原文链接</span>
                      )}
                    </li>
                  ))}
                </ul>
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
                      {attnFbBusy === 'not_relevant' ? '…' : '这条没用'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost card__ctx-fb-chip"
                      onClick={() => setPrefMode(true)}
                    >
                      我以后不想看这类
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
      <footer className="card__actions">
        <button
          type="button"
          className="btn btn--card btn--create-task"
          onClick={() => void createLarkTask()}
          disabled={!!busy || taskBusy}
          title="创建飞书任务并回写 Context"
        >
          {taskBusy ? '…' : '加入任务'}
        </button>
        {visibleActions.map((a) => {
          const isAsk = a.kind === 'ask_agent' || a.kind === 'draft_reply';
          if (!isAsk) {
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
          }
          // MVP11.0-b：ask_agent / draft_reply 旁边带可选指令输入
          return (
            <div key={a.id} className="card__ask-inline">
              <input
                type="text"
                className="card__ask-input"
                placeholder="（可选）额外指令，留空走默认 prompt"
                value={askPrompts[a.id] ?? ''}
                onChange={(e) =>
                  setAskPrompts((p) => ({ ...p, [a.id]: e.target.value }))
                }
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
        })}
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
