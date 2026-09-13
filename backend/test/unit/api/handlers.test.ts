/**
 * 핸들러 통합 테스트 — 브라우저 없이 가짜 ActionTarget으로.
 * fill 경로의 정책·금고·감사·응답 규칙(값 미반환)을 검증한다.
 */

import type { Ref, SessionId } from '@wallet/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestMode } from '@wallet/core';
import { VaultLockedError, createMemoryAudit, createMemoryOriginProfiles, createMemoryTestMode, createSessionStore, createVault, writeVaultFile } from '@wallet/core';
import { describe, expect, it } from 'vitest';
import { TargetError } from '@wallet/app';
import { createHandlers } from '@wallet/api';
import { fakeCipher, fakeTarget, fakeVault } from '../../helpers/fakes.js';
import { freshGrant } from '../../helpers/fakes.js';
import type { FakeTargetOptions } from '../../helpers/fakes.js';

const GRANT_KEY = 'test-grant-key';

const ENTRIES = {
  'profile.personal.phone': { type: 'phone', value: '01012345678', grant: false, label: 'Mobile' },
  'card.personal.number': { type: 'card', value: '1234567812345678', grant: false, label: 'Card number' },
  'shop.payment.pinnumber': { type: 'text', value: '1234', grant: true, label: 'Payment PIN' },
  'shop.keypad.pin': { type: 'text', value: '739105', grant: false, label: 'Pin' },
  'shop.keypad.broken': { type: 'text', value: 'ab-cd', grant: false, label: 'Broken' },
  'shop.keypad.grantpin': { type: 'text', value: '5678', grant: true, label: 'Grantpin' },
  'shop.keypad.sprite': { type: 'text', value: '4951', grant: false, label: 'Sprite' },
} as const;

const KEYPAD = { digitSelector: "img.kpd[aria-label='{digit}']" };
const SPRITE = { keySelector: 'a.pad-key', cellSelector: 'span[class^=pad-pos-]', resolver: 'sprite-template' } as const;

function setup(over: FakeTargetOptions = {}, now?: () => number, testMode?: TestMode) {
  const state = fakeTarget({ url: 'https://shop.com/checkout', ...over });
  const audit = createMemoryAudit();
  const handlers = createHandlers({
    vault: fakeVault({ entries: { ...ENTRIES } }),
    sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2, ...(now ? { now } : {}) }),
    targets: new Map([['browser', state.target]]),
    audit,
    grantKey: GRANT_KEY,
    ...(testMode ? { testMode } : {}),
  });
  return { handlers, audit, state };
}

const caller = { client: 'frony' };
const ref = '1:e1' as Ref;

async function begin(handlers: ReturnType<typeof createHandlers>, origin = 'https://shop.com') {
  const r = await handlers.session_begin(caller, { origin });
  if (!r.ok) throw new Error('begin failed');
  return r.sessionId;
}

describe('fill', () => {
  it('플레이스홀더를 치환해 입력하고, 응답에는 키 이름과 길이만 담는다', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '{{vault:profile.personal.phone}}');
    expect(r).toEqual({ ok: true, filledFrom: 'profile.personal.phone', len: 11 });
    expect(state.filled[0]?.value).toBe('01012345678'); // 브라우저로는 실제 값
    const fillLog = audit.records.find((x) => x.evt === 'fill');
    expect(fillLog).toMatchObject({ key: 'profile.personal.phone', len: 11, origin: 'https://shop.com' });
    expect(JSON.stringify(fillLog)).not.toContain('01012345678'); // 감사 로그에 값 없음 (규칙 5)
  });

  it('어느 프레임 origin이든 채운다 — origin 규칙 없음 (FWL-055)', async () => {
    const { handlers, audit, state } = setup({ frameOrigin: 'https://pay.pg.com' });
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '{{vault:card.personal.number}}');
    expect(r).toEqual({ ok: true, filledFrom: 'card.personal.number', len: 16 });
    expect(state.filled[0]?.value).toBe('1234567812345678');
    expect(audit.records.find((x) => x.evt === 'fill')).toMatchObject({ key: 'card.personal.number', origin: 'https://pay.pg.com' });
  });

  it('금고에 없는 키는 key_not_found + policy_denied(vault_missing)', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '{{vault:no.such.key}}');
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('key_not_found');
    expect(state.filled).toHaveLength(0);
    expect(audit.records.some((x) => x.evt === 'policy_denied' && x.rule === 'vault_missing')).toBe(true);
  });

  it('플레이스홀더 없는 평문은 그대로 입력된다', async () => {
    const { handlers, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '서울시 강남구');
    expect(r).toEqual({ ok: true, filledFrom: null, len: 7 });
    expect(state.filled[0]?.value).toBe('서울시 강남구');
  });
});

