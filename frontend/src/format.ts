/** ms → "2일 23시간" / "3시간 5분" / "12분" — 긴 unlock TTL을 분으로만 보이면 감이 안 온다 */
export function fmtRemain(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d}일 ${h}시간` : `${d}일`;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  return `${m}분`;
}
