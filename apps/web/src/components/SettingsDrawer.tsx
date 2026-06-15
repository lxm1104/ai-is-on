import { useState, type ReactNode } from 'react';

// 左侧待处理卡片区下方原本平铺着 9 个设置 / 管理 / 调试面板（Work Map、语气、
// 协作圈、Spaces、项目名审核、Rules、Playbook、事项、Context）。每个即使折叠也各占
// 一行表头，9 行叠起来吃掉 ~300px，把待处理卡片挤得几乎看不见。
// 这里把它们统一收进一个「设置与管理」抽屉：默认折叠 → 只剩一行；展开后才铺开这些面板
// （每个面板内部仍各自可折叠）。展开态给抽屉一个高度上限 + 自身滚动，避免反过来把卡片挤没。
const LS_OPEN = 'aiisn.settingsDrawer.open';

function loadOpen(): boolean {
  try {
    return localStorage.getItem(LS_OPEN) === '1';
  } catch {
    return false;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(LS_OPEN, open ? '1' : '0');
  } catch {}
}

export function SettingsDrawer({ children }: { children: ReactNode }) {
  // 默认折叠 —— 不让设置条目常驻卡片区；上次手动展开过则恢复。
  const [open, setOpen] = useState<boolean>(() => loadOpen());

  function toggle() {
    setOpen((v) => {
      const next = !v;
      saveOpen(next);
      return next;
    });
  }

  return (
    <div className={`settings-drawer ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="settings-drawer__toggle"
        onClick={toggle}
        aria-expanded={open}
        title={open ? '收起设置与管理' : '展开 Work Map / 语气 / 空间 / 规则 / 流程 / 事项 …'}
      >
        <span className="settings-drawer__chev">{open ? '▾' : '▸'}</span>
        <span className="settings-drawer__label">⚙ 设置与管理</span>
        <span className="settings-drawer__hint">
          {open ? '点击收起' : 'Work Map · 语气 · 协作圈 · Spaces · 规则 · 流程 · 事项 …'}
        </span>
      </button>
      {open && <div className="settings-drawer__body">{children}</div>}
    </div>
  );
}