describe('fill + pay grant (FWL-022, 규칙 13)', () => {
  const PIN = '{{vault:shop.payment.pinnumber}}';

  it('grant 없이는 채우지 않는다 — grant_required + grant_denied(missing)', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, PIN);
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('grant_required');
    expect(state.filled).toHaveLength(0); // 브라우저에 아무것도 안 갔다
    expect(audit.records.some((x) => x.evt === 'grant_denied' && x.reason === 'missing')).toBe(true);
  });

  it('유효한 grant면 채우고, 감사에 grant:true가 남는다 (토큰 자체는 안 남는다)', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const token = freshGrant(GRANT_KEY, { session_id: String(sid) });
    const r = await handlers.fill(caller, sid, ref, PIN, token);
    expect(r).toEqual({ ok: true, filledFrom: 'shop.payment.pinnumber', len: 4 });
    expect(state.filled[0]?.value).toBe('1234');
    const fillLog = audit.records.find((x) => x.evt === 'fill');
    expect(fillLog).toMatchObject({ key: 'shop.payment.pinnumber', grant: true });
    expect(JSON.stringify(audit.records)).not.toContain(token);
  });

  it('위조·재사용·타세션 grant는 전부 grant_invalid — 이유는 감사에만 남는다', async () => {
    const cases: ReadonlyArray<[string, (sid: string) => string, string]> = [
      ['다른 키로 서명', (sid) => freshGrant('wrong-key', { session_id: sid }), 'bad_signature'],
      ['다른 세션', () => freshGrant(GRANT_KEY, { session_id: 'sess-other' }), 'session_mismatch'],
      ['만료', (sid) => {
        const iat = Math.floor(Date.now() / 1000) - 600;
        return freshGrant(GRANT_KEY, { session_id: sid, iat, exp: iat + 300 });
      }, 'expired'],
      ['쓰레기', () => 'garbage', 'malformed'],
    ];
    for (const [label, make, reason] of cases) {
      const { handlers, audit, state } = setup();
      const sid = await begin(handlers);
      const r = await handlers.fill(caller, sid, ref, PIN, make(String(sid)));
      if (r.ok) throw new Error(`should fail: ${label}`);
      expect(r.error.code, label).toBe('grant_invalid');
      expect(r.error.message, label).toBe('pay grant rejected'); // 이유를 호출자에게 알리지 않는다
      expect(state.filled, label).toHaveLength(0);
      expect(audit.records.some((x) => x.evt === 'grant_denied' && x.reason === reason), label).toBe(true);
    }
  });

  it('같은 grant를 두 번 쓰면 두 번째는 거부된다 — 1회용', async () => {
    const { handlers, audit } = setup();
    const sid = await begin(handlers);
    const token = freshGrant(GRANT_KEY, { session_id: String(sid) });
    expect((await handlers.fill(caller, sid, ref, PIN, token)).ok).toBe(true);
    const second = await handlers.fill(caller, sid, ref, PIN, token);
    if (second.ok) throw new Error('should fail');
    expect(second.error.code).toBe('grant_invalid');
    expect(audit.records.some((x) => x.evt === 'grant_denied' && x.reason === 'reused')).toBe(true);
  });

  it('grant 플래그가 꺼진 키는 grant 없이 그대로 채워진다 — grant는 예외 경로다', async () => {
    const { handlers, audit } = setup();
    const sid = await begin(handlers);
    expect((await handlers.fill(caller, sid, ref, '{{vault:profile.personal.phone}}')).ok).toBe(true);
    expect(audit.records.find((x) => x.evt === 'fill')).not.toHaveProperty('grant');
  });

  it('행위가 실패하면 grant는 태워지지 않는다 — 실패한 fill 하나가 결제를 막으면 안 된다 (FWL-033)', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const token = freshGrant(GRANT_KEY, { session_id: String(sid) });

    state.failNext('element_not_actionable');
    const first = await handlers.fill(caller, sid, ref, PIN, token);
    if (first.ok) throw new Error('should fail');
    expect(first.error.code).toBe('element_not_actionable');

    // 같은 grant로 다시 — 태워지지 않았으므로 통과해야 한다
    expect(await handlers.fill(caller, sid, ref, PIN, token)).toEqual({
      ok: true,
      filledFrom: 'shop.payment.pinnumber',
      len: 4,
    });
    // 성공한 뒤에야 1회용이 된다
    const third = await handlers.fill(caller, sid, ref, PIN, token);
    if (third.ok) throw new Error('should fail');
    expect(third.error.code).toBe('grant_invalid');
    expect(audit.records.some((x) => x.evt === 'grant_denied' && x.reason === 'reused')).toBe(true);
  });
});

