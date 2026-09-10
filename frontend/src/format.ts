/** 남은 unlock 시간 — 일·시간·분으로 줄여 보인다 */
export function fmtRemain(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}
