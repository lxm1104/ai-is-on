import { useEffect, useState } from 'react';
import { fetchAiActivity, fetchAiActivityNow, fetchMatterInvestigationTrace, type AiActivity, type AiActivityTally, type AiInFlight, type InvestigationTrace } from '../lib/api';

// MVP69 P1：把内部工具名映射成用户能懂的说法；**只做术语层**，不展示 run_command 原始命令/路径（防泄漏）。
const TOOL_LABEL: Record<string, string> = {
  search_im_messages: '搜飞书消息',
  im_search: '搜飞书消息',
  get_chat_history: '看群聊记录',
  list_my_tasks: '查我的待办',
  read_doc: '读文档',
  fetch_doc: '读文档',
  run_command: '本地查代码/数据',
};
function friendlyTool(s: { tool?: string; kind: string }): string {
  const t = s.tool ?? s.kind;
  return TOOL_LABEL[t] ?? t;
}
// 失败/含 CLI 原文的步骤 summary 不直接展示原始错误（防泄漏内部命令/路径），归一为一句话。
const LEAK_RE = /lark-cli|exit \d|command not found|traceback|\/Users\/|node_modules|stderr|panic|undefined is not/i;
function friendlySummary(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '（无结果）';
  if (s.startsWith('（失败') || LEAK_RE.test(s)) return '（这步没成功，AI 已跳过）';
  return s.slice(0, 100);
}

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
  const [tally, setTally] = useState<AiActivityTally | null>(null);
  const [inFlight, setInFlight] = useState<AiInFlight>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [list, now] = await Promise.all([fetchAiActivity(60), fetchAiActivityNow().catch(() => null)]);
      setItems(list.items);
      setTally(list.tally);
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

  // MVP71 支柱D：折叠态也拉一次度量盘，让"待你 J"召唤行动在标题上可见（轻量，limit=1）。
  useEffect(() => {
    void fetchAiActivity(1).then((r) => setTally(r.tally)).catch(() => {});
  }, []);

  return (
    <div className={`ai-activity ${open ? 'is-open' : ''}`}>
      <button type="button" className="ai-activity__toggle" onClick={() => setOpen((v) => !v)}>
        <span>🤖 AI 替你做了什么</span>
        <span className="ai-activity__chev">{open ? '▾' : '▸'}</span>
        {/* MVP71：折叠态也显示"待你 J 件"召唤行动 */}
        {!open && tally && tally.pendingCount > 0 && (
          <span className="ai-activity__count" style={{ background: '#b45309' }}>待你 {tally.pendingCount} 件</span>
        )}
        {open && <span className="ai-activity__count">{items.length} 条</span>}
      </button>
      {open && (
        <div className="ai-activity__body">
          {/* MVP71 支柱D：「AI 帮你完成了多少」近 7 天度量盘 —— 直接回答 North Star */}
          {tally && (
            <div className="ai-activity__tally" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '6px 10px', fontSize: 12 }}>
              <span title="近 7 天 AI 高置信主动办结的事项数">✅ 办结 <b>{tally.resolvedCount}</b></span>
              <span title="近 7 天 AI 自主查到进展的事项数">📈 推进 <b>{tally.progressedCount}</b></span>
              <span title="当前需要你补一手才能接着办的事项数" style={{ color: tally.pendingCount > 0 ? '#b45309' : undefined }}>🙋 待你 <b>{tally.pendingCount}</b></span>
              <span title="近 7 天你已应答的求助/待办卡（人机协作转化）">🤝 已应答 <b>{tally.answeredCount}</b></span>
              <span style={{ opacity: 0.6 }}>（近 7 天）</span>
            </div>
          )}
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
                  {a.matterId && a.action === 'investigation_written_back' && <TraceExpander matterId={a.matterId} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** MVP69 P1：行内下钻"AI 查了哪几步"——按需拉该 matter 最近一次排查轨迹，友好工具名，不露 CLI 原文。 */
function TraceExpander({ matterId }: { matterId: string }) {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<InvestigationTrace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded) {
      setBusy(true);
      try {
        setTrace(await fetchMatterInvestigationTrace(matterId));
      } catch {
        setTrace(null);
      } finally {
        setLoaded(true);
        setBusy(false);
      }
    }
  }

  const steps = trace?.steps ?? [];
  return (
    <div className="ai-activity__trace">
      <button type="button" className="ai-activity__trace-toggle" onClick={() => void toggle()}>
        {open ? '▾' : '▸'} {busy ? '加载中…' : open ? '收起排查过程' : '看 AI 查了哪几步'}
      </button>
      {open && loaded && (
        steps.length === 0 ? (
          <div className="ai-activity__trace-empty">没有这次排查的工具链记录（可能是据已知信息直接判断的）。</div>
        ) : (
          <ol className="ai-activity__trace-steps">
            {steps.map((s) => (
              <li key={s.order}>
                <span className="ai-activity__trace-tool">{friendlyTool(s)}</span>
                <span className="ai-activity__trace-sum"> → {friendlySummary(s.summary)}</span>
              </li>
            ))}
          </ol>
        )
      )}
    </div>
  );
}
