// 飞书部分 API 要求 ISO 8601 + 本地时区偏移（如 2026-05-18T08:00:00+08:00），
// 不接受 Z 结尾。这里统一生成本地 tz ISO。
export function toLocalTzIso(d: Date = new Date()): string {
  const tzOff = -d.getTimezoneOffset();
  const sign = tzOff >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(tzOff) / 60)).padStart(2, '0');
  const mm = String(Math.abs(tzOff) % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}