describe('fill — 보안 키패드 (FWL-033)', () => {
  it('keypad 키는 값을 채우지 않고 서버가 숫자 버튼을 누른다 — 값은 어디에도 안 남는다', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '{{vault:shop.keypad.pin}}', undefined, KEYPAD);
    expect(r).toEqual({ ok: true, filledFrom: 'shop.keypad.pin', len: 6 });
    expect(state.filled).toHaveLength(0); // fill intent는 나가지 않는다
    expect(state.intents).toEqual([
      { kind: 'keypad', ref, digitSelector: "img.kpd[aria-label='{digit}']", value: '739105' },
    ]);
    const fillLog = audit.records.find((x) => x.evt === 'fill');
    expect(fillLog).toMatchObject({ key: 'shop.keypad.pin', mode: 'keypad', len: 6 });
    expect(JSON.stringify(fillLog)).not.toContain('739105'); // 감사 로그에 값 없음 (규칙 5)
    expect(JSON.stringify(r)).not.toContain('739105');
  });

  it('같은 키라도 keypad를 안 주면 평범한 text fill이다 — 모드는 호출자가 고른다 (FWL-055)', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    expect((await handlers.fill(caller, sid, ref, '{{vault:shop.keypad.pin}}')).ok).toBe(true);
    expect(state.filled[0]?.value).toBe('739105');
    expect(audit.records.find((x) => x.evt === 'fill')).toMatchObject({ mode: 'text' });
  });

  it('스프라이트 키패드 키는 keypad_sprite 인텐트로 간다 — 감사에 resolver, 값은 없다 (FWL-038)', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '{{vault:shop.keypad.sprite}}', undefined, SPRITE);
    expect(r).toEqual({ ok: true, filledFrom: 'shop.keypad.sprite', len: 4 });
    expect(state.intents).toEqual([
      { kind: 'keypad_sprite', ref, keySelector: 'a.pad-key', cellSelector: 'span[class^=pad-pos-]', resolver: 'sprite-template', value: '4951' },
    ]);
    expect(state.filled).toHaveLength(0);
    const fillLog = audit.records.find((x) => x.evt === 'fill');
    expect(fillLog).toMatchObject({ key: 'shop.keypad.sprite', mode: 'keypad', resolver: 'sprite-template', len: 4 });
    expect(JSON.stringify(fillLog)).not.toContain('4951');
    // 숫자 규칙은 스프라이트 키패드에도 같다
    const bad = await handlers.fill(caller, sid, ref, '{{vault:shop.keypad.sprite}}{{vault:profile.personal.phone}}', undefined, SPRITE);
    if (bad.ok) throw new Error('should fail');
    expect(bad.error.code).toBe('bad_request');
  });

  it('text 키의 fill 감사에는 mode:text가 남는다', async () => {
    const { handlers, audit } = setup();
    const sid = await begin(handlers);
    expect((await handlers.fill(caller, sid, ref, '{{vault:profile.personal.phone}}')).ok).toBe(true);
    expect(audit.records.find((x) => x.evt === 'fill')).toMatchObject({ mode: 'text' });
  });

  it('숫자가 아닌 금고 값은 bad_request — 브라우저에 아무것도 안 간다', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '{{vault:shop.keypad.broken}}', undefined, KEYPAD);
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('bad_request');
    expect(state.intents).toHaveLength(0);
    const denied = audit.records.find((x) => x.evt === 'policy_denied');
    expect(denied).toMatchObject({ key: 'shop.keypad.broken', rule: 'keypad_digits_only' });
    expect(JSON.stringify(audit.records)).not.toContain('ab-cd');
  });

  it('키패드에 여러 키를 이어붙이면 bad_request — 자릿수 대응이 없다', async () => {
    const { handlers, state } = setup();
    const sid = await begin(handlers);
    const r = await handlers.fill(caller, sid, ref, '{{vault:shop.keypad.pin}}{{vault:profile.personal.phone}}', undefined, KEYPAD);
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('bad_request');
    expect(state.intents).toHaveLength(0);
  });
});

