/** 정적 키 인증 (FWL-074) — FronyAuth 없는 서버의 bearer 검증과 콘솔 로그인 락아웃 */

import { describe, expect, it } from 'vitest';
import { createStaticAdminVerifier, createStaticVerifier, parseStaticKeys } from '@wallet/api';

const KEYS = parseStaticKeys('agent:tok-agent, admin-box:tok-admin');

describe('parseStaticKeys', () => {
  it('name:token 목록을 읽는다 — 공백은 무시, 토큰 안의 콜론은 토큰이다', () => {
    expect(KEYS).toEqual([{ name: 'agent', token: 'tok-agent' }, { name: 'admin-box', token: 'tok-admin' }]);
    expect(parseStaticKeys('a:x:y')).toEqual([{ name: 'a', token: 'x:y' }]);
  });

  it('틀린 항목은 기동을 거부하게 던진다 — 콜론 없음, 빈 토큰, 나쁜 이름, 같은 이름 두 번, 빈 목록', () => {
    for (const bad of ['agent', 'agent:', ':tok', 'a b:tok', 'a:1,a:2', ' , ']) {
      expect(() => parseStaticKeys(bad), bad).toThrow();
    }
  });
});

describe('createStaticVerifier', () => {
  const verify = createStaticVerifier(KEYS);

  it('맞는 토큰은 introspection과 같은 표기 key:<name>으로 답한다', async () => {
    expect(await verify('tok-agent')).toEqual({ ok: true, client: 'key:agent' });
    expect(await verify('tok-admin')).toEqual({ ok: true, client: 'key:admin-box' });
  });

  it('모르는 토큰·길이가 다른 토큰·이름을 낸 것은 401이고 503은 없다 — 확인할 원격이 없다', async () => {
    for (const bad of ['tok-agen', 'tok-agent-x', 'agent', '']) {
      expect(await verify(bad), bad).toEqual({ ok: false, status: 401 });
    }
  });
});

describe('createStaticAdminVerifier', () => {
  const clock = { t: 1_000_000 };
  const make = () => createStaticAdminVerifier(KEYS, ['key:admin-box'], { now: () => clock.t });

  it('admin 목록에 든 키의 이름+토큰만 통과한다 — 에이전트 키는 맞아도 401', async () => {
    const v = make();
    expect(await v('admin-box', 'tok-admin', '10.0.0.1')).toEqual({ ok: true, username: 'admin-box' });
    expect(await v('agent', 'tok-agent', '10.0.0.1')).toMatchObject({ ok: false, status: 401 });
    expect(await v('admin-box', 'wrong', '10.0.0.1')).toMatchObject({ ok: false, status: 401 });
    expect(await v('nobody', 'tok-admin', '10.0.0.1')).toMatchObject({ ok: false, status: 401 });
  });

  it('주소별로 5회 실패하면 15분 동안 429 — 맞는 비밀번호도 막히고, 창이 지나면 다시 센다', async () => {
    const v = make();
    for (let i = 1; i <= 5; i++) {
      expect(await v('admin-box', 'wrong', '10.0.0.2')).toEqual({ ok: false, status: 401, attemptsLeft: 5 - i });
    }
    const locked = await v('admin-box', 'tok-admin', '10.0.0.2');
    expect(locked).toMatchObject({ ok: false, status: 429 });
    if (locked.ok || locked.status !== 429) throw new Error('locked');
    expect(locked.retryAfterSeconds).toBe(900);
    expect(await v('admin-box', 'tok-admin', '10.0.0.3')).toEqual({ ok: true, username: 'admin-box' }); // 다른 주소는 무관하다
    clock.t += 15 * 60_000;
    expect(await v('admin-box', 'tok-admin', '10.0.0.2')).toEqual({ ok: true, username: 'admin-box' });
  });

  it('성공하면 그 주소의 실패 횟수가 지워진다', async () => {
    const v = make();
    await v('admin-box', 'wrong', '10.0.0.4');
    await v('admin-box', 'wrong', '10.0.0.4');
    expect(await v('admin-box', 'tok-admin', '10.0.0.4')).toMatchObject({ ok: true });
    expect(await v('admin-box', 'wrong', '10.0.0.4')).toMatchObject({ attemptsLeft: 4 });
  });
});
