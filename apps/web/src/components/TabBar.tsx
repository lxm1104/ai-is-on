// MVP18 Stage 3: 右侧 chat 面板顶部的 tab 栏。替代原 TopicHeader 下拉框。
//
// 容器横向滚动（overflow-x: auto），tab 数过多时用户横拖，绝不溢出菜单。
// 标题视觉上截 14 字 + ellipsis，title 属性保留完整以便 hover。
// "+ 新会话"按钮始终钉在右侧；旁边带 "⏱ 历史" 下拉，进入用户**没在 openTopicIds**
// 里但 DB 仍有的旧会话（Stage 3 落地后没有这个入口，历史会话会看起来"消失了"，
// 这是 Stage 3 后追加的修复）。

import { useEffect, useRef, useState } from 'react';
import type { TopicStatus } from '../types';

export type Tab = {
  id: string;
  title: string;
  status: TopicStatus; // 'idle' | 'busy'
  active: boolean;
};

export type HistoryTopic = {
  id: string;
  title: string;
  /** ISO timestamp，用来排序 & 显示相对时间 */
  lastMessageAt?: string;
  /** 是否后台仍在跑——便于用户判断是否要打开 */
  status: TopicStatus;
};

export function TabBar(props: {
  tabs: Tab[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** activeTopicId 为 null 时高亮"+ 新会话"占位 */
  isNewActive: boolean;
  /** 已落库但未打开的会话列表，按时间倒序 */
  history: HistoryTopic[];
  /** 从历史里打开一个会话（= openTab + setActive） */
  onOpenHistory: (topicId: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyAnchorRef = useRef<HTMLDivElement | null>(null);

  // 点击 popover 外面就关闭
  useEffect(() => {
    if (!historyOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!historyAnchorRef.current) return;
      if (!historyAnchorRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [historyOpen]);

  return (
    <div className="tabbar">
      <div className="tabbar__scroll">
        {props.tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.active ? 'tab--active' : ''} ${t.status === 'busy' ? 'tab--busy' : ''}`}
            onClick={() => props.onSelect(t.id)}
            title={t.title}
            role="tab"
            aria-selected={t.active}
          >
            {t.status === 'busy' && (
              <span className="tab__spinner" aria-label="正在生成" />
            )}
            <span className="tab__title">{truncate(t.title, 14)}</span>
            <button
              type="button"
              className="tab__close"
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(t.id);
              }}
              aria-label="关闭会话"
              title="关闭会话（不中断后台 turn）"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`tab tab--new ${props.isNewActive ? 'tab--active' : ''}`}
        onClick={props.onNew}
        title="新会话"
      >
        + 新会话
      </button>
      <div className="tab-history" ref={historyAnchorRef}>
        <button
          type="button"
          className="tab tab--history"
          onClick={() => setHistoryOpen((v) => !v)}
          title="打开历史会话"
          aria-haspopup="listbox"
          aria-expanded={historyOpen}
          disabled={props.history.length === 0}
        >
          ⏱ 历史 ({props.history.length})
        </button>
        {historyOpen && props.history.length > 0 && (
          <div className="tab-history__popover" role="listbox">
            {props.history.slice(0, 30).map((h) => (
              <button
                key={h.id}
                type="button"
                className="tab-history__row"
                onClick={() => {
                  setHistoryOpen(false);
                  props.onOpenHistory(h.id);
                }}
                title={h.title}
              >
                {h.status === 'busy' && (
                  <span className="tab__spinner" aria-label="正在生成" />
                )}
                <span className="tab-history__title">{truncate(h.title, 28)}</span>
                <span className="tab-history__time">{relTime(h.lastMessageAt)}</span>
              </button>
            ))}
            {props.history.length > 30 && (
              <div className="tab-history__more">
                +{props.history.length - 30} 条更早的会话…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h 前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d 前`;
  return new Date(iso).toLocaleDateString();
}