describe('vault_handoff (FWL-042)', () => {
  it('잠겨 있으면 vault_locked, 열려 있으면 인계 파일에 패스프레이즈·만료가 담기고 감사에는 없다', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { consumeUnlockHandoff } = await import('@wallet/core');
    const { fakeCipher } = await import('../../helpers/fakes.js');
    const dir = mkdtempSync(join(tmpdir(), 'wallet-handoff-h-'));
    const handoffFile = join(dir, 'unlock-handoff.dpapi');
    try {
      const mk = (vaultOpts: { locked?: boolean; passphrase?: string }) => {
        const audit = createMemoryAudit();
        const handlers = createHandlers({ vault: fakeVault(vaultOpts), sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }), targets: new Map([['browser', fakeTarget().target]]), audit, handoffFile, handoffCipher: fakeCipher });
        return { handlers, audit };
      };
      const locked = mk({ locked: true });
      const r0 = await locked.handlers.vault_handoff(caller);
      if (r0.ok) throw new Error('should fail');
      expect(r0.error.code).toBe('vault_locked');

      const open = mk({ passphrase: 'pp' });
      const r = await open.handlers.vault_handoff(caller);
      expect(r).toMatchObject({ ok: true, remainingMs: 60_000 });
      const h = consumeUnlockHandoff(handoffFile, Date.now, fakeCipher);
      expect(h?.passphrase).toBe('pp');
      expect((h?.unlockedUntil ?? 0) - Date.now()).toBeGreaterThan(50_000);
      const log = open.audit.records.find((x) => x.evt === 'vault_handoff');
      expect(log).toMatchObject({ ok: true, remainingMs: 60_000 });
      expect(JSON.stringify(open.audit.records)).not.toContain('pp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fill — Test Mode (FWL-035)', () => {
  const PIN = '{{vault:shop.payment.pinnumber}}';

  it('켜져 있으면 grant 검증·소모까지 하고 입력만 건너뛴다 — 응답은 실제 fill과 같고 감사에만 dry:true', async () => {
    const { handlers, audit, state } = setup({}, undefined, createMemoryTestMode(true));
    const sid = await begin(handlers);
    const token = freshGrant(GRANT_KEY, { session_id: String(sid) });
    const r = await handlers.fill(caller, sid, ref, PIN, token);
    expect(r).toEqual({ ok: true, filledFrom: 'shop.payment.pinnumber', len: 4 }); // dry 표식 없음
    expect(state.filled).toHaveLength(0);
    expect(state.intents.filter((i) => i.kind === 'fill' || i.kind === 'keypad')).toHaveLength(0);
    expect(audit.records.find((x) => x.evt === 'fill')).toMatchObject({ key: 'shop.payment.pinnumber', grant: true, dry: true });
    // grant는 소모됐다 — 같은 토큰은 두 번째에 거부
    const second = await handlers.fill(caller, sid, ref, PIN, token);
    if (second.ok) throw new Error('should fail');
    expect(second.error.code).toBe('grant_invalid');
  });

  it('키패드 grant 키도 버튼을 하나도 누르지 않는다', async () => {
    const { handlers, audit, state } = setup({}, undefined, createMemoryTestMode(true));
    const sid = await begin(handlers);
    const token = freshGrant(GRANT_KEY, { session_id: String(sid) });
    const r = await handlers.fill(caller, sid, ref, '{{vault:shop.keypad.grantpin}}', token, KEYPAD);
    expect(r).toEqual({ ok: true, filledFrom: 'shop.keypad.grantpin', len: 4 });
    expect(state.intents.some((i) => i.kind === 'keypad')).toBe(false);
    expect(audit.records.find((x) => x.evt === 'fill')).toMatchObject({ mode: 'keypad', dry: true });
  });

  it('켜져 있어도 grant 없으면 여전히 grant_required, 위조면 grant_invalid', async () => {
    const { handlers } = setup({}, undefined, createMemoryTestMode(true));
    const sid = await begin(handlers);
    const none = await handlers.fill(caller, sid, ref, PIN);
    if (none.ok) throw new Error('should fail');
    expect(none.error.code).toBe('grant_required');
    const forged = await handlers.fill(caller, sid, ref, PIN, freshGrant('wrong-key', { session_id: String(sid) }));
    if (forged.ok) throw new Error('should fail');
    expect(forged.error.code).toBe('grant_invalid');
  });

  it('grant가 필요 없는 키는 Test Mode와 무관하게 채워진다 — 스위치는 결제 키만 덮는다', async () => {
    const { handlers, audit, state } = setup({}, undefined, createMemoryTestMode(true));
    const sid = await begin(handlers);
    expect((await handlers.fill(caller, sid, ref, '{{vault:profile.personal.phone}}')).ok).toBe(true);
    expect(state.filled[0]?.value).toBe('01012345678');
    expect(audit.records.find((x) => x.evt === 'fill')).not.toHaveProperty('dry');
  });

  it('꺼져 있으면 평소대로 입력한다', async () => {
    const { handlers, state } = setup({}, undefined, createMemoryTestMode(false));
    const sid = await begin(handlers);
    const token = freshGrant(GRANT_KEY, { session_id: String(sid) });
    expect((await handlers.fill(caller, sid, ref, PIN, token)).ok).toBe(true);
    expect(state.filled[0]?.value).toBe('1234');
  });
});

describe('세션 이어받기 (FWL-008)', () => {
  it('session_list — 자기 세션만, 타겟 origin·브라우저·남은 TTL이 보인다', async () => {
    const { handlers } = setup();
    const sid = await begin(handlers);
    await handlers.navigate(caller, sid, 'https://shop.com/cart');

    const mine = await handlers.session_list(caller);
    if (!mine.ok) throw new Error('should succeed');
    expect(mine.sessions).toHaveLength(1);
    expect(mine.sessions[0]).toMatchObject({ sessionId: sid, origin: 'https://shop.com', kind: 'browser', browser: 'chromium', headless: true });
    expect(mine.sessions[0]!.ttlRemainingMs).toBeGreaterThan(0);

    const others = await handlers.session_list({ client: 'other-device' });
    if (!others.ok) throw new Error('should succeed');
    expect(others.sessions).toHaveLength(0);
  });

  it('session_status — 현재 URL·페이지 수·스냅샷 세대까지 준다', async () => {
    const { handlers } = setup();
    const sid = await begin(handlers);
    const r = await handlers.session_status(caller, sid);
    if (!r.ok) throw new Error('should succeed');
    expect(r).toMatchObject({ sessionId: sid, url: 'https://shop.com/checkout', pages: [{ index: 0, url: 'https://shop.com/checkout', current: true }], snapshotGen: 1 });
  });

  it('session_status — 다른 클라이언트 세션은 session_not_found', async () => {
    const { handlers } = setup();
    const sid = await begin(handlers);
    const r = await handlers.session_status({ client: 'other-device' }, sid);
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('session_not_found');
  });
});

describe('세션 TTL', () => {
  it('sweep_expired — 만료 세션의 브라우저를 닫고 session_end(ttl)를 남긴다; 접근할 때마다 TTL이 연장된다', async () => {
    let t = 1_000_000;
    const { handlers, audit, state } = setup({}, () => t);
    const sid = await begin(handlers);
    t += 50_000;
    expect((await handlers.page_tree(caller, sid)).ok).toBe(true); // 접근 → 연장
    t += 50_000; // 최초 발급 기준으론 만료, 연장 기준으론 아직
    await handlers.sweep_expired();
    expect(state.closed).toHaveLength(0);
    t += 60_000;
    await handlers.sweep_expired();
    expect(state.closed).toEqual([sid]);
    expect(audit.records.find((x) => x.evt === 'session_end')).toMatchObject({ sid, origin: 'https://shop.com', reason: 'ttl' });
    expect((await handlers.session_begin(caller, { origin: 'https://shop.com' })).ok).toBe(true); // 리스도 풀렸다
  });

  it('sweep_expired — 금고 TTL 만료(열림→잠김)를 vault_lock 감사로 남긴다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wallet-handlers-'));
    const file = join(dir, 'vault.dpapi');
    writeVaultFile(file, 'pp', new Map([['profile.personal.phone', { type: 'phone', value: '01012345678', grant: false, label: 'Mobile' }]]), fakeCipher);
    let t = 0;
    const vault = createVault(file, { cipher: fakeCipher, ttlMs: 1_000, now: () => t });
    const audit = createMemoryAudit();
    const handlers = createHandlers({ vault, sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }), targets: new Map([['browser', fakeTarget().target]]), audit });
    await handlers.sweep_expired();
    expect(audit.records.filter((x) => x.evt === 'vault_lock')).toHaveLength(0); // 처음부터 잠김 — 전이 아님
    await vault.unlock('pp');
    await handlers.sweep_expired();
    t += 1_000; // TTL 만료
    await handlers.sweep_expired();
    await handlers.sweep_expired();
    expect(audit.records.filter((x) => x.evt === 'vault_lock')).toEqual([expect.objectContaining({ reason: 'ttl' })]); // 전이 1회만
    rmSync(dir, { recursive: true, force: true });
  });

  it('wait의 timeoutMs는 1ms~30s로 묶인다 — 0은 Playwright에서 무제한이다', async () => {
    const { handlers, state } = setup();
    const sid = await begin(handlers);
    await handlers.wait(caller, sid, ref, 0);
    await handlers.wait(caller, sid, ref, 999_999);
    const waits = state.intents.filter((i) => i.kind === 'wait').map((i) => (i as { timeoutMs: number }).timeoutMs);
    expect(waits).toEqual([1, 30_000]);
  });
});

