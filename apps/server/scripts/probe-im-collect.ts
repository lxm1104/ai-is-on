// MVP33 诊断探针：以指定 since 跑一次 imCollector.collect，观察 clamp 日志与水位。
// 只读不写（collect 仅返回 signals，事件写入是 scheduler 的事）。
// Run: cd apps/server && npx tsx ../../temp/probe-im-collect.ts
const { imCollector } = await import('../src/collectors/imCollector.js');

const since = new Date(process.argv[2] ?? '2026-06-11T03:55:40.163Z');
console.log(`[probe] collect since=${since.toISOString()}`);
const t0 = Date.now();
const r = await imCollector.collect(since);
console.log(
  `[probe] done in ${Math.round((Date.now() - t0) / 1000)}s — signals=${r.signals.length} coveredUntil=${r.coveredUntil}`
);
for (const s of r.signals.slice(0, 10)) {
  console.log(`[probe] signal ${s.kind} @ ${s.occurredAt} ${String(s.title).slice(0, 40)}`);
}
process.exit(0);
