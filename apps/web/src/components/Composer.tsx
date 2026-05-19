import { useEffect, useRef, useState } from 'react';
import { createVoiceRecorder, isRecorderSupported, type VoiceInputState } from '../lib/speech';
import { transcribeAudio } from '../lib/api';

const QUICK_PROMPTS = [
  '今天有什么必须处理？',
  '查一下我今天的日程，并判断有什么需要我提前准备',
  '有没有人 @我？',
  '帮我总结最近新增的信号',
];

export function Composer(props: {
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [voiceState, setVoiceState] = useState<VoiceInputState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef(createVoiceRecorder(60));
  const taRef = useRef<HTMLTextAreaElement>(null);
  const supported = isRecorderSupported();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        taRef.current?.focus();
      }
      if (meta && e.key === '/') {
        e.preventDefault();
        void toggleVoice();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceState]);

  async function toggleVoice() {
    if (!supported) {
      setVoiceState('unsupported');
      return;
    }
    if (voiceState === 'idle' || voiceState === 'error' || voiceState === 'unsupported') {
      setVoiceError(null);
      try {
        await recorderRef.current.start();
        setVoiceState('recording');
      } catch (err) {
        setVoiceState('error');
        setVoiceError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (voiceState === 'recording') {
      try {
        const blob = await recorderRef.current.stop();
        setVoiceState('transcribing');
        const recognized = await transcribeAudio(blob);
        setText((prev) => (prev ? `${prev}${prev.endsWith(' ') ? '' : ' '}${recognized}` : recognized));
        setVoiceState('idle');
        taRef.current?.focus();
      } catch (err) {
        setVoiceState('error');
        setVoiceError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    props.onSend(t);
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const micLabel =
    voiceState === 'recording'
      ? '停止'
      : voiceState === 'transcribing'
        ? '识别中…'
        : '🎤';

  const hint =
    voiceState === 'recording'
      ? '正在录音…再次点击或 ⌘/ 停止（上限 60 秒）'
      : voiceState === 'transcribing'
        ? '正在调用飞书 ASR…'
        : voiceState === 'unsupported'
          ? '当前浏览器不支持录音，请直接输入文字'
          : voiceError
            ? `语音失败：${voiceError}`
            : null;

  return (
    <div className="composer">
      <div className="composer__quick">
        {QUICK_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            className="chip"
            onClick={() => {
              setText(p);
              taRef.current?.focus();
            }}
            disabled={props.disabled}
          >
            {p}
          </button>
        ))}
      </div>
      {hint && (
        <div className={`composer__hint composer__hint--${voiceState}`}>{hint}</div>
      )}
      <div className="composer__row">
        <button
          type="button"
          className={`btn btn--mic ${voiceState === 'recording' ? 'btn--mic-on' : ''}`}
          onClick={() => void toggleVoice()}
          disabled={props.disabled || voiceState === 'transcribing'}
          title="语音输入（⌘/）"
        >
          {micLabel}
        </button>
        <textarea
          ref={taRef}
          className="composer__textarea"
          placeholder={'问我任何事，或者说"帮我看今天有什么必须处理"'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={props.disabled}
        />
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={props.disabled || !text.trim()}
        >
          发送
        </button>
      </div>
    </div>
  );
}
