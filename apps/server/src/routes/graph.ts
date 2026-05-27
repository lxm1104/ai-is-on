/**
 * MVP15A §7.7 — Graph API routes。
 *
 * - GET  /api/graph/my-collaborators?limit=20  → SelfCollaboratorRanking
 * - GET  /api/graph/person-graph                → 全部 person_person 边 + nodes
 * - GET  /api/graph/project-graph               → stub（MVP15C 完整做）
 * - GET  /api/graph/neighborhood?unitId=...     → stub（MVP15B 完整做）
 * - POST /api/graph/_inducer/run-once            → force=true 触发 inducer，return summary
 *
 * 所有 GET 路由先 await runGraphInducer({})（throttled，5min 内命中 cache 立刻返回）
 * 保证响应 data 永远基于最新归纳结果。
 */

import { Router } from 'express';
import { db, getContextEntityById, listEntityEdges } from '../db.js';
import { runGraphInducer, getLastRunAt } from '../context/graphInducer.js';
import { buildSelfCollaboratorRanking } from '../context/selfCollaboratorRanking.js';
import { resolveAliased } from '../context/entityResolver.js';
import {
  parsePersonAttributesFromRow,
  type PersonAttributes,
} from '../context/personAttributes.js';

export const graphRouter = Router();

function clampInt(v: unknown, defVal: number, max: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.min(n, max);
  return defVal;
}

// ----------------------------------------------------------------------------
// /api/graph/my-collaborators
// ----------------------------------------------------------------------------
graphRouter.get('/graph/my-collaborators', async (req, res) => {
  try {
    await runGraphInducer({});
    const limit = clampInt(req.query.limit, 20, 50);
    const entries = buildSelfCollaboratorRanking({ limit });
    res.json({
      entries,
      inducerLastRunAt: new Date(getLastRunAt()).toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ----------------------------------------------------------------------------
// /api/graph/person-graph
// ----------------------------------------------------------------------------
graphRouter.get('/graph/person-graph', async (req, res) => {
  try {
    await runGraphInducer({});
    const minWeight = (() => {
      const v = req.query.minWeight;
      if (typeof v !== 'string') return 0.5;
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : 0.5;
    })();
    const limit = clampInt(req.query.limit, 200, 500);

    const edges = listEntityEdges({
      kind: 'person_person',
      minWeight,
      limit,
    });

    // 收集 nodes
    const nodeIds = new Set<string>();
    for (const e of edges) {
      nodeIds.add(e.from_id);
      nodeIds.add(e.to_id);
    }
    const nodes: Array<{
      id: string;
      name: string;
      business?: string;
      functionLabel?: string;
      isSelf: boolean;
    }> = [];
    const selfId = ((
      db.prepare(`SELECT value FROM settings WHERE key='self_person_entity_id'`).get() as
        | { value: string }
        | undefined
    )?.value ?? '');
    const canonicalSelfId = selfId ? resolveAliased(selfId) : '';
    for (const id of nodeIds) {
      const row = getContextEntityById(id);
      if (!row) continue;
      const attrs: PersonAttributes | null = parsePersonAttributesFromRow(row as never);
      nodes.push({
        id,
        name: row.name,
        business: attrs?.larkDeptBusiness,
        functionLabel: attrs?.larkDeptFunctionLabel,
        isSelf: id === canonicalSelfId,
      });
    }
    // 边简化
    const edgesOut = edges.map((e) => ({
      from: e.from_id,
      to: e.to_id,
      weight: e.weight,
      businessRelation: e.business_relation,
      sharedProjects: e.shared_ids_json ? safeParseStringArray(e.shared_ids_json) : [],
    }));
    res.json({ nodes, edges: edgesOut });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ----------------------------------------------------------------------------
// /api/graph/project-graph (stub for MVP15C)
// ----------------------------------------------------------------------------
graphRouter.get('/graph/project-graph', async (_req, res) => {
  try {
    await runGraphInducer({});
    // MVP15A 不出 project↔project 边；只返回所有 person_project 端点的 project 节点。
    const edges = listEntityEdges({ kind: 'person_project', limit: 1000 });
    const projectNames = new Set<string>();
    for (const e of edges) projectNames.add(e.to_id);
    res.json({
      projects: Array.from(projectNames).map((name) => ({ canonicalName: name })),
      edges: [], // project↔project 推 MVP15C
      note: 'MVP15A: project↔project edges deferred to MVP15C',
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ----------------------------------------------------------------------------
// /api/graph/neighborhood?unitId=... (stub for MVP15B)
// ----------------------------------------------------------------------------
graphRouter.get('/graph/neighborhood', (req, res) => {
  const unitId = req.query.unitId;
  if (typeof unitId !== 'string' || !unitId) {
    res.status(400).json({ error: 'unitId required' });
    return;
  }
  res.json({
    unitId,
    note: 'MVP15A stub — full implementation in MVP15B assembleGraphContext',
  });
});

// ----------------------------------------------------------------------------
// POST /api/graph/_inducer/run-once  — force = true
// ----------------------------------------------------------------------------
graphRouter.post('/graph/_inducer/run-once', async (_req, res) => {
  try {
    const summary = await runGraphInducer({ force: true });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function safeParseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
  } catch {}
  return [];
}
