// 「模仿」模块的编辑面板：查看/编辑"我的说话风格"画像。
//
// 画像（markdown）会被注入主聊天 / 同步草稿 agent 的 system prompt，
// 让 AI 替我产出对外文字时用我的语气。保存后服务端重新物化 agent 文件，
// 下次调用即生效。清空保存 = 回落内置默认种子。

import { useEffect, useState } from 'react';
import { fetchToneProfile, saveToneProfile } from '../lib/api';

export function TonePanel() {
  const [open, setOpen] = useState(false);
  const [md, setMd] = useState('');
  const [defaultMd, setDefaultMd] = useState('');
  const [customized, setCustomized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const p = await fetchToneProfile();
      setMd(p.md);
      setDefaultMd(p.default);
      setCustomized(p.customized);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const p = await saveToneProfile(md);
      setMd(p.md);
      setCustomized(p.customized);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onReset() {
    // 清空覆盖 = 回落默认种子。
    setSaving(true);
    setError(null);
    try {
      const p = await saveToneProfile('');
      setMd(p.md);
      setCustomized(p.customized);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = md.trim() !== '' && md.trim() !== defaultMd.trim();

  return (
    <div className={`ctx-panel ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="ctx-panel__toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>模仿（我的语气）</span>
        <span className="ctx-panel__chev">{open ? '▾' : '▸'}</span>
        {open && (
          <span className="ctx-panel__counts">
            {customized ? '已自定义' : '默认种子'}
          </span>
        )}
      </button>
      {open && (
        <div className="ctx-panel__body">
          <p className="ctx-panel__hint">
            这段画像会注入主聊天 / 同步草稿 agent，让 AI 替你产出对外文字时模仿你的语气。
            保存即生效；清空保存可回到内置默认。
          </p>
          {error && <div className="ctx-panel__err">{error}</div>}
          <textarea
            className="tone-editor"
            value={md}
            onChange={(e) => setMd(e.target.value)}
            disabled={loading || saving}
            spellCheck={false}
            rows={18}
            placeholder={loading ? '加载中…' : '在这里编辑你的说话风格画像（Markdown）'}
          />
          <div className="tone-editor__actions">
            <button
              type="button"
              className="btn"
              onClick={() => void onSave()}
              disabled={saving || loading || !dirty}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void onReset()}
              disabled={saving || loading || !customized}
              title="清除自定义，回落内置默认种子"
            >
              恢复默认
            </button>
            {savedAt && !dirty && (
              <span className="tone-editor__saved">已保存 ✓</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