describe('로그인 쿠키 재저장 (FWL-026)', () => {
  it('session_end은 loggedIn=true일 때만 persist — false·생략은 저장하지 않는다', async () => {
    const { handlers, audit, state } = setup();
    const a = await begin(handlers);
    await handlers.session_end(caller, a, true);
    const b = await begin(handlers);
    await handlers.session_end(caller, b, false);
    const c = await begin(handlers);
    await handlers.session_end(caller, c);
    expect(state.closeCalls).toEqual([
      { id: a, persist: true },
      { id: b, persist: false },
      { id: c, persist: false },
    ]);
    // 감사에는 불리언 또는 null만 남는다
    expect(audit.records.filter((x) => x.evt === 'session_end').map((x) => x.loggedIn)).toEqual([true, false, null]);
  });

  it('sweep_expired로 닫히는 세션은 persist하지 않는다 — 단언 없는 종료다', async () => {
    let t = 1_000_000;
    const { handlers, state } = setup({}, () => t);
    const sid = await begin(handlers);
    t += 120_000;
    await handlers.sweep_expired();
    expect(state.closeCalls).toEqual([{ id: sid, persist: false }]);
  });
});

describe('세션 경계', () => {
  it('다른 클라이언트의 세션 id로는 접근할 수 없다', async () => {
    const { handlers } = setup();
    const sid = await begin(handlers);
    const r = await handlers.page_tree({ client: 'other-device' }, sid);
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('session_not_found');
  });

});

