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
  type RegisteredAgent,
  getRegisteredAgent,
  selectAgentForTrigger,
} from './agentRegistry.js';
import {
  PACKET_ASSEMBLER_VERSION,
  assembleAgentContextPacket,
} from '../context/agentContextAssembler.js';

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
    return;
  }
  const agentType = selectAgentForTrigger(trigger.trigger_type);
  if (!agentType) {
    console.warn(`[agents] no agent for trigger_type=${trigger.trigger_type}`);
    updateTriggerStatus(trigger.id, 'skipped', new Date().toISOString());
    return;
  }
  const registered = getRegisteredAgent(agentType);
  if (!registered) {
    console.warn(`[agents] handler ${agentType} not registered`);
    updateTriggerStatus(trigger.id, 'skipped', new Date().toISOString());
    return;
  }

  const unit = trigger.context_unit_id ? getContextUnitById(trigger.context_unit_id) : null;
  // MVP8.1: pre-allocate runId so the assembled packet & all downstream proposals
  // can reference the same id. createAgentRun writes the initial 'queued' row.
  const runId = randomUUID();
  const now0 = new Date().toISOString();
  const baseRow: AgentRunRow = {
    id: runId,
    trigger_id: trigger.id,
    agent_type: agentType,
    input_json: '{}',          // placeholder, replaced once packet is assembled
    output_json: null,
    status: 'queued',
    error: null,
    started_at: null,
    completed_at: null,
    created_at: now0,
  };
  insertAgentRun(baseRow);

  // MVP8.2: 所有 internal agent run 都装配 packet，即使 slices=[] 也输出骨架，
  // 让 agent_runs.input_json 始终带 sliceVersion + materializedSlices 摘要。
  let packet: ReturnType<typeof assembleAgentContextPacket>;
  try {
    packet = assembleAgentContextPacket({
      agentRunId: runId,
      trigger,
      unit,
      slices: registered.slices,
      packetSliceVersion: registered.packetSliceVersion,
    });
  } catch (err) {
    console.error(
      `[agents] packet assembly failed for ${agentType}; this should not happen — investigate:`,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }

  // Persist input_json summary (packet 自身不入库；只落摘要 + 摘要 topItemIds)
  const inputSummary = buildInputSummary(trigger, unit, registered, packet);
  updateAgentRun(runId, { status: 'running', started_at: new Date().toISOString() });
  // Persist input_json after entries above to keep order readable in DB:
  // we have to call a separate update because updateAgentRun doesn't include input_json.
  // For MVP8.1 simplicity: re-write whole row's input_json via raw db patch.
  rewriteAgentRunInputJson(runId, inputSummary);

  const input: AgentInput = { trigger, unit, packet, agentRunId: runId };

  try {
    const output = await withTimeout(registered.handler(input), DEFAULT_TIMEOUT_MS);
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
      updateAgentRun(runId, { status: 'failed', error: msg, completed_at: completedAt });
      updateTriggerStatus(trigger.id, 'pending', completedAt);
      queue.push({ triggerId: trigger.id, attempt: item.attempt + 1 });
      return;
    }

    updateAgentRun(runId, { status: 'failed', error: msg, completed_at: completedAt });
    updateTriggerStatus(trigger.id, 'failed', completedAt);
    console.error(`[agents] ${agentType} permanently failed on trigger ${trigger.id}: ${msg}`);
  }
}

function buildInputSummary(
  trigger: TriggerRow,
  unit: ReturnType<typeof getContextUnitById>,
  registered: RegisteredAgent,
  packet: ReturnType<typeof assembleAgentContextPacket>
): Record<string, unknown> {
  const triggerPayload = safeJSON(trigger.payload_json) as Record<string, unknown> | null;
  return {
    trigger: {
      id: trigger.id,
      type: trigger.trigger_type,
      reasoning: trigger.reasoning,
      dueAt: trigger.due_at,
      payload: triggerPayload,
    },
    unit: unit
      ? { id: unit.id, kind: unit.kind, title: unit.title }
      : null,
    // packet summary（doc §5.3.4 schema）— MVP8.2 起始终非 null
    packetAssemblerVersion: PACKET_ASSEMBLER_VERSION,
    packetSliceVersion: packet.packetSliceVersion,
    materializedSlices: packet.materializedSlices.map((s) => ({
      name: s.name,
      itemCount: s.itemCount,
      topItemIds: s.topItemIds.slice(0, 3),
    })),
    focalUnitId: packet.focalUnit?.id ?? unit?.id ?? null,
    changeContext: packet.trigger.changeContext ?? null,
    declaredSlices: registered.slices,
  };
}

import { db } from '../db.js';
function rewriteAgentRunInputJson(id: string, summary: Record<string, unknown>) {
  db.prepare(`UPDATE agent_runs SET input_json = ? WHERE id = ?`).run(
    JSON.stringify(summary),
    id
  );
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
