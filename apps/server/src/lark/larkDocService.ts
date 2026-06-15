/**
 * MVP35 — 执行腿「内部可逆」动作：AI 起草并新建飞书文档。
 *
 * 与 IM 代发不同，建文档是**内部、可逆**（草稿态、未分享、可删）动作，且 `docx:document:create`
 * scope 已授权 → 无需用户额外授权即可执行/验证。仍遵守 execute-on-confirm：confirm 必填。
 *
 * v1 内容**确定性生成**（标题 + 当前摘要 + 下一步 + 相关上下文证据），不依赖慢 LLM —— 快、稳、可即时验证。
 * 这是一份带头的草稿骨架，用户在其上补完即可。LLM 富文本起草留作后续增量。
 *
 * 去重：docs +create 无 idempotency-key，故复用 external_task_bindings（provider='lark_doc'）本地去重。
 */
import { randomUUID } from 'node:crypto';
import {
  getCard,
  getExternalTaskBindingByIdempotency,
  matchMatterId,
  updateCardStatus,
  upsertExternalTaskBinding,
} from '../db.js';
import { writeAudit } from '../boundary/auditLog.js';
import { getContextUnitById, upsertContextUnit } from '../context/contextStore.js';
import type { ContextEntityRef } from '../context/ContextUnit.js';
import { runLarkCli } from '../util/larkCli.js';
import {
  getAttentionItem,
  updateAttentionItemStatus,
} from '../attention/attentionStore.js';
import { projectAttentionItemToCard } from '../attention/attentionProjection.js';
import { recordAttentionInteraction } from '../attention/attentionInteractions.js';
import { rowToCard } from '../cards/cardsService.js';
import { attachMatterContextLink, getMatterById } from '../matter/matterStore.js';
import { enqueueAttentionTickSoon } from '../attention/attentionEngine.js';
import { broadcast } from '../ws.js';
import type { SignalCard } from '../claude/protocol.js';

const MAX_EVIDENCE = 6;

export type CreateDocInput = {
  cardId: string;
  title?: string;
  confirm: boolean;
  dryRun?: boolean;
};

export type CreateDocResult = {
  ok: true;
  documentId?: string;
  url?: string;
  title: string;
  resultUnitId: string;
  reused: boolean;
  dryRun?: boolean;
  card?: SignalCard;
};

export type DocDeps = {
  runLarkCli?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
};

type DocSource = {
  sourceKind: 'attention' | 'card';
  sourceRefId: string;
  title: string;
  summary?: string;
  nextAction?: string;
  matterId?: string;
  signalIds: string[];
};

