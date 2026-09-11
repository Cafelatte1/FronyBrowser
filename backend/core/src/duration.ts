/**
 * `"10m"` 같은 기간 문자열 → ms. 환경변수 파싱에 쓴다.
 *
 * fail-closed: 형식이 어긋나면 던진다 — 오타 난 TTL이 조용히 기본값으로 흐르지 않게.
 */

const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

export function parseDuration(raw: unknown, field: string): number {
  if (typeof raw !== 'string') throw new Error(`${field}: duration 문자열이어야 함`);
  const m = raw.match(DURATION);
  if (!m) throw new Error(`${field}: "10m"/"90s" 형식이어야 함 (받음: "${raw}")`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}
