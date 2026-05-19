import { randomUUID } from 'node:crypto';
import {
  type AgentRunRow,
  type TriggerRow,
  getTrigger,
  insertAgentRun,
  updateAgentRun,
  updateTriggerStatus,
} from '../db.js';
import { getContextUnitById } from '../context/contextStore.js';
import {
  type AgentHandler,
  type AgentInput,
  type AgentOutput,
  getAgent,
  selectAgentForTrigger,
} from './agentRegistry.js';

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 1;

type QueueItem = { triggerId: string; attempt: number };

const queue: QueueItem[] = [];
let draining = false;

/** Public: enqueue an agent run for a (just-persisted) trigger. Returns immediately. */
export function enqueueAgentRunForTrigger(triggerId: string): void {
  queue.push({ triggerId, attempt: 0 });
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await runOne(item);
      } catch (err) {
        console.error(
          `[agents] drain caught unexpected error on trigger ${item.triggerId}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  } finally {
    draining = false;
  }
}

async function runOne(item: QueueItem) {
  const trigger = getTrigger(item.triggerId);
  if (!trigger) {
    console.warn(`[agents] trigger ${item.triggerId} not found, skipping`);
    return;
  }
  if (trigger.status !== 'pending') {
    // Another worker / previous attempt already processed
    return;
  }
  const agentType = selectAgentForTrigger(trigger.trigger_type);
  if (!agentType) {
    console.warn(`[agents] no agent for trigger_type=${trigger.trigger_type}`);
    updateTriggerStatus(trigger.id, 'skipped', new Date().toISOString());
    return;
  }
  const handler = getAgent(agentType);
  if (!handler) {
    console.warn(`[agents] handler ${agentType} not registered`);
    updateTriggerStatus(trigger.id, 'skipped', new Date().toISOString());
    return;
  }

  const unit = trigger.context_unit_id ? getContextUnitById(trigger.context_unit_id) : null;
  const input: AgentInput = { trigger, unit };
  const runId = createAgentRun(trigger, agentType, input);
  updateTriggerStatus(trigger.id, 'running', new Date().toISOString());

  const startedAt = new Date().toISOString();
  updateAgentRun(runId, { status: 'running', started_at: startedAt });

  try {
    const output = await withTimeout(handler(input), DEFAULT_TIMEOUT_MS);
    const completedAt = new Date().toISOString();
    updateAgentRun(runId, {
      status: 'done',
      output_json: JSON.stringify(output),
      completed_at: completedAt,
    });
    updateTriggerStatus(trigger.id, 'done', completedAt);
    console.log(
      `[agents] ${agentType} done for trigger ${trigger.id}: ${output.summary} (proposals=${output.proposalIds.length}, cards=${output.cardIds.length})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const completedAt = new Date().toISOString();

    if (item.attempt < MAX_RETRIES && !isFatalError(msg)) {
      console.warn(
        `[agents] ${agentType} failed on trigger ${trigger.id} (attempt ${item.attempt + 1}), retrying: ${msg}`
      );
      updateAgentRun(runId, {
        status: 'failed',
        error: msg,
        completed_at: completedAt,
      });
      // Reset trigger to pending so the retried run can pick it up
      updateTriggerStatus(trigger.id, 'pending', completedAt);
      queue.push({ triggerId: trigger.id, attempt: item.attempt + 1 });
      return;
    }

    updateAgentRun(runId, {
      status: 'failed',
      error: msg,
      completed_at: completedAt,
    });
    updateTriggerStatus(trigger.id, 'failed', completedAt);
    console.error(`[agents] ${agentType} permanently failed on trigger ${trigger.id}: ${msg}`);
  }
}

function createAgentRun(
  trigger: TriggerRow,
  agentType: string,
  input: AgentInput
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const row: AgentRunRow = {
    id,
    trigger_id: trigger.id,
    agent_type: agentType,
    input_json: JSON.stringify({
      trigger: {
        id: trigger.id,
        type: trigger.trigger_type,
        reasoning: trigger.reasoning,
        dueAt: trigger.due_at,
        payload: safeJSON(trigger.payload_json),
      },
      unit: input.unit
        ? {
            id: input.unit.id,
            kind: input.unit.kind,
            title: input.unit.title,
          }
        : null,
    }),
    output_json: null,
    status: 'queued',
    error: null,
    started_at: null,
    completed_at: null,
    created_at: now,
  };
  insertAgentRun(row);
  return id;
}

function safeJSON(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isFatalError(msg: string): boolean {
  // 不重试的硬错误：configuration / not found / OAuth
  return /no agent for|handler.*not registered|OAuth|permission denied/i.test(msg);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`agent timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}