describe('세션 = origin 하나 (FWL-017)', () => {
  it('같은 클라이언트의 두 번째 begin은 이전 세션을 닫고 이어받는다 — session_end reason replaced (FWL-036)', async () => {
    const { target, closed } = fakeTarget();
    const audit = createMemoryAudit();
    const handlers = createHandlers({
      vault: fakeVault(), sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }), targets: new Map([['browser', target]]), audit,
    });
    const first = await handlers.session_begin(caller, { origin: 'https://shop.com' });
    if (!first.ok) throw new Error('first begin failed');
    const second = await handlers.session_begin(caller, { origin: 'https://shop.com' });
    expect(second.ok).toBe(true);
    expect(closed).toContain(first.sessionId);
    const end = audit.records.find((r) => r.evt === 'session_end' && r.sid === first.sessionId);
    expect(end?.['reason']).toBe('replaced');
    expect((await handlers.session_status(caller, first.sessionId as SessionId)).ok).toBe(false);
    // 다른 클라이언트는 여전히 막힌다
    const other = await handlers.session_begin({ ...caller, client: 'key:other' }, { origin: 'https://shop.com' });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe('lease_conflict');
  });

  it('begin이 리스를 잡는다 — 다른 클라이언트의 두 번째 begin은 lease_conflict, end 후 재획득', async () => {
    const { handlers, audit } = setup();
    const other = { client: 'key:other' };
    const a = await begin(handlers);
    const r = await handlers.session_begin(other, { origin: 'https://shop.com' });
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('lease_conflict');
    expect(audit.records.find((x) => x.evt === 'session_begin')).toMatchObject({ origin: 'https://shop.com', kind: 'browser', profile: { kind: 'browser', browser: 'chromium', headless: true } });
    await handlers.session_end(caller, a);
    expect((await handlers.session_begin(other, { origin: 'https://shop.com' })).ok).toBe(true);
  });

  it('origin이 없거나 정확한 origin이 아니면 bad_request', async () => {
    const { handlers } = setup();
    for (const origin of [undefined, '', 'shop.com', 'https://shop.com/cart', 'ftp://shop.com']) {
      const r = await handlers.session_begin(caller, { origin: origin as string });
      if (r.ok) throw new Error(`should fail: ${origin}`);
      expect(r.error.code).toBe('bad_request');
    }
  });

  it('navigate는 타겟 origin 안에서만 — 다른 origin은 origin_not_permitted + policy_denied 감사', async () => {
    const { handlers, audit } = setup();
    const sid = await begin(handlers);
    expect((await handlers.navigate(caller, sid, 'https://shop.com/cart')).ok).toBe(true);
    const r = await handlers.navigate(caller, sid, 'https://other.com/');
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('origin_not_permitted');
    expect(audit.records.some((x) => x.evt === 'policy_denied' && x.rule === 'session_origin')).toBe(true);
  });

  it('브라우저 엔진·모드는 호출자가 session_begin에서 고른다 (FWL-055)', async () => {
    const { target, opened } = fakeTarget();
    const handlers = createHandlers({
      vault: fakeVault(),
      sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }),
      targets: new Map([['browser', target]]),
      audit: createMemoryAudit(),
    });
    const r = await handlers.session_begin(caller, { origin: 'https://bot.example', browser: 'chrome', headless: false });
    expect(r.ok).toBe(true);
    expect(opened[0]).toEqual({ origin: 'https://bot.example', kind: 'browser', browser: 'chrome', headless: false });
  });

  it('요청한 kind의 타겟으로 라우팅된다 — 브라우저 타겟은 건드리지 않는다 (FWL-037)', async () => {
    const browser = fakeTarget();
    const stub = fakeTarget({ url: 'https://stub.example/' });
    const handlers = createHandlers({
      vault: fakeVault(),
      sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }),
      targets: new Map([['browser', browser.target], ['stub', stub.target]]),
      audit: createMemoryAudit(),
    });
    const r = await handlers.session_begin(caller, { origin: 'https://stub.example', kind: 'stub' });
    if (!r.ok) throw new Error(r.error.code);
    expect(stub.opened[0]).toEqual({ origin: 'https://stub.example', kind: 'stub' });
    expect(browser.opened).toHaveLength(0);
    const sid = r.sessionId as SessionId;
    expect((await handlers.page_tree(caller, sid)).ok).toBe(true);
    expect((await handlers.click(caller, sid, '1:e1' as Ref)).ok).toBe(true);
    expect(browser.intents).toHaveLength(0);
    expect(stub.intents.length).toBeGreaterThan(0);
    expect(await handlers.session_status(caller, sid)).toMatchObject({ kind: 'stub', origin: 'https://stub.example' });
    expect((await handlers.session_status(caller, sid)) as object).not.toHaveProperty('browser');
  });

  it('등록되지 않은 kind로 session_begin하면 bad_request (FWL-037)', async () => {
    const { handlers } = setup();
    const r = await handlers.session_begin(caller, { origin: 'https://stub.example', kind: 'stub' });
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('bad_request');
  });

  it('browser 타겟이 없으면 기동을 거부한다', () => {
    expect(() => createHandlers({
      vault: fakeVault(),
      sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }),
      targets: new Map(),
      audit: createMemoryAudit(),
    })).toThrow(/kind "browser"/);
  });
});

describe('저장 로그인 힌트 (FWL-046) — 서버는 주입 여부만 알리고 로그인 판단은 에이전트가 한다', () => {
  function setup(over: FakeTargetOptions = {}) {
    const state = fakeTarget({ url: 'https://shop.com/', ...over });
    const audit = createMemoryAudit();
    const handlers = createHandlers({
      vault: fakeVault(),
      sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }),
      targets: new Map([['browser', state.target]]),
      audit,
    });
    return { handlers, audit, state };
  }

  async function sessionCount(handlers: ReturnType<typeof createHandlers>): Promise<number> {
    const list = await handlers.session_list(caller);
    return list.ok ? list.sessions.length : -1;
  }

  it('저장 컨텍스트를 주입했으면 storedLogin:true — begin에서 페이지로 이동하지 않는다', async () => {
    const { handlers, state } = setup({ storedLogin: true });
    const r = await handlers.session_begin(caller, { origin: 'https://shop.com' });
    if (!r.ok) throw new Error('should open');
    expect(r.storedLogin).toBe(true);
    expect(state.visited).toEqual([]);
  });

  it('저장 컨텍스트가 없으면 storedLogin:false — 세션은 열린다', async () => {
    const { handlers, state } = setup();
    const r = await handlers.session_begin(caller, { origin: 'https://shop.com' });
    if (!r.ok) throw new Error('should open');
    expect(r.storedLogin).toBe(false);
    expect(state.closed).toEqual([]);
    expect(await sessionCount(handlers)).toBe(1);
  });

  it('저장 로그인이 있는 origin인데 금고가 잠겨 있으면 vault_locked — 세션이 남지 않는다', async () => {
    // main.ts의 storageStateFor가 던지는 예외가 open() 밖으로 그대로 나온다
    const { handlers } = setup({ openError: new VaultLockedError() });
    const r = await handlers.session_begin(caller, { origin: 'https://shop.com' });
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('vault_locked');
    expect(await sessionCount(handlers)).toBe(0);
  });
});

