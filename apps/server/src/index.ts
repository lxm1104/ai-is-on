import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { config } from './config.js';
import { attachWebSocket } from './ws.js';
import { claudeRuntime } from './claude/ClaudeRuntime.js';
import { startMessageBus } from './messageBus.js';
import { chatRouter } from './routes/chat.js';
import { runtimeRouter } from './routes/runtime.js';
import { speechRouter } from './routes/speech.js';
import { cardsRouter } from './routes/cards.js';
import { collectorsRouter } from './routes/collectors.js';
import { debugRouter } from './routes/debug.js';
import { contextRouter } from './routes/context.js';
import { startCollectorScheduler, stopCollectorScheduler } from './collectors/scheduler.js';
import { startTriggerScheduler, stopTriggerScheduler } from './triggers/triggerScheduler.js';

const app = express();
app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, runtime: claudeRuntime.getStatus() });
});

app.use('/api', chatRouter);
app.use('/api', runtimeRouter);
app.use('/api', speechRouter);
app.use('/api', cardsRouter);
app.use('/api', collectorsRouter);
app.use('/api', debugRouter);
app.use('/api', contextRouter);

const server = http.createServer(app);
attachWebSocket(server);

startMessageBus();

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] listening on http://127.0.0.1:${config.port}`);
  claudeRuntime
    .start()
    .then(() => console.log('[server] claude runtime started'))
    .catch((err) => console.error('[server] failed to start claude runtime:', err));
  startCollectorScheduler();
  startTriggerScheduler();
});

const shutdown = async (signal: string) => {
  console.log(`[server] received ${signal}, shutting down`);
  try {
    stopCollectorScheduler();
  } catch {}
  try {
    stopTriggerScheduler();
  } catch {}
  try {
    await claudeRuntime.stop();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
