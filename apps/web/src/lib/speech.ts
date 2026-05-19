export type VoiceInputState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'unsupported'
  | 'error';

export type VoiceRecorder = {
  start(): Promise<void>;
  stop(): Promise<Blob>;
  cancel(): void;
  isSupported(): boolean;
};

export function isRecorderSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

export function createVoiceRecorder(maxSeconds = 60): VoiceRecorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stopTimer: number | null = null;

  function cleanup() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
    chunks = [];
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  return {
    isSupported: isRecorderSupported,
    async start() {
      if (!isRecorderSupported()) throw new Error('浏览器不支持录音');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.start(250);
      stopTimer = window.setTimeout(() => {
        if (recorder && recorder.state === 'recording') recorder.stop();
      }, maxSeconds * 1000);
    },
    async stop() {
      if (!recorder) throw new Error('not recording');
      return new Promise<Blob>((resolve, reject) => {
        const r = recorder!;
        r.onstop = () => {
          try {
            const type = chunks[0]?.type || r.mimeType || 'audio/webm';
            const blob = new Blob(chunks, { type });
            cleanup();
            resolve(blob);
          } catch (err) {
            cleanup();
            reject(err);
          }
        };
        if (r.state !== 'inactive') r.stop();
        else r.onstop?.(new Event('stop'));
      });
    },
    cancel() {
      try {
        recorder?.stop();
      } catch {}
      cleanup();
    },
  };
}

function pickMime(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return undefined;
}