function resolveSource(cardId: string): DocSource {
  const attn = getAttentionItem(cardId);
  if (attn) {
    const matterId = attn.matterId ? matchMatterId(attn.matterId) ?? undefined : undefined;
    const matter = matterId ? getMatterById(matterId) : null;
    return {
      sourceKind: 'attention',
      sourceRefId: attn.id,
      title: matter?.title || attn.title,
      summary: matter?.currentSummary || attn.why,
      nextAction: matter?.nextAction ?? attn.suggestedAction ?? undefined,
      matterId,
      signalIds: attn.signalIds,
    };
  }
  const row = getCard(cardId);
  if (!row) throw new Error('card not found');
  return {
    sourceKind: 'card',
    sourceRefId: row.id,
    title: row.title,
    summary: row.summary,
    nextAction: row.suggested_action ?? undefined,
    signalIds: row.raw_event_id ? [row.raw_event_id] : [],
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildDocContent(source: DocSource, title: string): string {
  const parts: string[] = [`<title>${xmlEscape(title)}</title>`];
  parts.push('<p>本文档由 AI is ON 根据相关事项自动整理为草稿，请在此基础上补充完善。</p>');
  if (source.summary?.trim()) {
    parts.push('<h1>当前情况</h1>');
    parts.push(`<p>${xmlEscape(source.summary.trim())}</p>`);
  }
  if (source.nextAction?.trim()) {
    parts.push('<h1>下一步</h1>');
    parts.push(`<p>${xmlEscape(source.nextAction.trim())}</p>`);
  }
  const evidence: string[] = [];
  for (const sid of source.signalIds.slice(0, MAX_EVIDENCE)) {
    const u = getContextUnitById(sid);
    if (u) {
      const line = `${u.title}${u.content ? '：' + u.content.slice(0, 120) : ''}`;
      evidence.push(`<li>${xmlEscape(line)}</li>`);
    }
  }
  if (evidence.length) {
    parts.push('<h1>相关上下文</h1>');
    parts.push(`<ul>${evidence.join('')}</ul>`);
  }
  return parts.join('');
}

export async function createDocFromCard(
  input: CreateDocInput,
  deps: DocDeps = {}
): Promise<CreateDocResult> {
  if (!input.confirm) throw new Error('confirm is required before creating a Lark doc');
  const source = resolveSource(input.cardId);
  const title = (input.title?.trim() || source.title || '未命名文档').slice(0, 120);
  const idempotencyKey = `doc:${source.sourceRefId}:${title}`;

  // 去重：同来源同标题已建过 → 复用（dry-run 不查/不写绑定）
  if (!input.dryRun) {
    const existing = getExternalTaskBindingByIdempotency('lark_doc', idempotencyKey);
    if (existing && existing.result_unit_id) {
      const card = markActed(source);
      return {
        ok: true,
        documentId: existing.external_guid,
        url: existing.external_url ?? undefined,
        title,
        resultUnitId: existing.result_unit_id,
        reused: true,
        card,
      };
    }
  }

  const content = buildDocContent(source, title);
  const args = ['docs', '+create', '--api-version', 'v2', '--content', content, '--format', 'json'];
  if (input.dryRun) args.push('--dry-run');

  const run = deps.runLarkCli ?? runLarkCli;
  let documentId: string | undefined;
  let url: string | undefined;
  try {
    const { code, stdout, stderr } = await run(args);
    if (code !== 0) throw new Error(`lark-cli exit ${code}: ${(stderr || stdout).slice(-300)}`);
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      documentId = findStringByKey(parsed, ['document_id', 'documentId', 'doc_token', 'token', 'obj_token']);
      url = findStringByKey(parsed, ['url', 'app_link', 'appLink']);
    } catch {
      // 非 JSON 不阻塞
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const friendly = /docx:document:create|missing_scopes/.test(rawMsg)
      ? '尚未授权「创建飞书文档」。请运行：lark-cli auth login --scope "docx:document:create" 完成浏览器验证后重试。'
      : rawMsg;
    writeAudit({
      action: 'lark_doc_failed',
      reason: `新建飞书文档${input.dryRun ? '(dry-run)' : ''}失败：${title}`,
      cardId: source.sourceRefId,
      payload: { dryRun: input.dryRun === true, error: rawMsg },
    });
    throw new Error(friendly);
  }

  // dry-run：命令受理但未真正创建 → 不写回/不标记/不绑定
  if (input.dryRun) {
    return { ok: true, documentId, url, title, resultUnitId: '', reused: false, dryRun: true };
  }

  const now = new Date().toISOString();
  const docEntities: ContextEntityRef[] = documentId
    ? [{ type: 'doc', name: `lark_doc:${documentId}`, aliases: url ? [url] : undefined, role: 'target', confidence: 1 }]
    : [];
  const resultUnit = upsertContextUnit({
    kind: 'action_result',
    title: `已新建文档：${title}`,
    content: [`已在飞书创建文档草稿：${title}`, url ? `链接：${url}` : '', `来源：${source.title}`]
      .filter(Boolean)
      .join('\n'),
    entities: docEntities,
    scope: 'work',
    origin: { kind: 'card_action', refId: source.sourceRefId },
    actionability: 'record',
    confidence: 1,
    mergeHint: `lark_doc:${documentId ?? idempotencyKey}`,
    silent: true,
  }).unit;

  if (documentId) {
    upsertExternalTaskBinding({
      id: randomUUID(),
      provider: 'lark_doc',
      external_guid: documentId,
      external_url: url ?? null,
      source_kind: source.sourceKind,
      source_ref_id: source.sourceRefId,
      commitment_unit_id: null,
      result_unit_id: resultUnit.id,
      status: 'created',
      idempotency_key: idempotencyKey,
      raw_json: null,
      created_at: now,
      updated_at: now,
    });
  }

  if (source.matterId && getMatterById(source.matterId)) {
    attachMatterContextLink({
      matterId: source.matterId,
      contextUnitId: resultUnit.id,
      relation: 'progressed_by',
      effect: 'progress',
      confidence: 0.9,
      reason: 'AI 新建文档草稿（用户确认）',
      now,
    });
  }

  writeAudit({
    action: 'lark_doc_created',
    reason: `已新建飞书文档：${title}`,
    cardId: source.sourceRefId,
    payload: { documentId, url, resultUnitId: resultUnit.id },
  });

  const card = markActed(source);
  return { ok: true, documentId, url, title, resultUnitId: resultUnit.id, reused: false, card };
}

function markActed(source: DocSource): SignalCard | undefined {
  const now = new Date().toISOString();
  if (source.sourceKind === 'attention') {
    const attn = getAttentionItem(source.sourceRefId);
    if (attn) {
      recordAttentionInteraction(attn, 'create_task', now); // 复用既有交互类型（建产物类）
      const updated = updateAttentionItemStatus(attn.id, 'acted', now);
      enqueueAttentionTickSoon();
      if (updated) {
        const card = projectAttentionItemToCard(updated);
        broadcast({ type: 'card_updated', card });
        return card;
      }
    }
    return undefined;
  }
  const updated = updateCardStatus(source.sourceRefId, 'acknowledged', now);
  if (updated) {
    const card = rowToCard(updated);
    broadcast({ type: 'card_updated', card });
    return card;
  }
  return undefined;
}

function findStringByKey(raw: unknown, keys: string[], depth = 0): string | undefined {
  if (!raw || typeof raw !== 'object' || depth > 5) return undefined;
  const obj = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = findStringByKey(item, keys, depth + 1);
        if (found) return found;
      }
    } else if (v && typeof v === 'object') {
      const found = findStringByKey(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
