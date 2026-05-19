/**
 * MVP2 离线评测脚本。
 *
 * 用法：
 *   npx tsx apps/server/scripts/eval.ts mvp2
 *
 * 跑真实 Claude CLI（走 backgroundRuntime.runTriageOnce），结果与
 * test/fixtures/<mvpX>/expected.json 对比，输出召回/准确/噪声 三项指标。
 *
 * 不写 DB，纯 prompt→parse→比对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTriageUserMessage } from '../src/triage/triagePrompt.js';
import { runTriageOnce } from '../src/triage/backgroundRuntime.js';
import { parseTriageResult, type TriageItem } from '../src/triage/parseTriage.js';

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
  const useCached = process.argv.includes('--use-cached');
  if (arg !== 'mvp2') {
    console.error('usage: npx tsx apps/server/scripts/eval.ts mvp2 [--use-cached]');
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
