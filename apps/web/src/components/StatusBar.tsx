import type { CollectorStatus, RuntimeStatus } from '../types';

const LABEL: Record<RuntimeStatus, string> = {
  idle: '空闲',
  starting: '启动中',
  ready: '在线',
  busy: '忙碌',
  stopped: '离线',
  error: '错误',
};

const DOT_COLOR: Record<RuntimeStatus, string> = {
  idle: '#9ca3af',
  starting: '#fbbf24',
  ready: '#22c55e',
  busy: '#fbbf24',
  stopped: '#9ca3af',
  error: '#ef4444',
};

function fmtCountdown(nextIso?: string): string {
  if (!nextIso) return '';
  const ms = new Date(nextIso).getTime() - Date.now();
  if (ms <= 0) return '即将扫描';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s 后扫描`;
  return `${Math.round(s / 60)}min 后扫描`;
}

export function StatusBar(props: {
  status: RuntimeStatus;
  collectors: CollectorStatus[];
  onRestart: () => void;
}) {
  return (
    <header className="status-bar">
      <div className="status-bar__title">
        <span className="status-bar__brand">AI is ON</span>
        <span className="status-bar__sub">本地研究 demo · 只读飞书</span>
      </div>
      <div className="status-bar__collectors">
        {props.collectors.map((c) => {
          const ok = !c.lastError;
          return (
            <span
              key={c.name}
              className={`collector ${ok ? 'collector--ok' : 'collector--err'}`}
              title={c.lastError ?? `last=${c.lastSuccessAt ?? '—'} next=${c.nextRunAt ?? '—'}`}
            >
              <span className="collector__dot" />
              {c.name === 'calendar' ? '日历' : c.name === 'im' ? '@我' : c.name}
              <span className="collector__cd">{fmtCountdown(c.nextRunAt)}</span>
            </span>
          );
        })}
      </div>
      <div className="status-bar__right">
        <span className="status-bar__dot" style={{ background: DOT_COLOR[props.status] }} />
        <span className="status-bar__status">Claude {LABEL[props.status]}</span>
        <button className="btn btn--ghost" onClick={props.onRestart} title="重启 Claude Runtime">
          重启
        </button>
      </div>
    </header>
  );
}
