import { useEffect, useState } from 'react';
import { fetchAiActivity, fetchAiActivityNow, type AiActivity, type AiActivityTally, type AiInFlight } from '../lib/api';

/**
 * MVP68「AI 替你做了什么」——把 AI 自主动作（主动办结 / 自主排查 / 从对话更新事项）做成用户可读的记录流。
 * 常驻在待处理区上方（不再埋进 Rules & Audit 技术面板），默认折叠、一键展开。
 */

type ActionMeta = { icon: string; label: string; isResult: boolean };
// MVP80「助理工作日志」：只认三类——✅办完的事 / 🔧💡给你的成品 / 🤝与你的互动。
// 未知动作返回 null（整行不渲染）——防止未来新增 audit 动作又变成"没用的信息"。
function actionMeta(a: AiActivity): ActionMeta | null {
  switch (a.action) {
    case 'matter_auto_resolved':
      return { icon: '✅', label: '替你办结', isResult: true };
    case 'backlog_swept_batch':
      return { icon: '🧹', label: '你确认，我清理', isResult: true }; // MVP78 大扫除：AI 甄别+你一句话确认
    case 'investigation_recommended':
      return { icon: '💡', label: '给你一条建议', isResult: true }; // MVP75：直接建议/意见（结果）
    case 'matter_artifact_raised':
      return { icon: '🔧', label: '替你产出可执行件', isResult: true }; // MVP74/P1-6：修复方案/待建任务/决策信息包
    case 'consult_choice':
      return { icon: '🤝', label: '你拍板，我照办', isResult: true }; // MVP79 征询后你的选择
    case 'consult_asked':
      return { icon: '🤝', label: '有人找你，我来征询你怎么办', isResult: true }; // 等你拍板也是结果（用户定义）
    case 'consult_auto_handled':
      return { icon: '⚡', label: '照你的惯例，没再问直接办了', isResult: true }; // MVP81：结果观④照你做法办成
    case 'asked_for_help':
      return { icon: '🙋', label: '我需要你帮一手（已发你飞书）', isResult: true }; // 需要你帮忙也是结果
    case 'asked_confirm':
      return { icon: '✋', label: '请你确认（已发你飞书）', isResult: true }; // 让你确认也是结果
    case 'backlog_sweep_proposed':
      return { icon: '🧹', label: '积压甄别完，等你一句话', isResult: true };
    case 'backlog_sweep_restored':
      return { icon: '↩️', label: '你要求恢复，我照办', isResult: true };
    case 'notify_reply_handled':
      return { icon: '💬', label: '你在飞书补了一句，我接着办', isResult: true }; // MVP78 回复闭环回填
    case 'chat_conclusion_written_back':
      return { icon: '💬', label: '从对话替你更新', isResult: true };
    case 'lark_task_created':
      return { icon: '☑️', label: '替你建了飞书任务', isResult: true };
    case 'lark_doc_created':
      return { icon: '📄', label: '替你建了飞书文档', isResult: true };
    // MVP80：meeting_brief/action_items/daily_digest/reminder/caring_note 已从后端剔除
    //（空标题行+例行推送=用户实锤"没用的信息"；日报/提醒在卡片流有自己的位置）。
    default:
      return null;
  }
}

