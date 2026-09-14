/**
 * FWL-013 실브라우저 검증 — 시딩된 storageState가 세션에 실리고(로그인 상태로
 * 시작), 종료 시 사이트가 바꾼 쿠키가 재저장 콜백으로 돌아온다.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionId } from '@wallet/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StorageState } from '@wallet/app';
import { createBrowserPool, createPlaywrightTarget } from '@wallet/app';

let server: Server;
let origin: string;
const pool = createBrowserPool();
let persisted: object | null = null;

/** 요청 쿠키를 본문에 되비추고, 응답으로 fresh 쿠키를 굽는 모사 사이트 */
beforeAll(async () => {
  server = await new Promise<Server>((resolvePromise) => {
    const s = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'fresh=rotated-by-site; Path=/',
      });
      res.end(`<h1>메인</h1><p>보낸 쿠키: ${req.headers.cookie ?? '(없음)'}</p>`);
    });
    s.listen(0, '127.0.0.1', () => resolvePromise(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await pool.shutdown();
  server?.close();
});

const seeded: StorageState = {
  cookies: [
    {
      name: 'sid', value: 'seeded-session-123', domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
    },
  ],
  origins: [],
};

describe('storageState 배선', () => {
  it('시딩 쿠키가 첫 요청부터 실리고, 종료 시 갱신 쿠키가 재저장된다', async () => {
    const target = createPlaywrightTarget(pool, {
      storageStateFor: () => seeded,
      persistStorageState: (state) => {
        persisted = state;
      },
    });
    const sid = 's_storage' as SessionId;
    expect((await target.open(sid, { origin, kind: 'browser', browser: 'chromium', headless: true })).storedLogin).toBe(true);
    await target.act(sid, { kind: 'navigate', url: `${origin}/` });

    const snap = await target.snapshot(sid);
    expect(snap.tree).toContain('sid=seeded-session-123'); // 로그인 상태로 시작

    await target.close(sid, { persist: true }); // 에이전트가 loggedIn을 단언한 종료 (FWL-026)
    const cookies = (persisted as { cookies?: Array<{ name: string; value: string }> })?.cookies ?? [];
    expect(cookies.find((c) => c.name === 'sid')?.value).toBe('seeded-session-123');
    expect(cookies.find((c) => c.name === 'fresh')?.value).toBe('rotated-by-site'); // 사이트가 준 쿠키 보존
  }, 60_000);

  it('storageStateFor가 undefined면(금고 잠김) 주입 없이 열린다', async () => {
    const target = createPlaywrightTarget(pool, { storageStateFor: () => undefined });
    const sid = 's_nostate' as SessionId;
    await target.open(sid, { origin, kind: 'browser', browser: 'chromium', headless: true });
    await target.act(sid, { kind: 'navigate', url: `${origin}/` });
    const snap = await target.snapshot(sid);
    expect(snap.tree).toContain('(없음)');
    await target.close(sid);
  }, 60_000);

  it('제공자 쿠키만 실린 세션은 storedLogin=false — 주입이 있어도 이 사이트의 로그인은 아니다 (FWL-070)', async () => {
    const target = createPlaywrightTarget(pool, { storageStateFor: () => seeded, hasStoredLogin: () => false });
    const sid = 's_idponly' as SessionId;
    expect((await target.open(sid, { origin, kind: 'browser', browser: 'chromium', headless: true })).storedLogin).toBe(false);
    await target.close(sid);
  }, 60_000);

  it('persist 단언이 없으면 재저장 콜백을 부르지 않는다 (FWL-026)', async () => {
    let calls = 0;
    const target = createPlaywrightTarget(pool, {
      storageStateFor: () => seeded,
      persistStorageState: () => {
        calls += 1;
      },
    });
    const sid = 's_nopersist' as SessionId;
    await target.open(sid, { origin, kind: 'browser', browser: 'chromium', headless: true });
    await target.act(sid, { kind: 'navigate', url: `${origin}/` });
    await target.close(sid);
    expect(calls).toBe(0);
  }, 60_000);
});
