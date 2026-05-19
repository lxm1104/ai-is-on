/**
 * 离线评测脚本。
 *
 * 用法：
 *   npx tsx apps/server/scripts/eval.ts mvp2 [--use-cached]
 *   npx tsx apps/server/scripts/eval.ts mvp3
 *
 * mvp2: 跑真实 Claude CLI，对 raw_signals + expected.json 评测召回/噪声等。
 * mvp3: 纯函数式 evaluator 规则边界测试，不调 LLM。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTriageUserMessage } from '../src/triage/triagePrompt.js';
import { runTriageOnce } from '../src/triage/backgroundRuntime.js';
import { parseTriageResult, type TriageItem } from '../src/triage/parseTriage.js';
import { evaluateUnit } from '../src/triggers/triggerEvaluator.js';
import type { ContextUnit } from '../src/context/ContextUnit.js';

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

type RawSignal = {
  id: string;
  source: string;
  kind: string;
  occurredAt: string;
  title?: string | null;
  text: string;
  actor?: string | null;
  url?: string | null;
};

type ExpectedCtx = {
  kindIn?: string[];
  mergeHintRegex?: string;
  requiredEntityNamesAny?: string[];
};

type ExpectedItem = {
  sourceEventId: string;
  label?: string;
  expectedRelevant?: boolean;
  expectedShouldCreateCard?: boolean;
  expectedPriorityAtMost?: 'P0' | 'P1' | 'P2' | 'P3';
  expectedContextUpdates?: ExpectedCtx[];
};

type ScoreLine = {
  id: string;
  label: string;
  relevant: { expected?: boolean; actual?: boolean; pass: boolean };
  card: { expected?: boolean; actual?: boolean; pass: boolean };
  priority: { expected?: string; actual?: string; pass: boolean };
  context: {
    expected: number;
    actual: number;
    matched: number;
    missed: string[];
    extra: number;
  };
};

async function main() {
  const arg = process.argv[2] ?? '';
  if (arg === 'mvp3') {
    runMvp3Eval();
    return;
  }
  const useCached = process.argv.includes('--use-cached');
  if (arg !== 'mvp2') {
    console.error('usage: npx tsx apps/server/scripts/eval.ts mvp2 [--use-cached] | mvp3');
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..');
  const fixtureDir = path.join(repoRoot, 'apps/server/test/fixtures/mvp2');
  const raw = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'raw_signals.json'), 'utf8')
  ) as { signals: RawSignal[] };
  const expected = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8')
  ) as { items: ExpectedItem[] };

  const expectedById = new Map(expected.items.map((e) => [e.sourceEventId, e]));
  const rawPath = path.join(fixtureDir, 'last_run.raw.txt');

  let llmText: string;
  let elapsed = 'cached';
  if (useCached) {
    if (!fs.existsSync(rawPath)) {
      console.error(`[eval] --use-cached: ${rawPath} not found; run once without flag first.`);
      process.exit(2);
    }
    llmText = fs.readFileSync(rawPath, 'utf8');
    console.error(`[eval] using cached LLM output from ${rawPath}`);
  } else {
    const userMessage = buildTriageUserMessage({ signals: raw.signals, userRules: [] });
    console.error(
      `[eval] running triage on ${raw.signals.length} signals (real Claude CLI, may take 1-3 min)...`
    );
    const t0 = Date.now();
    try {
      const r = await runTriageOnce(userMessage);
      elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      llmText = r.text;
      fs.writeFileSync(rawPath, llmText, 'utf8');
      console.error(`[eval] LLM responded in ${elapsed}; raw saved to ${rawPath}`);
    } catch (err) {
      console.error('[eval] triage failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  let parsed;
  try {
    parsed = parseTriageResult(llmText);
  } catch (err) {
    console.error(`[eval] parse failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[eval] inspect raw at ${rawPath}`);
    process.exit(1);
  }
  const byId = new Map(parsed.items.map((i) => [i.sourceEventId, i]));
  const lines: ScoreLine[] = [];
  for (const sig of raw.signals) {
    const exp = expectedById.get(sig.id);
    const act = byId.get(sig.id);
    lines.push(scoreOne(sig.id, exp, act));
  }
  report(lines, parsed.items, elapsed);
}

function scoreOne(
  id: string,
  exp: ExpectedItem | undefined,
  act: TriageItem | undefined
): ScoreLine {
  const label = exp?.label ?? '(no label)';
  const line: ScoreLine = {
    id,
    label,
    relevant: { expected: exp?.expectedRelevant, actual: act?.relevant, pass: true },
    card: {
      expected: exp?.expectedShouldCreateCard,
      actual: act?.shouldCreateCard,
      pass: true,
    },
    priority: {
      expected: exp?.expectedPriorityAtMost,
      actual: act?.priority,
      pass: true,
    },
    context: { expected: 0, actual: 0, matched: 0, missed: [], extra: 0 },
  };

  if (!exp) return line;
  if (!act) {
    line.relevant.pass = exp.expectedRelevant === undefined;
    line.card.pass = exp.expectedShouldCreateCard === undefined;
    line.priority.pass = exp.expectedPriorityAtMost === undefined;
    line.context.expected = exp.expectedContextUpdates?.length ?? 0;
    line.context.missed = (exp.expectedContextUpdates ?? []).map(
      (e) => `${e.kindIn?.join('|') ?? '?'}@${e.mergeHintRegex ?? ''}`
    );
    return line;
  }

  if (exp.expectedRelevant !== undefined) {
    line.relevant.pass = act.relevant === exp.expectedRelevant;
  }
  if (exp.expectedShouldCreateCard !== undefined) {
    line.card.pass = act.shouldCreateCard === exp.expectedShouldCreateCard;
  }
  if (exp.expectedPriorityAtMost !== undefined) {
    const expRank = PRIORITY_RANK[exp.expectedPriorityAtMost];
    const actRank = PRIORITY_RANK[act.priority];
    line.priority.pass = actRank <= expRank;
  }

  // context updates: match each expected against any actual
  const expCtx = exp.expectedContextUpdates ?? [];
  const actCtx = act.contextUpdates ?? [];
  line.context.expected = expCtx.length;
  line.context.actual = actCtx.length;
  const usedActual = new Set<number>();
  for (const ec of expCtx) {
    let matched = false;
    for (let i = 0; i < actCtx.length; i++) {
      if (usedActual.has(i)) continue;
      if (matchExpected(ec, actCtx[i])) {
        usedActual.add(i);
        line.context.matched++;
        matched = true;
        break;
      }
    }
    if (!matched) {
      line.context.missed.push(
        `${ec.kindIn?.join('|') ?? '?'} mergeHintRegex=${ec.mergeHintRegex ?? ''} entitiesAny=${ec.requiredEntityNamesAny?.join(',') ?? ''}`
      );
    }
  }
  line.context.extra = actCtx.length - usedActual.size;
  return line;
}

function matchExpected(exp: ExpectedCtx, actual: TriageItem['contextUpdates'][number]) {
  if (exp.kindIn && !exp.kindIn.includes(actual.kind)) return false;
  if (exp.mergeHintRegex) {
    const re = new RegExp(exp.mergeHintRegex);
    const hint = actual.mergeHint ?? '';
    const title = actual.title ?? '';
    if (!re.test(hint) && !re.test(title)) return false;
  }
  if (exp.requiredEntityNamesAny && exp.requiredEntityNamesAny.length > 0) {
    const names = (actual.entities ?? []).map((e) => e.name);
    const hit = exp.requiredEntityNamesAny.some((n) =>
      names.some((m) => m.includes(n) || n.includes(m))
    );
    if (!hit) return false;
  }
  return true;
}

function report(lines: ScoreLine[], allItems: TriageItem[], elapsed: string) {
  console.log('\n================= MVP2 EVAL =================');
  console.log(`fixtures: ${lines.length}`);
  console.log(`elapsed: ${elapsed}s`);

  let relPass = 0,
    relTotal = 0;
  let cardPass = 0,
    cardTotal = 0;
  let prPass = 0,
    prTotal = 0;
  let ctxExpected = 0,
    ctxMatched = 0,
    ctxExtra = 0;
  let noisePush = 0;
  let noiseExpected = 0;

  for (const l of lines) {
    if (l.relevant.expected !== undefined) {
      relTotal++;
      if (l.relevant.pass) relPass++;
    }
    if (l.card.expected !== undefined) {
      cardTotal++;
      if (l.card.pass) cardPass++;
      if (l.card.expected === false) {
        noiseExpected++;
        if (l.card.actual === true) noisePush++;
      }
    }
    if (l.priority.expected !== undefined) {
      prTotal++;
      if (l.priority.pass) prPass++;
    }
    ctxExpected += l.context.expected;
    ctxMatched += l.context.matched;
    ctxExtra += l.context.extra;
  }

  console.log('\n-- per-signal --');
  for (const l of lines) {
    const r = l.relevant.pass ? '✓' : '✗';
    const c = l.card.pass ? '✓' : '✗';
    const p = l.priority.pass ? '✓' : '✗';
    console.log(
      `[${l.id}] ${l.label}\n  relevant ${r} (${l.relevant.expected}→${l.relevant.actual})  card ${c} (${l.card.expected}→${l.card.actual})  priority ${p} (≤${l.priority.expected}, got ${l.priority.actual})  ctx ${l.context.matched}/${l.context.expected} matched, ${l.context.extra} extra`
    );
    for (const m of l.context.missed) console.log(`    MISSED: ${m}`);
  }

  console.log('\n-- aggregated --');
  console.log(
    `relevance:  ${pct(relPass, relTotal)}  (${relPass}/${relTotal} fixtures)`
  );
  console.log(
    `card-call:  ${pct(cardPass, cardTotal)}  (${cardPass}/${cardTotal} fixtures)`
  );
  console.log(
    `priority≤:  ${pct(prPass, prTotal)}  (${prPass}/${prTotal} fixtures)`
  );
  console.log(
    `ctx recall: ${pct(ctxMatched, ctxExpected)}  (${ctxMatched}/${ctxExpected} expected context units identified)`
  );
  console.log(
    `noise rate: ${pct(noisePush, noiseExpected)}  (${noisePush}/${noiseExpected} expected-noise signals were pushed as cards)`
  );
  console.log(`extra ctx units (over-extracted): ${ctxExtra}`);
  console.log('\nLLM raw items count:', allItems.length);
}

function pct(num: number, denom: number): string {
  if (denom === 0) return 'n/a';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

main();

// ============================== MVP3 ==============================

type Mvp3Case = {
  id: string;
  label: string;
  unit: ContextUnit;
  now: string;                                  // ISO time for evaluator
  expectedTriggerTypes: string[];               // unordered set
};

function buildMvp3Cases(): Mvp3Case[] {
  // Use a fixed wall-clock so the test is deterministic across runs.
  const NOW_ISO = '2026-05-19T10:00:00.000Z';
  const now = new Date(NOW_ISO).getTime();
  const dueIn = (minutes: number) =>
    new Date(now + minutes * 60_000).toISOString();

  const baseUnit = (over: Partial<ContextUnit>): ContextUnit => ({
    id: 'u-' + (over.id ?? randomLow()),
    subjectId: 'me',
    scope: 'work',
    origin: { kind: 'manual', refId: 'fix' },
    kind: 'event',
    title: '',
    content: '',
    entities: [],
    relations: [],
    actionability: 'record',
    confidence: 0.8,
    version: 1,
    status: 'active',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  });

  return [
    {
      id: 'mvp3-c-due-soon',
      label: 'commitment dueAt 2h later → commitment_due',
      unit: baseUnit({
        kind: 'commitment',
        title: '今晚 12 点前提 PR',
        time: { dueAt: dueIn(120) },
      }),
      now: NOW_ISO,
      expectedTriggerTypes: ['commitment_due'],
    },
    {
      id: 'mvp3-c-overdue',
      label: 'commitment dueAt 6h ago → commitment_due (overdue)',
      unit: baseUnit({
        kind: 'commitment',
        title: '昨天答应给小李的反馈',
        time: { dueAt: dueIn(-360) },
      }),
      now: NOW_ISO,
      expectedTriggerTypes: ['commitment_due'],
    },
    {
      id: 'mvp3-c-out-of-window',
      label: 'commitment dueAt 5 days later → no trigger (outside 24h)',
      unit: baseUnit({
        kind: 'commitment',
        title: '下周完成的小事',
        time: { dueAt: dueIn(5 * 24 * 60) },
      }),
      now: NOW_ISO,
      expectedTriggerTypes: [],
    },
    {
      id: 'mvp3-m-keyword-in-window',
      label: 'event "MVP2 设计评审" starts in 45 min → meeting_prepare',
      unit: baseUnit({
        kind: 'event',
        title: 'MVP2 设计评审',
        time: { startsAt: dueIn(45) },
      }),
      now: NOW_ISO,
      expectedTriggerTypes: ['meeting_prepare'],
    },
    {
      id: 'mvp3-m-no-keyword',
      label: 'event "随便聊聊" starts in 45 min → no trigger (no keyword)',
      unit: baseUnit({
        kind: 'event',
        title: '随便聊聊',
        time: { startsAt: dueIn(45) },
      }),
      now: NOW_ISO,
      expectedTriggerTypes: [],
    },
    {
      id: 'mvp3-m-too-early',
      label: 'event "评审" starts in 2h → no trigger (outside 30-60min window)',
      unit: baseUnit({
        kind: 'event',
        title: '产品评审',
        time: { startsAt: dueIn(120) },
      }),
      now: NOW_ISO,
      expectedTriggerTypes: [],
    },
  ];
}

function runMvp3Eval() {
  const cases = buildMvp3Cases();
  console.log('================= MVP3 EVALUATOR EVAL =================');
  let pass = 0;
  for (const c of cases) {
    const drafts = evaluateUnit(c.unit, new Date(c.now).getTime());
    const got = drafts.map((d) => d.triggerType).sort();
    const expected = [...c.expectedTriggerTypes].sort();
    const ok =
      got.length === expected.length && got.every((t, i) => t === expected[i]);
    console.log(
      `${ok ? '✓' : '✗'} [${c.id}] ${c.label}\n    expected=[${expected.join(',')}] got=[${got.join(',')}]`
    );
    if (ok) pass++;
  }
  console.log(`\nresult: ${pass}/${cases.length} pass (${((pass / cases.length) * 100).toFixed(1)}%)`);
  process.exit(pass === cases.length ? 0 : 1);
}

function randomLow(): string {
  return Math.random().toString(36).slice(2, 8);
}
