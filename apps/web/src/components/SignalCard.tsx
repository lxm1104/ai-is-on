import { useState } from 'react';
import type { CardAction, SignalCard as SignalCardT } from '../types';

const SOURCE_LABEL: Record<SignalCardT['source'], string> = {
  calendar: '日历',
  im: '@我',
  mail: '邮件',
  drive: '文档',
  manual: '手动',
};

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

const REOPEN_ACTION: CardAction = { id: '__reopen', label: '标记未读', kind: 'ack' };

export function SignalCardView(props: {
  card: SignalCardT;
  onAction: (cardId: string, actionId: string) => Promise<void>;
}) {
  const { card } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
