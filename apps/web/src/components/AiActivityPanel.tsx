import { useEffect, useState } from 'react';
import { fetchAiActivity, fetchAiActivityNow, type AiActivity, type AiInFlight } from '../lib/api';

/**
 * MVP68「AI 替你做了什么」——把 AI 自主动作（主动办结 / 自主排查 / 从对话更新事项）做成用户可读的记录流。
 * 常驻在待处理区上方（不再埋进 Rules & Audit 技术面板），默认折叠、一键展开。
 */

type ActionMeta = { icon: string; label: string };
function actionMeta(a: AiActivity): ActionMeta {
  switch (a.action) {
    case 'matter_auto_resolved':
      return { icon: '✅', label: '主动办结' };
    case 'chat_conclusion_written_back':
      return { icon: '💬', label: '从对话更新' };
    case 'investigation_written_back':
      switch (a.verdict) {
        case 'resolved': return { icon: '🔍', label: '排查·疑似已完成' };
        case 'progressed': return { icon: '🔍', label: '排查·有进展' };
        case 'blocked': return { icon: '🔍', label: '排查·受阻' };
        default: return { icon: '🔍', label: '排查·暂未查到' };
      }
    default:
      return { icon: '🤖', label: a.action };
  }
}

// reason 里常带「…：<事实>」，事实部分对用户更有用——优先展示冒号后的内容。
function detailOf(a: AiActivity): string {
  const r = a.reason || '';
  const idx = r.indexOf('：');
  const tail = idx >= 0 ? r.slice(idx + 1).trim() : r;
  return tail || r;
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return iso;
  }
}

export function AiActivityPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AiActivity[]>([]);
  const [inFlight, setInFlight] = useState<AiInFlight>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [list, now] = await Promise.all([fetchAiActivity(60), fetchAiActivityNow().catch(() => null)]);
      setItems(list);
      setInFlight(now);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void load();
    // 展开时轮询"AI 此刻在查什么"（单并发，变化不频繁，15s 足够）。
    const t = setInterval(() => { void fetchAiActivityNow().then(setInFlight).catch(() => {}); }, 15_000);
    return () => clearInterval(t);
  }, [open]);

  return (
    <div className={`ai-activity ${open ? 'is-open' : ''}`}>
      <button type="button" className="ai-activity__toggle" onClick={() => setOpen((v) => !v)}>
        <span>🤖 AI 替你做了什么</span>
        <span className="ai-activity__chev">{open ? '▾' : '▸'}</span>
        {open && <span className="ai-activity__count">{items.length} 条</span>}
      </button>
      {open && (
        <div className="ai-activity__body">
          <div className="ai-activity__bar">
            <span className="ai-activity__hint">AI 自主处理的记录（主动办结 / 自主排查 / 从对话更新），均可在事项里复核</span>
            <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
              {loading ? '加载中…' : '↻ 刷新'}
            </button>
          </div>
          {error && <div className="ai-activity__err">{error}</div>}
          {inFlight ? (
            <div className="ai-activity__inflight">
              <span className="ai-activity__inflight-dot" /> AI 正在排查：「{inFlight.title}」
            </div>
          ) : (
            <div className="ai-activity__inflight ai-activity__inflight--idle">AI 当前没有在排查（有新事项/新证据会自动开查）</div>
          )}
          {!error && items.length === 0 && !loading && (
            <div className="ai-activity__empty">还没有 AI 自主处理记录。AI 排查/办结后会出现在这里。</div>
          )}
          <ul className="ai-activity__list">
            {items.map((a) => {
              const meta = actionMeta(a);
              return (
                <li key={a.id} className="ai-activity__row">
                  <div className="ai-activity__head">
                    <span className="ai-activity__icon">{meta.icon}</span>
                    <span className="ai-activity__action">{meta.label}</span>
                    {typeof a.confidence === 'number' && a.action === 'investigation_written_back' && (
                      <span className="ai-activity__conf" title="AI 对该结论的把握">置信 {a.confidence.toFixed(2)}</span>
                    )}
                    <span className="ai-activity__time">{shortTime(a.createdAt)}</span>
                  </div>
                  {a.matterTitle && <div className="ai-activity__matter">「{a.matterTitle}」</div>}
                  <div className="ai-activity__detail">{detailOf(a)}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
