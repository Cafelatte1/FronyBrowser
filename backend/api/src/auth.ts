/**
 * FronyAuth introspection 위임 (8.4). 자체 토큰 파일은 없다.
 *
 * 요청의 Bearer를 `POST /introspect`로 원격 검증한다. 판정 캐시는
 * sha256(token) 기준 양성 60초 / 음성 5초. FronyAuth 불통이면 TTL이 남은
 * 캐시만 유효하고, 캐시가 없으면 503 fail-closed — 401을 돌려주면
 * "키가 틀렸다"는 오판을 만든다.
 */

import { createHash } from 'node:crypto';

export type AuthDecision =
  | { readonly ok: true; readonly client: string }
  | { readonly ok: false; readonly status: 401 | 503 };

export type Verifier = (bearer: string) => Promise<AuthDecision>;

export type IntrospectionOptions = {
  /** 예: http://<fronyauth-host>:8640/introspect */
  readonly url: string;
  /** FronyBrowser 자신의 서비스 키 (fauth keygen FronyBrowser) */
  readonly serviceKey: string;
  readonly activeTtlMs?: number;
  readonly inactiveTtlMs?: number;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
};

type CacheEntry = { readonly decision: AuthDecision; readonly expiresAt: number };

export function createIntrospectionVerifier(opts: IntrospectionOptions): Verifier {
  const activeTtl = opts.activeTtlMs ?? 60_000;
  const inactiveTtl = opts.inactiveTtlMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new Map<string, CacheEntry>();

  return async (bearer) => {
    const key = createHash('sha256').update(bearer, 'utf8').digest('hex');
    const cached = cache.get(key);
    if (cached && now() < cached.expiresAt) return cached.decision;

    // 계약 권장: 타임아웃 2초, 재시도 1회 (introspection.md)
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2 && res === null; attempt++) {
      try {
        res = await doFetch(opts.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.serviceKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: bearer }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        res = null;
      }
    }
    if (res === null) {
      // FronyAuth 불통 — TTL 남은 캐시가 위에서 이미 반환됐다. 여기선 503뿐이다
      return { ok: false, status: 503 };
    }

    if (!res.ok) return { ok: false, status: 503 };

    let body: { active?: boolean; caller?: string; expires_at?: string | null };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { ok: false, status: 503 };
    }

    // caller는 계약의 표기 그대로 쓴다 ("key:<기기명>" / "oauth:<앱>:<subject>") —
    // 감사 로그와 WALLET_ADMIN_CLIENTS 매칭 모두 이 표기 기준이다
    const decision: AuthDecision =
      body.active === true && typeof body.caller === 'string'
        ? { ok: true, client: body.caller }
        : { ok: false, status: 401 };

    // active 캐시는 60초 상한이되 expires_at이 더 이르면 그때까지만 (계약)
    let ttl = decision.ok ? activeTtl : inactiveTtl;
    if (decision.ok && typeof body.expires_at === 'string') {
      const until = Date.parse(body.expires_at) - now();
      if (Number.isFinite(until)) ttl = Math.max(0, Math.min(ttl, until));
    }
    cache.set(key, { decision, expiresAt: now() + ttl });
    return decision;
  };
}
