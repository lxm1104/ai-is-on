import { useState } from 'react';
import type { SignalCard } from '../types';
import type { RunOnceResult } from '../lib/api';
import { SignalCardView } from './SignalCard';

type Toast =
  | { kind: 'ok'; text: string; at: number }
  | { kind: 'err'; text: string; at: number };

function summarize(results: RunOnceResult[]): Toast {
  const errs = results.filter((r) => r.error);
  if (errs.length > 0) {
    return {
      kind: 'err',
      text: errs.map((r) => `${labelOf(r.name)}: ${r.error}`).join('；'),
      at: Date.now(),
    };
  }
  const total = results.reduce((acc, r) => acc + r.newEvents, 0);
  if (total === 0) {
    const parts = results.map(
      (r) => `${labelOf(r.name)} ${r.collected} 条（无新增）`
    );
    return {
      kind: 'ok',
      text: `扫描完成 · 未发现新信号 · ${parts.join(' · ')}`,
      at: Date.now(),
    };
  }
  const parts = results.map(
    (r) => `${labelOf(r.name)} ${r.newEvents} 新增 / ${r.collected} 总`
  );
  return {
    kind: 'ok',
    text: `扫描完成 · ${parts.join(' · ')} · 正在 triage…`,
    at: Date.now(),
  };
}

function labelOf(name: string): string {
  if (name === 'calendar') return '日历';
  if (name === 'im') return '@我/群';
  return name;
}

export function CardList(props: {
  cards: SignalCard[];
  onAction: (cardId: string, actionId: string) => Promise<void>;
  onRunOnce: () => Promise<RunOnceResult[]>;
  collectorsHint?: string;
}) {
  // MVP72：「🙋 需要你」求助卡 = AI 卡住、在等你补一手，价值最高 → 置顶，别埋在列表里让你找不到。
  //  稳定排序：needhelp 优先，其余保持后端原序（优先级+时间）。
  const isNeedHelp = (c: SignalCard) => (c.title ?? '').startsWith('🙋');
  const open = props.cards
    .filter((c) => c.status === 'new')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (isNeedHelp(b.c) ? 1 : 0) - (isNeedHelp(a.c) ? 1 : 0) || a.i - b.i)
    .map((x) => x.c);
  // MVP32：'done'（已处理且事项办结）也进已处理抽屉——带「已完成」pill、「✓已核实」章与撤销入口。
  const processed = props.cards.filter(
    (c) => c.status === 'acknowledged' || c.status === 'snoozed' || c.status === 'done'
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  async function runScan() {
    if (scanning) return;
    setScanning(true);
    setToast(null);
    try {
      const results = await props.onRunOnce();
      setToast(summarize(results));
    } catch (e) {
      setToast({ kind: 'err', text: e instanceof Error ? e.message : String(e), at: Date.now() });
    } finally {
      setScanning(false);
      // auto-dismiss after 6s
      const myToken = Date.now();
      setTimeout(() => {
        setToast((t) => (t && t.at <= myToken ? null : t));
      }, 6000);
    }
  }

  const ScanButton = (
    <button
      className={`btn btn--ghost cards__scan-btn ${scanning ? 'is-scanning' : ''}`}
      onClick={runScan}
      disabled={scanning}
      title="立即触发一次飞书数据扫描"
    >
      {scanning ? (
        <>
          <span className="spinner" />
          扫描中…
        </>
      ) : (
        <>↻ 立即扫描</>
      )}
    </button>
  );

  const ToastView = toast && (
    <div className={`scan-toast scan-toast--${toast.kind}`}>{toast.text}</div>
  );

  if (open.length === 0 && processed.length === 0) {
    return (
      <div className="cards cards--empty">
        <div className="cards__empty-inner">
          <h2>暂无需要立刻处理的事</h2>
          <p>我会继续看着日历和 @你消息。</p>
          {props.collectorsHint && <p className="cards__hint">{props.collectorsHint}</p>}
          {ScanButton}
          {ToastView}
        </div>
      </div>
    );
  }

  return (
    <div className="cards">
      <div className="cards__head">
        <span className="cards__title">
          {open.length > 0 ? `待处理（${open.length}）` : '暂无待处理'}
        </span>
        <div className="cards__head-right">
          {processed.length > 0 && (
            <button
              className={`btn btn--ghost cards__drawer-toggle ${drawerOpen ? 'is-on' : ''}`}
              onClick={() => setDrawerOpen((x) => !x)}
              title="查看已处理卡片"
            >
              已处理（{processed.length}） {drawerOpen ? '▾' : '▸'}
            </button>
          )}
          {ScanButton}
        </div>
      </div>

      {ToastView}

      {open.length > 0 ? (
        <div className="cards__list">
          {open.map((c) => (
            <SignalCardView key={c.id} card={c} onAction={props.onAction} />
          ))}
        </div>
      ) : (
        <div className="cards__inline-empty">没有待处理的卡片，干净了 ✨</div>
      )}

      {drawerOpen && processed.length > 0 && (
        <div className="cards__drawer">
          <div className="cards__drawer-head">已处理（{processed.length}）</div>
          <div className="cards__list">
            {processed.map((c) => (
              <SignalCardView key={c.id} card={c} onAction={props.onAction} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
