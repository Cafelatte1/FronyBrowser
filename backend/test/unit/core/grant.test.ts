/**
 * pay grant 검증 (FWL-022, 규칙 13).
 *
 * 이 파일이 지키는 것: 위조·재사용·만료·세션 도용이 전부 거부되는가.
 * 하나라도 통과하면 "돌이킬 수 없는 행위의 열쇠"가 grant 없이 열린다.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { markGrantUsed, verifyPayGrant } from '@wallet/core';
import type { PayGrantPayload } from '@wallet/core';
import { signPayGrant } from '../../helpers/fakes.js';

const KEY = 'shared-secret-between-shopping-and-wallet';
const SID = 'sess-abc';
const NOW = 1_800_000_000_000; // ms

function payload(over: Partial<PayGrantPayload> = {}): PayGrantPayload {
  const iat = Math.floor(NOW / 1000);
  return { v: 1, txn_id: 'txn-1', session_id: SID, max_total: 20000, iat, exp: iat + 300, ...over };
}

function ctx(over: { sessionId?: string; nowMs?: number; used?: Set<string> } = {}) {
  return { sessionId: over.sessionId ?? SID, nowMs: over.nowMs ?? NOW, used: over.used ?? new Set<string>() };
}

describe('verifyPayGrant', () => {
  it('유효한 토큰은 통과하고 payload를 그대로 돌려준다', () => {
    const p = payload();
    const r = verifyPayGrant(signPayGrant(p, KEY), KEY, ctx());
    expect(r).toEqual({ ok: true, payload: p });
  });

  it('1회용 — markGrantUsed로 표시한 토큰은 reused', () => {
    const token = signPayGrant(payload(), KEY);
    const c = ctx();
    expect(verifyPayGrant(token, KEY, c).ok).toBe(true);
    markGrantUsed(c.used, token);
    expect(verifyPayGrant(token, KEY, c)).toEqual({ ok: false, reason: 'reused' });
  });

  it('검증만으로는 태우지 않는다 — 실패한 행위가 grant를 날리면 안 된다 (FWL-033)', () => {
    const token = signPayGrant(payload(), KEY);
    const c = ctx();
    expect(verifyPayGrant(token, KEY, c).ok).toBe(true);
    expect(c.used.size).toBe(0);
    expect(verifyPayGrant(token, KEY, c).ok).toBe(true);
  });

  it('payload를 건드리면 bad_signature — 금액·세션을 바꿔치기할 수 없다', () => {
    const token = signPayGrant(payload(), KEY);
    const [, , sig] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify(payload({ max_total: 9_999_999 })), 'utf8').toString('base64url');
    expect(verifyPayGrant(`pg1.${forged}.${sig}`, KEY, ctx())).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('서명을 건드리면 bad_signature — 길이가 달라도 던지지 않는다', () => {
    const [, seg, sig] = signPayGrant(payload(), KEY).split('.') as [string, string, string];
    expect(verifyPayGrant(`pg1.${seg}.${sig.slice(0, -1)}A`, KEY, ctx())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyPayGrant(`pg1.${seg}.AAAA`, KEY, ctx())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyPayGrant(`pg1.${seg}.`, KEY, ctx())).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('다른 키로 서명된 토큰은 bad_signature', () => {
    const token = signPayGrant(payload(), 'another-secret');
    expect(verifyPayGrant(token, KEY, ctx())).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('exp가 지났으면 expired — 경계(exp == now)도 거부한다', () => {
    const p = payload();
    const token = signPayGrant(p, KEY);
    expect(verifyPayGrant(token, KEY, ctx({ nowMs: p.exp * 1000 }))).toEqual({ ok: false, reason: 'expired' });
    expect(verifyPayGrant(token, KEY, ctx({ nowMs: p.exp * 1000 - 1 })).ok).toBe(true);
  });

  it('다른 세션에서 재생하면 session_mismatch', () => {
    const token = signPayGrant(payload(), KEY);
    expect(verifyPayGrant(token, KEY, ctx({ sessionId: 'sess-other' }))).toEqual({
      ok: false,
      reason: 'session_mismatch',
    });
  });

  it('형식이 아니면 malformed — 서명이 맞아도 payload가 계약을 안 지키면 거부', () => {
    for (const junk of ['', 'garbage', 'pg1.only-two', 'pg1.a.b.c', 'pg2.a.b']) {
      expect(verifyPayGrant(junk, KEY, ctx()), junk).toEqual({ ok: false, reason: 'malformed' });
    }
    // 서명은 유효하지만 본문이 계약 위반인 것들
    for (const bad of [
      'not json',
      JSON.stringify({ v: 2, txn_id: 't', session_id: SID, max_total: 1, iat: 1, exp: 9_999_999_999 }),
      JSON.stringify({ v: 1, session_id: SID, max_total: 1, iat: 1, exp: 9_999_999_999 }),
      JSON.stringify({ v: 1, txn_id: 't', session_id: SID, max_total: 1.5, iat: 1, exp: 9_999_999_999 }),
      JSON.stringify([1, 2, 3]),
    ]) {
      const seg = Buffer.from(bad, 'utf8').toString('base64url');
      const sig = createHmac('sha256', KEY).update(seg, 'ascii').digest('base64url');
      expect(verifyPayGrant(`pg1.${seg}.${sig}`, KEY, ctx()), bad).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('거부된 토큰은 used에 쌓이지 않는다 — 유효해지면 한 번은 쓸 수 있어야 한다', () => {
    const used = new Set<string>();
    const p = payload();
    const token = signPayGrant(p, KEY);
    expect(verifyPayGrant(token, KEY, ctx({ sessionId: 'sess-other', used })).ok).toBe(false);
    expect(used.size).toBe(0);
    expect(verifyPayGrant(token, KEY, ctx({ used })).ok).toBe(true);
  });
});
