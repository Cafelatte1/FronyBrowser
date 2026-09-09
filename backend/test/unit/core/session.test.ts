/**
 * 세션 발급·origin 배타 리스·TTL (5절, 8.5).
 */

import { describe, expect, it } from 'vitest';
import { createSessionStore } from '@wallet/core';

function store(opts: { ttlMs?: number; maxConcurrent?: number; now?: () => number } = {}) {
  return createSessionStore({
    ttlMs: opts.ttlMs ?? 60_000,
    maxConcurrent: opts.maxConcurrent ?? 4,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

describe('session store', () => {
  const SHOP = { origin: 'https://shop.com' };
  const OTHER = { origin: 'https://other.com' };
  const HL = { kind: 'browser', browser: 'chromium', headless: true } as const;

  it('서버가 불투명 id를 발급한다 (규칙 8)', () => {
    const s = store();
    const r = s.begin('frony', SHOP, HL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.id).toMatch(/^s_[0-9a-f]{32}$/);
      expect(s.get(r.session.id)?.client).toBe('frony');
      expect(s.get(r.session.id)).toMatchObject({ origin: 'https://shop.com', kind: 'browser', profile: { kind: 'browser', browser: 'chromium', headless: true } });
    }
  });

  it('최대 동시 수를 넘으면 session_limit', () => {
    const s = store({ maxConcurrent: 1 });
    expect(s.begin('a', SHOP, HL).ok).toBe(true);
    expect(s.begin('b', OTHER, HL)).toEqual({ ok: false, code: 'session_limit' });
  });

  it('세션 = origin 하나 — 같은 origin 두 번째 begin은 lease_conflict, 다른 origin은 통과', () => {
    const s = store();
    expect(s.begin('a', SHOP, HL).ok).toBe(true);
    expect(s.begin('b', SHOP, HL)).toEqual({ ok: false, code: 'lease_conflict' });
    expect(s.begin('b', OTHER, { browser: 'chrome', headless: false }).ok).toBe(true);
  });

  it('같은 클라이언트가 쥔 origin은 이어받는다 — 이전 세션은 사라지고 replaced로 돌아온다 (FWL-036)', () => {
    const s = store({ maxConcurrent: 1 });
    const a = s.begin('a', SHOP, HL);
    if (!a.ok) throw new Error('begin failed');
    const again = s.begin('a', SHOP, HL);
    if (!again.ok) throw new Error('takeover failed');
    expect(again.replaced?.id).toBe(a.session.id);
    expect(again.session.id).not.toBe(a.session.id);
    expect(s.get(a.session.id)).toBeUndefined();
    expect(s.get(again.session.id)).toBeDefined();
    // maxConcurrent 1인데도 통과했다 — 이전 세션 자리가 먼저 비워진다
    expect(s.begin('b', SHOP, HL)).toEqual({ ok: false, code: 'lease_conflict' });
  });

  it('1초 TTL 스토어는 1초에 만료된다 — 짧은 TTL도 그대로 지켜진다 (FWL-036)', () => {
    let t = 0;
    const s = store({ ttlMs: 1000, now: () => t });
    const a = s.begin('a', SHOP, HL);
    if (!a.ok) throw new Error('begin failed');
    t = 999;
    expect(s.get(a.session.id)).toBeDefined();
    t = 1000;
    expect(s.sweepExpired().map((x) => x.id)).toEqual([a.session.id]);
  });

  it('세션 종료 시 리스가 풀린다', () => {
    const s = store();
    const a = s.begin('a', SHOP, HL);
    if (!a.ok) throw new Error('begin failed');
    s.end(a.session.id, 'normal');
    expect(s.begin('b', SHOP, HL).ok).toBe(true);
  });

  it('TTL 만료 세션은 사라지고 리스도 풀린다', () => {
    let t = 0;
    const s = store({ ttlMs: 1000, now: () => t });
    const a = s.begin('a', SHOP, HL);
    if (!a.ok) throw new Error('begin failed');
    t = 1000;
    expect(s.get(a.session.id)).toBeUndefined();
    expect(s.begin('b', SHOP, HL).ok).toBe(true);
  });

  it('touch는 TTL을 연장한다 — 승인 대기 중 세션이 죽으면 안 된다', () => {
    let t = 0;
    const s = store({ ttlMs: 1000, now: () => t });
    const a = s.begin('a', SHOP, HL);
    if (!a.ok) throw new Error('begin failed');
    t = 900;
    s.touch(a.session.id);
    t = 1500; // 최초 만료 시점은 지났지만 touch로 연장됨
    expect(s.get(a.session.id)).toBeDefined();
  });
});
