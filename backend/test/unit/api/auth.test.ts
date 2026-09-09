/**
 * FronyAuth introspection 클라이언트 — 계약(project-auth docs/introspection.md) 준수 검증.
 * 실서버 없이 fetchImpl 주입으로 확인한다.
 */

import { describe, expect, it } from 'vitest';
import { createIntrospectionVerifier } from '@wallet/api';

function makeVerifier(
  responder: () => Response | Error,
  nowRef: { t: number },
  onCall?: () => void,
) {
  return createIntrospectionVerifier({
    url: 'http://fauth.test/introspect',
    serviceKey: 'frony_service',
    now: () => nowRef.t,
    fetchImpl: (async () => {
      onCall?.();
      const r = responder();
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch,
  });
}

const active = (caller: string, expiresAt: string | null = null) =>
  new Response(JSON.stringify({ active: true, type: 'key', caller, expires_at: expiresAt }), { status: 200 });

describe('introspection verifier', () => {
  it('caller 표기를 그대로 client로 쓴다 — "key:<기기명>"', async () => {
    const verify = makeVerifier(() => active('key:frony'), { t: 0 });
    expect(await verify('aira_token')).toEqual({ ok: true, client: 'key:frony' });
  });

  it('active:false는 401', async () => {
    const verify = makeVerifier(
      () => new Response(JSON.stringify({ active: false }), { status: 200 }),
      { t: 0 },
    );
    expect(await verify('bad')).toEqual({ ok: false, status: 401 });
  });

  it('양성 판정은 60초 캐시 — 재호출 없이 응답한다', async () => {
    const nowRef = { t: 0 };
    let calls = 0;
    const verify = makeVerifier(() => active('key:frony'), nowRef, () => calls++);
    await verify('tok');
    nowRef.t = 59_000;
    await verify('tok');
    expect(calls).toBe(1);
    nowRef.t = 60_000;
    await verify('tok');
    expect(calls).toBe(2);
  });

  it('expires_at이 60초보다 이르면 캐시가 그때까지만 (계약)', async () => {
    const nowRef = { t: 1_000_000 };
    let calls = 0;
    const verify = makeVerifier(
      () => active('oauth:Claude:admin', new Date(1_000_000 + 10_000).toISOString()),
      nowRef,
      () => calls++,
    );
    await verify('fbat_tok');
    nowRef.t = 1_000_000 + 9_000;
    await verify('fbat_tok');
    expect(calls).toBe(1);
    nowRef.t = 1_000_000 + 10_000;
    await verify('fbat_tok');
    expect(calls).toBe(2);
  });

  it('불통이면 503 (재시도 1회 포함 실패 시), 캐시가 남았으면 캐시 우선', async () => {
    const nowRef = { t: 0 };
    let fail = false;
    let calls = 0;
    const verify = makeVerifier(
      () => (fail ? new Error('down') : active('key:frony')),
      nowRef,
      () => calls++,
    );
    await verify('tok'); // 캐시 채움 (1회)
    fail = true;
    nowRef.t = 30_000;
    expect(await verify('tok')).toEqual({ ok: true, client: 'key:frony' }); // 캐시로 흡수
    expect(calls).toBe(1);
    nowRef.t = 61_000; // 캐시 만료
    expect(await verify('tok')).toEqual({ ok: false, status: 503 });
    expect(calls).toBe(3); // 재시도 1회 = 2회 호출
  });

  it('non-200 응답도 503 — 판정 실패지 키 오류가 아니다', async () => {
    const verify = makeVerifier(() => new Response('oops', { status: 500 }), { t: 0 });
    expect(await verify('tok')).toEqual({ ok: false, status: 503 });
  });
});
