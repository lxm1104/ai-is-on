// 看板标题相对日期治理（2026-06-12）。
//
// 背景：prompt v3 已禁止标题用相对日期，但 turbo（无 thinking）偶发不守
// （实测 6/11「今日 14:00」、6/12「CLI POC 明天到期」）。相对日期跨天即错，
// 而卡片可能存活 24h（TTL）。
//
// 思路：与其追着 prompt 补丁，不如解析处确定性改写 —— 生成时刻的「明天」
// 语义精确等于 run 日期 +1，按本地时区替换成「M/D」零语义损失。
// 只动 title（why 允许相对表达，因为带证据上下文）。

const RELATIVE_DAYS: Array<[word: string, offsetDays: number]> = [
  // 顺序重要：「大后天」必须在「后天」前，否则被部分替换成「大M/D」。
  ['大后天', 3],
  ['后天', 2],
  ['明天', 1],
  ['今天', 0],
  ['今日', 0],
];

/** 把标题里的相对日期词替换为本地时区的绝对「M/D」。无命中原样返回。 */
export function absolutizeRelativeDatesInTitle(title: string, now: Date = new Date()): string {
  let out = title;
  for (const [word, offset] of RELATIVE_DAYS) {
    if (!out.includes(word)) continue;
    const d = new Date(now.getTime() + offset * 86_400_000);
    out = out.split(word).join(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  return out;
}

/**
 * churn guard v2（2026-06-12）：标题等价 = 同内容。
 * 背景：模型每轮重发同事卡时引用的 signalIds 常略有出入 → 集合等价判不出 →
 * 「杀旧建新」洗牌（created_at 重置、用户状态丢失，实测 5min 内同标题卡成对
 * superseded+新建）。标题归一化（去空白+小写）后全等，视为同一张卡。
 */
export function titlesEquivalent(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase();
  const na = norm(a);
  return na !== '' && na === norm(b);
}
