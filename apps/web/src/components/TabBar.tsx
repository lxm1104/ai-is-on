// MVP18 Stage 3: 右侧 chat 面板顶部的 tab 栏。替代原 TopicHeader 下拉框。
//
// 容器横向滚动（overflow-x: auto），tab 数过多时用户横拖，绝不溢出菜单。
// 标题视觉上截 14 字 + ellipsis，title 属性保留完整以便 hover。
// "+ 新会话"按钮始终钉在右侧（flex 布局）。

import type { TopicStatus } from '../types';

export type Tab = {
  id: string;
  title: string;
  status: TopicStatus; // 'idle' | 'busy'
  active: boolean;
};

export function TabBar(props: {
  tabs: Tab[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** activeTopicId 为 null 时高亮"+ 新会话"占位 */
  isNewActive: boolean;
}) {
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
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
