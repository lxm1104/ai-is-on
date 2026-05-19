import type { ServerEvent } from '../types';

export type WsClient = {
  close(): void;
};

export function connectWs(onEvent: (e: ServerEvent) => void, onOpen?: () => void): WsClient {
  let closed = false;
  let ws: WebSocket | null = null;
  let retryTimer: number | null = null;

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => onOpen?.();
    ws.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as ServerEvent;
        onEvent(e);
      } catch {}
    };
    ws.onclose = () => {
      if (closed) return;
      retryTimer = window.setTimeout(open, 1000);
    };
    ws.onerror = () => ws?.close();
  }
  open();
  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
