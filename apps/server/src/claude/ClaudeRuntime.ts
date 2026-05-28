// MVP18 Stage 1: 旧的 ClaudeRuntime（全局单例 + 单 activeChild）改为 ChatRuntimeManager，
// 内部按 topicId 维护一组 TopicSession。导出名 `claudeRuntime` 与方法签名都保留，
// 旧调用方（index.ts / messageBus.ts / chatTopics.ts / routes/runtime.ts）无需改动。
//
// 关键变化：
//   - 全局 status 含义收窄为"runtime 进程健康度"（idle/starting/ready/stopped/error），不再有 'busy'
//   - 新增 'topic_status' 事件，messageBus 订阅后广播 ServerEvent.topic_status
//   - interrupt() 支持可选 topicId 参数；无参时退化为"中断所有 busy session"
//   - 新增 getAllTopicStatus()，给前端 WS reconnect 时拉一次全量快照（修复 R1 漂移）

import { EventEmitter } from 'node:events';
import type { RuntimeEvent, RuntimeStatus, TopicStatus } from './protocol.js';
import { TopicSession, type SendOptions } from './TopicSession.js';

// 兼容旧 import：很多调用方写 `import { ..., type SendUserMessageOptions } from ...`
// 直接用 SendOptions 作为别名，并放开"调用方不能直接构造无 topicId 的 opts"
// —— 因为 manager.sendUserMessage 需要 topicId 来路由到 TopicSession。
export type SendUserMessageOptions = SendOptions & { topicId: string };

export class ChatRuntimeManager extends EventEmitter {
  private sessions = new Map<string, TopicSession>();
  private processStatus: RuntimeStatus = 'starting';

  // ─────────────────────────── 旧 API 兼容层 ───────────────────────────

  /** 进程健康度。绝不返回 'busy'。 */
  getStatus(): RuntimeStatus {
    return this.processStatus;
  }

  /** 启动钩子（index.ts:80 调）。opencode 是 per-turn 子进程没有 daemon 概念，这里只翻状态。 */
  async start(): Promise<void> {
    this.setProcessStatus('ready');
  }

  /** 进程 shutdown（index.ts:114 调）。kill 所有正在跑的 turn，丢弃 stdout，状态翻 stopped。 */
  async stop(): Promise<void> {
    for (const s of this.sessions.values()) s.forceKill('shutdown');
    this.sessions.clear();
    this.setProcessStatus('stopped');
  }

  /** 全局 restart（routes/runtime.ts:12 调）。所有 session 强结束 + 重置状态。 */
  async restart(): Promise<void> {
    for (const s of this.sessions.values()) s.forceKill('restart');
    this.sessions.clear();
    await new Promise((r) => setTimeout(r, 100));
    this.setProcessStatus('ready');
  }

  /**
   * 全局或单 topic 中断。
   * - 无参（旧调用方语义）：中断所有当前 busy 的 session
   * - 带 topicId：仅中断该 topic
   */
  async interrupt(
    topicId?: string
  ): Promise<{ ok: boolean; method?: 'sigint' | 'restart' | 'noop'; count?: number }> {
    if (topicId) {
      const s = this.sessions.get(topicId);
      if (!s) return { ok: false, method: 'noop' };
      return s.interrupt();
    }
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.getStatus() === 'busy') {
        await s.interrupt();
        count++;
      }
    }
    return { ok: true, count };
  }

  /**
   * 旧入口（chatTopics.ts:111 调）。按 opts.topicId 路由到对应 TopicSession。
   * 多个 topic 可以真正并发（每个 session 一个独立 opencode 子进程）。
   */
  async sendUserMessage(text: string, opts: SendUserMessageOptions): Promise<void> {
    return this.getOrCreate(opts.topicId).sendUserMessage(text, opts);
  }

  // ─────────────────────────── 新增 API ───────────────────────────

  /** 前端 WS reconnect 时拉一次全量 topic_status 快照（修复 R1 漂移）。 */
  getAllTopicStatus(): Array<{ topicId: string; status: TopicStatus }> {
    return Array.from(this.sessions.entries()).map(([topicId, s]) => ({
      topicId,
      status: s.getStatus(),
    }));
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private getOrCreate(topicId: string): TopicSession {
    let s = this.sessions.get(topicId);
    if (!s) {
      s = new TopicSession(topicId);
      // 把 TopicSession 的两类事件转发出去：
      //   - 'status' (TopicStatus 变化) → 'topic_status' { topicId, status }
      //   - 'runtime_event' (RuntimeEvent) → 透传同名事件
      s.on('status', (st: TopicStatus) => {
        this.emit('topic_status', { topicId, status: st });
      });
      s.on('runtime_event', (e: RuntimeEvent) => {
        this.emit('runtime_event', e);
      });
      this.sessions.set(topicId, s);
    }
    return s;
  }

  private setProcessStatus(s: RuntimeStatus) {
    if (this.processStatus === s) return;
    this.processStatus = s;
    // 保留 'status' 事件名，messageBus.ts 已订阅广播为 ServerEvent.runtime_status
    this.emit('status', s);
  }
}

// 旧导出名保留，所有 import 不需要改。
export const claudeRuntime = new ChatRuntimeManager();