// 按天分组的日期头：今天 / 昨天 / MM-DD
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
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

  // MVP80：未知动作整行不渲染（服务端已过滤大头，这里兜底），计数/列表都用过滤后的可见项
  const visibleItems = items
    .map((a) => ({ a, meta: actionMeta(a) }))
    .filter((x): x is { a: AiActivity; meta: ActionMeta } => x.meta !== null);

  return (
    <div className={`ai-activity ${open ? 'is-open' : ''}`}>
      <button type="button" className="ai-activity__toggle" onClick={() => setOpen((v) => !v)}>
        <span>🤖 AI 替你做了什么</span>
        <span className="ai-activity__chev">{open ? '▾' : '▸'}</span>
        {/* MVP71：折叠态也显示"待你 J 件"召唤行动 */}
        {!open && tally && tally.pendingCount > 0 && (
          <span className="ai-activity__count" style={{ background: '#b45309' }}>待你 {tally.pendingCount} 件</span>
        )}
        {open && <span className="ai-activity__count">{visibleItems.length} 条</span>}
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
              {(tally.sweptCount ?? 0) > 0 && (
                <span title="近 7 天你在飞书确认后批量清理的陈旧事项数（AI 甄别 + 你一句话确认）">🧹 清理 <b>{tally.sweptCount}</b></span>
              )}
              {(tally.habitAutoCount ?? 0) > 0 && (
                <span title="近 7 天照你的惯例（同类事连续同一选择）没再问、直接办的事项数">⚡ 照惯例 <b>{tally.habitAutoCount}</b></span>
              )}
              <span title="当前需要你补一手才能接着办的事项数" style={{ color: tally.pendingCount > 0 ? '#b45309' : undefined }}>🙋 待你 <b>{tally.pendingCount}</b></span>
              <span title="近 7 天你已应答的求助/待办卡（人机协作转化）">🤝 已应答 <b>{tally.answeredCount}</b></span>
              <span style={{ opacity: 0.6 }}>（近 7 天）</span>
            </div>
          )}
          <div className="ai-activity__bar">
            <span className="ai-activity__hint">工作日志：办成的事 · 给你的成品 · 来找过你的 · 照你做法办的</span>
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
          {!error && visibleItems.length === 0 && !loading && (
            <div className="ai-activity__empty">还没有结果。AI 给出建议 / 起草 / 办结后，会出现在这里。</div>
          )}
          <ul className="ai-activity__list">
            {(() => {
              // MVP80：按天分组插日期头（今天/昨天/MM-DD）
              let lastDay = '';
              return visibleItems.flatMap(({ a, meta }) => {
                const day = dayLabel(a.createdAt);
                const nodes = [] as JSX.Element[];
                if (day !== lastDay) {
                  lastDay = day;
                  nodes.push(
                    <li key={`day-${day}-${a.id}`} className="ai-activity__day" style={{ listStyle: 'none', padding: '8px 10px 2px', fontSize: 11, fontWeight: 600, opacity: 0.55 }}>
                      {day}
                    </li>
                  );
                }
                nodes.push(
                  <li key={a.id} className="ai-activity__row ai-activity__row--result">
                    <div className="ai-activity__head">
                      <span className="ai-activity__icon">{meta.icon}</span>
                      <span className="ai-activity__action">{meta.label}</span>
                      {/* 同事项多轮跟进只留最新一条，用次数徽标替代重复行；清理批次行的件数必须可见（对抗审查 P1）。 */}
                      {(a.repeatCount ?? 1) > 1 && (
                        <span style={{ fontSize: 11, opacity: 0.7, fontWeight: a.action === 'backlog_swept_batch' ? 600 : 400 }}>
                          {a.action === 'backlog_swept_batch' ? `共 ${a.repeatCount} 件` : `（第 ${a.repeatCount} 次跟进）`}
                        </span>
                      )}
                      {/* MVP80「学习照做也是结果」：这条结果是按你教的做法 / 用了你补的信息得来的 */}
                      {!!a.followedYourPlaybook && (
                        <span title="本次排查按你教过的做法（playbook/项目档案）执行" style={{ fontSize: 11, color: '#2563eb' }}>📘 按你教的做法</span>
                      )}
                      {!!a.usedYourBackfill && (
                        <span title="用上了你补充的信息（求助卡/飞书回复）" style={{ fontSize: 11, color: '#0d9488' }}>🧩 用了你补的信息</span>
                      )}
                      {/* MVP81：惯例成立（同类事连续同一选择）→ 没再问、照惯例直接办 */}
                      {!!a.followedYourHabit && (
                        <span title="同类事你连续多次同一选择，这次照你的惯例直接办了（飞书回「先问我」可关掉）" style={{ fontSize: 11, color: '#9333ea' }}>⚡ 按你的惯例</span>
                      )}
                      <span className="ai-activity__time">{shortTime(a.createdAt)}</span>
                    </div>
                    {a.matterTitle && <div className="ai-activity__matter">「{a.matterTitle}」</div>}
                    <div className="ai-activity__detail">{detailOf(a)}</div>
                  </li>
                );
                return nodes;
              });
            })()}
          </ul>
        </div>
      )}
    </div>
  );
}