describe('origin별 기동 조합 기억 (FWL-065)', () => {
  const ORIGIN = 'https://bot.example';
  /** 기억 저장소를 물린 핸들러 한 벌. openError를 주면 기동 실패 경로를 탄다 */
  function withMemory(remembered?: { browser: 'chromium' | 'chrome'; headless: boolean }, over: FakeTargetOptions = {}) {
    const state = fakeTarget(over);
    const audit = createMemoryAudit();
    const originProfiles = createMemoryOriginProfiles(
      remembered ? { [ORIGIN]: { ...remembered, at: '2026-09-13T00:00:00.000Z' } } : {},
    );
    const handlers = createHandlers({
      vault: fakeVault(),
      sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }),
      targets: new Map([['browser', state.target]]),
      audit,
      originProfiles,
    });
    return { handlers, audit, state, originProfiles };
  }

  it('로그인까지 간 세션의 조합을 기억한다 — 다음 세션은 생략해도 그 조합으로 열린다', async () => {
    const { handlers, originProfiles, state } = withMemory();
    const r = await handlers.session_begin(caller, { origin: ORIGIN, browser: 'chrome', headless: false });
    if (!r.ok) throw new Error(r.error.code);
    expect(originProfiles.get(ORIGIN)).toBeUndefined(); // 아직 로그인을 단언하지 않았다
    await handlers.session_end(caller, r.sessionId, true);
    expect(originProfiles.get(ORIGIN)).toMatchObject({ browser: 'chrome', headless: false });

    const again = await handlers.session_begin(caller, { origin: ORIGIN });
    expect(again.ok).toBe(true);
    expect(state.opened[1]).toEqual({ origin: ORIGIN, kind: 'browser', browser: 'chrome', headless: false });
  });

  it('loggedIn 없이 끝난 세션은 아무것도 가르치지 않는다 — 차단은 정상 종료로 도착한다', async () => {
    const { handlers, originProfiles } = withMemory();
    const r = await handlers.session_begin(caller, { origin: ORIGIN, browser: 'chromium', headless: true });
    if (!r.ok) throw new Error(r.error.code);
    await handlers.session_end(caller, r.sessionId);
    expect(originProfiles.get(ORIGIN)).toBeUndefined();
  });

  it('호출자가 고르지 않은 기본값은 배우지 않는다 — keepalive가 틀린 조합을 굳히는 걸 막는다', async () => {
    const { handlers, originProfiles } = withMemory();
    const r = await handlers.session_begin(caller, { origin: ORIGIN }); // 조합 생략 → chromium/headless 기본값
    if (!r.ok) throw new Error(r.error.code);
    await handlers.session_end(caller, r.sessionId, true);
    expect(originProfiles.get(ORIGIN)).toBeUndefined();
  });

  it('기억과 다른 조합을 지목하면 열지 않고 거절한다 — 통했던 조합을 알려 준다', async () => {
    const { handlers, audit, state } = withMemory({ browser: 'chrome', headless: false });
    const r = await handlers.session_begin(caller, { origin: ORIGIN, browser: 'chromium', headless: true });
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('profile_mismatch');
    expect(r.error.retriable).toBe(false);
    expect(r.error.message).toContain('chrome/headful');
    expect(state.opened).toHaveLength(0); // 브라우저를 띄우지도 않았다
    expect(audit.records.find((x) => x.evt === 'action_failed')).toMatchObject({
      sid: null, // 세션을 열기 전에 막았다
      kind: 'session_begin',
      code: 'profile_mismatch',
      origin: ORIGIN,
      remembered: 'chrome/headful',
      profile: { kind: 'browser', browser: 'chromium', headless: true },
    });
  });

  it('기억과 같은 조합을 지목하는 건 통과한다', async () => {
    const { handlers, state } = withMemory({ browser: 'chrome', headless: false });
    const r = await handlers.session_begin(caller, { origin: ORIGIN, browser: 'chrome', headless: false });
    expect(r.ok).toBe(true);
    expect(state.opened[0]).toEqual({ origin: ORIGIN, kind: 'browser', browser: 'chrome', headless: false });
  });

  it('기억한 조합이 아예 못 뜨면 기억을 버린다 — 크롬이 사라져도 영구히 막히지 않는다', async () => {
    const { handlers, originProfiles } = withMemory(
      { browser: 'chrome', headless: false },
      { openError: new TargetError('browser_unavailable', 'not_installed') },
    );
    const r = await handlers.session_begin(caller, { origin: ORIGIN });
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('browser_unavailable');
    expect(originProfiles.get(ORIGIN)).toBeUndefined();
  });

  it('기억 저장소가 없으면 검사도 기억도 없다 — 호출자 말을 그대로 따른다 (기존 동작)', async () => {
    const { handlers, state } = setup();
    const r = await handlers.session_begin(caller, { origin: 'https://shop.com', browser: 'chrome', headless: false });
    if (!r.ok) throw new Error(r.error.code);
    await handlers.session_end(caller, r.sessionId, true);
    const second = await handlers.session_begin(caller, { origin: 'https://shop.com', browser: 'chromium', headless: true });
    expect(second.ok).toBe(true);
    expect(state.opened[1]).toMatchObject({ browser: 'chromium', headless: true });
  });
});

