import { useEffect, useState } from 'react';
import { fetchAiActivity, fetchAiActivityNow, type AiActivity, type AiActivityTally, type AiInFlight } from '../lib/api';

/**
 * MVP68「AI 替你做了什么」——把 AI 自主动作（主动办结 / 自主排查 / 从对话更新事项）做成用户可读的记录流。
 * 常驻在待处理区上方（不再埋进 Rules & Audit 技术面板），默认折叠、一键展开。
 */

type ActionMeta = { icon: string; label: string; isResult: boolean };
function actionMeta(a: AiActivity): ActionMeta {
  switch (a.action) {
    case 'matter_auto_resolved':
      return { icon: '✅', label: '替你办结', isResult: true };
    case 'investigation_recommended':
      return { icon: '💡', label: '给你一条建议', isResult: true }; // MVP75：直接建议/意见（结果）
    case 'matter_artifact_raised':
      return { icon: '🔧', label: '替你产出可执行件', isResult: true }; // MVP74/P1-6：修复方案/待建任务/决策信息包

    case 'chat_conclusion_written_back':
      return { icon: '💬', label: '从对话替你更新', isResult: true };
    case 'lark_task_created':
      return { icon: '☑️', label: '替你建了飞书任务', isResult: true };
    case 'lark_doc_created':
      return { icon: '📄', label: '替你建了飞书文档', isResult: true };
    // MVP73：除排查外的其它 agent 交付物
    case 'meeting_brief':
      return { icon: '🤝', label: '会前替你拉齐', isResult: true };
    case 'meeting_action_items':
      return { icon: '📋', label: '纪要替你抽待办', isResult: true };
    case 'daily_digest':
      return { icon: '🗞', label: '替你做了日报', isResult: true };
    case 'reminder':
      return { icon: '⏰', label: '到期提醒', isResult: true };
    case 'caring_note':
      return { icon: '💗', label: '关心提醒', isResult: true };
    // MVP75 第一性原理：面板只展示"结果/交付物"。原始排查(investigation_written_back)是过程、不是结果，
    // 已从后端 AI_ACTIVITY_ACTIONS 移除，不再进这里。其余未知动作一律不当结果。
    default:
      return { icon: '🤖', label: a.action, isResult: false };
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
              {/* MVP75 北极星：结果率 = 拿到直接结果(建议/产出/办结)的事项占比，领衔展示 */}
              <span title="近 7 天 AI 给你「直接结果」(建议/产出/办结)的事项占被处理事项的比例——越高越好" style={{ fontWeight: 600 }}>🎯 结果率 <b>{Math.round((tally.resultRate ?? 0) * 100)}%</b></span>
              <span title="近 7 天 AI 给你直接建议/意见的事项数">💡 建议 <b>{tally.recommendedCount}</b></span>
              <span title="近 7 天 AI 高置信主动办结的事项数">✅ 办结 <b>{tally.resolvedCount}</b></span>
              <span title="近 7 天 AI 替你产出修复方案（真有 file:line，可一键复制去改）的事项数">🔧 产出 <b>{tally.producedCount}</b></span>
              <span title="当前需要你补一手才能接着办的事项数" style={{ color: tally.pendingCount > 0 ? '#b45309' : undefined }}>🙋 待你 <b>{tally.pendingCount}</b></span>
              <span title="近 7 天你已应答的求助/待办卡（人机协作转化）">🤝 已应答 <b>{tally.answeredCount}</b></span>
              <span style={{ opacity: 0.6 }}>（近 7 天）</span>
            </div>
          )}
          <div className="ai-activity__bar">
            <span className="ai-activity__hint">AI 替你办成/推进的结果（建议 / 起草 / 产出 / 办结），点事项可复核</span>
            <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
              {loading ? '加载中…' : '↻ 刷新'}
            </button>
          </div>
          {error && <div className="ai-activity__err">{error}</div>}
          {inFlight && (
            <div className="ai-activity__inflight">
              <span className="ai-activity__inflight-dot" /> AI 正在替你处理：「{inFlight.title}」
            </div>
          )}
          {!error && items.length === 0 && !loading && (
            <div className="ai-activity__empty">还没有结果。AI 给出建议 / 起草 / 办结后，会出现在这里。</div>
          )}
          <ul className="ai-activity__list">
            {items.map((a) => {
              const meta = actionMeta(a);
              return (
                <li key={a.id} className={`ai-activity__row ${meta.isResult ? 'ai-activity__row--result' : 'ai-activity__row--process'}`}>
                  <div className="ai-activity__head">
                    <span className="ai-activity__icon">{meta.icon}</span>
                    <span className="ai-activity__action">{meta.label}</span>
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

