import { useState } from 'react';
import type { CardAction, ContextUnit, SignalCard as SignalCardT } from '../types';
import { fetchCardContext, postContextFeedback } from '../lib/api';

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
  onAction: (cardId: string, actionId: string) => Promise<void>;
}) {
  const { card } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxUnits, setCtxUnits] = useState<ContextUnit[] | null>(null);
  const [ctxErr, setCtxErr] = useState<string | null>(null);
  const [fbOpen, setFbOpen] = useState(false);
  const [fbSent, setFbSent] = useState<string | null>(null);

  async function ensureCtxLoaded() {
    if (ctxUnits !== null) return;
    try {
      const p = await fetchCardContext(card.id);
      setCtxUnits(p.relatedUnits);
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
    setFbSent(null);
    try {
      await postContextFeedback({ cardId: card.id, reason });
      setFbSent(reason);
      setTimeout(() => setFbOpen(false), 800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function run(actionId: string, kind: string) {
    if (kind === 'open_source' && card.sourceUrl) {
      window.open(card.sourceUrl, '_blank', 'noreferrer');
      return;
    }
    setBusy(actionId);
    setErr(null);
    try {
      await props.onAction(card.id, actionId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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
      <h3 className="card__title">{card.title}</h3>
      {card.summary && <p className="card__summary">{card.summary}</p>}
      {card.reason && (
        <p className="card__reason">
          <span className="card__label">为什么：</span>
          {card.reason}
        </p>
      )}
      {card.suggestedAction && (
        <p className="card__suggest">
          <span className="card__label">建议：</span>
          {card.suggestedAction}
        </p>
      )}
      {card.draftReply && (
        <details className="card__draft">
          <summary>回复草稿</summary>
          <pre>{card.draftReply}</pre>
        </details>
      )}
      {card.sourceUrl && (
        <a className="card__link" href={card.sourceUrl} target="_blank" rel="noreferrer">
          打开原文 ↗
        </a>
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
                {ctxUnits.map((u) => (
                  <li key={u.id} className="card__ctx-item">
                    <span className={`ctx-kind ctx-kind--${u.kind}`}>{u.kind}</span>
                    <span className="card__ctx-title">{u.title}</span>
                    {u.time?.dueAt && (
                      <span className="card__ctx-due">due {fmtDate(u.time.dueAt)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="card__ctx-feedback"
              onClick={() => setFbOpen((v) => !v)}
            >
              {fbOpen ? '收起' : '理解错了？'}
            </button>
            {fbOpen && (
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
          </div>
        )}
      </div>
      <footer className="card__actions">
        {visibleActions.map((a) => (
          <button
            key={a.id}
            className={`btn btn--card btn--${a.kind} ${a.id === '__reopen' ? 'btn--reopen' : ''}`}
            onClick={() => run(a.id, a.kind)}
            disabled={!!busy}
          >
            {busy === a.id ? '…' : a.label}
          </button>
        ))}
      </footer>
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