describe('감사 로그로 세션 재구성 (FWL-030)', () => {
  it('실패한 click은 action_failed로 남는다 — 코드와 ref만', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    state.failNext('element_not_actionable');
    const r = await handlers.click(caller, sid, ref);
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('element_not_actionable');
    expect(audit.records.find((x) => x.evt === 'action_failed')).toMatchObject({
      sid,
      kind: 'click',
      ref: '1:e1',
      code: 'element_not_actionable',
    });
    expect(audit.records.some((x) => x.evt === 'click')).toBe(false); // 성공 이벤트는 없다
  });

  it('실패한 navigate도 남는다 — 어디서 멈췄는지가 보여야 한다', async () => {
    const { handlers, audit, state } = setup();
    const sid = await begin(handlers);
    state.failNext('navigation_failed');
    const r = await handlers.navigate(caller, sid, 'https://shop.com/cart');
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('navigation_failed');
    expect(audit.records.find((x) => x.evt === 'action_failed')).toMatchObject({
      kind: 'navigate',
      code: 'navigation_failed',
      origin: 'https://shop.com',
    });
  });

  it('세션 시작 실패도 남는다 — 프로필과 원인 분류까지, 응답에는 원인이 안 나간다 (FWL-063)', async () => {
    const { handlers, audit } = setup({ openError: new TargetError('browser_unavailable', 'not_installed') });
    const r = await handlers.session_begin(caller, { origin: 'https://shop.com', browser: 'chrome', headless: false });
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('browser_unavailable');
    expect(r.error.message).toBe('browser_unavailable'); // 호스트 사정은 호출자에게 알리지 않는다
    const log = audit.records.find((x) => x.evt === 'action_failed' && (x as { kind?: string }).kind === 'session_begin');
    expect(log).toMatchObject({
      code: 'browser_unavailable',
      reason: 'not_installed', // 운영자는 이걸 보고 Chrome을 고칠지 로그온을 할지 안다
      origin: 'https://shop.com',
      profile: { kind: 'browser', browser: 'chrome', headless: false },
    });
  });

  it('page_tree는 세대와 페이지 수를 남긴다 — 트리 본문은 남기지 않는다', async () => {
    const { handlers, audit } = setup({ tree: '- textbox "비밀번호" [ref=1:e1]' });
    const sid = await begin(handlers);
    expect((await handlers.page_tree(caller, sid)).ok).toBe(true);
    const log = audit.records.find((x) => x.evt === 'page_tree');
    expect(log).toMatchObject({ sid, generation: 1, pages: 1 });
    expect(JSON.stringify(log)).not.toContain('비밀번호'); // 규칙 5
  });

  it('성공한 click 감사에는 누른 요소의 role이 실린다', async () => {
    const { handlers, audit } = setup();
    const sid = await begin(handlers);
    expect((await handlers.click(caller, sid, ref)).ok).toBe(true);
    expect(audit.records.find((x) => x.evt === 'click')).toMatchObject({ ref: '1:e1', role: 'button' });
  });

  it('wait도 감사에 남는다 — ref와 실제로 적용된 timeoutMs', async () => {
    const { handlers, audit } = setup();
    const sid = await begin(handlers);
    await handlers.wait(caller, sid, ref, 0);
    expect(audit.records.find((x) => x.evt === 'wait')).toMatchObject({ ref: '1:e1', timeoutMs: 1 });
  });
});

describe('fill — Test Mode 보류 키 (FWL-056)', () => {
  it('Test Mode가 켜져 있을 때만 key_held로 막는다 — 아무것도 입력하지 않고 감사에 policy_denied', async () => {
    const on = setup({}, undefined, createMemoryTestMode(true, ['profile.personal.phone']));
    const sid = await begin(on.handlers);
    const r = await on.handlers.fill(caller, sid, ref, '{{vault:profile.personal.phone}}');
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('key_held');
    expect(on.state.filled).toHaveLength(0);
    expect(on.audit.records.find((x) => x.evt === 'policy_denied')).toMatchObject({ key: 'profile.personal.phone', rule: 'key_held' });

    // 꺼져 있으면 같은 보류 목록이어도 평소대로 채운다
    const off = setup({}, undefined, createMemoryTestMode(false, ['profile.personal.phone']));
    const sid2 = await begin(off.handlers);
    expect((await off.handlers.fill(caller, sid2, ref, '{{vault:profile.personal.phone}}')).ok).toBe(true);
    expect(off.state.filled[0]?.value).toBe('01012345678');
  });
});
