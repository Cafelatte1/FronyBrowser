/**
 * 등록 페이지 백엔드 — /login (FronyAuth admin/verify 위임) · /vault/* (wsess 또는 admin 기기 키) ·
 * 정적 서빙. admin 검사·값 미반환·DPAPI 왕복(fake cipher)을 확인한다.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeUnlockHandoff, createMemoryAudit, createMemoryTestMode, createSessionStore, createVault } from '@wallet/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeCipher, fakeTarget } from '../helpers/fakes.js';
import type { AdminVerifier } from '@wallet/api';
import type { Verifier } from '@wallet/api';
import { createHandlers } from '@wallet/api';
import { createVaultAdmin } from '@wallet/api';
import { createHttpServer } from '@wallet/api';

const { target } = fakeTarget({ url: 'https://shop.com', tree: '' });

const verify: Verifier = async (bearer) => {
  if (bearer === 'frony_admin') return { ok: true, client: 'key:admin-box' };
  if (bearer === 'frony_agent') return { ok: true, client: 'key:agent-box' };
  return { ok: false, status: 401 };
};

/** FronyAuth /admin/verify 모사 — admin/correct만 통과, locked-user는 429 */
const verifyAdmin: AdminVerifier = async (username, password) => {
  if (username === 'locked-user') return { ok: false, status: 429, retryAfterSeconds: 120 };
  if (username === 'admin' && password === 'correct') return { ok: true, username: 'admin' };
  return { ok: false, status: 401, attemptsLeft: 3 };
};

const dir = mkdtempSync(join(tmpdir(), 'wallet-gui-'));
const staticDir = join(dir, 'dist');
const vaultFile = join(dir, 'vault.dpapi');
const sessionsDir = join(dir, 'sessions');
const vault = createVault(vaultFile, { cipher: fakeCipher });
const audit = createMemoryAudit();
const testMode = createMemoryTestMode(false);
const handoffFile = join(dir, 'unlock-handoff.dpapi');
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>FronyBrowser 금고</title>');

  const handlers = createHandlers({
    vault,
    sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }),
    targets: new Map([['browser', target]]),
    audit,
    handoffFile,
    handoffCipher: fakeCipher,
  });
  server = createHttpServer({
    handlers,
    vault,
    audit,
    verify,
    adminClients: ['key:admin-box'],
    vaultAdmin: createVaultAdmin({ vaultFile, sessionsDir, vault, audit, cipher: fakeCipher }),
    vaultFile,
    verifyAdmin,
    staticDir,
    testMode,
    serviceKey: 'frony_service_self',
    authIssuer: 'https://auth.example.ts.net',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: object, bearer?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; [k: string]: unknown } };
}

async function login(): Promise<string> {
  const r = await post('/login', { username: 'admin', password: 'correct' });
  if (!r.body.ok) throw new Error('login failed');
  return r.body['token'] as string;
}

describe('Funnel 커넥터 (FWL-040)', () => {
  it('publicUrl 없음: 401에 헤더 없고 메타데이터 경로는 404, OPTIONS는 자격 없이 204 + CORS', async () => {
    const r = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect((await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
    const o = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(o.status).toBe(204);
    expect(o.headers.get('access-control-allow-origin')).toBe('*');
    expect(o.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('publicUrl 있음: 401에 resource_metadata(.well-known은 호스트 바로 뒤 + 접두), 메타데이터는 resource/issuer', async () => {
    const pub = createHttpServer({
      handlers: createHandlers({ vault, sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }), targets: new Map([['browser', target]]), audit }),
      vault, audit, verify, adminClients: [],
      vaultAdmin: createVaultAdmin({ vaultFile, sessionsDir, vault, audit, cipher: fakeCipher }),
      vaultFile, verifyAdmin, staticDir,
      publicUrl: 'https://gpu.example.ts.net/wallet', authIssuer: 'https://auth.example.ts.net',
    });
    await new Promise<void>((r) => pub.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${(pub.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${u}/mcp`, { method: 'POST' });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://gpu.example.ts.net/.well-known/oauth-protected-resource/wallet/mcp"');
      const m = await fetch(`${u}/.well-known/oauth-protected-resource/mcp`);
      expect(m.status).toBe(200);
      expect(await m.json()).toEqual({
        resource: 'https://gpu.example.ts.net/wallet/mcp',
        authorization_servers: ['https://auth.example.ts.net'],
        bearer_methods_supported: ['header'],
        resource_name: 'FronyBrowser',
      });
      // 커넥터(OAuth 토큰)는 admin 목록에 없으므로 vault 라우트는 여전히 닫혀 있다
      const v = await fetch(`${u}/vault/list`, { method: 'POST', headers: { authorization: 'Bearer frony_agent', 'content-type': 'application/json' }, body: '{}' });
      expect(v.status).toBe(403);
    } finally {
      await new Promise<void>((r) => pub.close(() => r()));
    }
  });
});

describe('정적 서빙 (등록 페이지)', () => {
  it('GET /는 frontend/dist의 index.html', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('FronyBrowser 금고');
  });

  it('디렉토리 탈출은 404', async () => {
    const res = await fetch(`${baseUrl}/..%2Fvault.dpapi`);
    expect(res.status).toBe(404);
  });
});

describe('/login — FronyAuth admin/verify 위임', () => {
  it('올바른 자격은 wsess_ 토큰 발급 + gui_login 감사', async () => {
    const token = await login();
    expect(token).toMatch(/^wsess_/);
    expect(audit.records.some((r) => r.evt === 'gui_login' && r.ok === true && r.username === 'admin')).toBe(true);
  });

  it('틀린 비밀번호는 401 + 남은 시도 횟수, 비밀번호는 감사 로그에 없다', async () => {
    const r = await post('/login', { username: 'admin', password: 'nope-secret' });
    expect(r.status).toBe(401);
    expect(r.body['attemptsLeft']).toBe(3);
    expect(JSON.stringify(audit.records)).not.toContain('nope-secret');
  });

  it('락아웃은 429 + retry_after 전달', async () => {
    const r = await post('/login', { username: 'locked-user', password: 'x' });
    expect(r.status).toBe(429);
    expect(r.body['retryAfterSeconds']).toBe(120);
  });
});

describe('/vault/* 인증', () => {
  it('wsess 토큰으로 set → list 왕복 — 응답 어디에도 값이 없다', async () => {
    const token = await login();
    // 첫 저장 전: 금고 파일이 없다 — 헤더가 "미생성"을 보여줄 근거
    const before = (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, unknown>;
    expect(before).toMatchObject({ vaultExists: false, vaultLocked: true, vaultTtlMs: 0, local: false });
    const set = await post('/vault/set', { passphrase: 'pp', key: 'profile.personal.phone', type: 'phone', value: '01012345678' }, token);
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ok: true, key: 'profile.personal.phone', len: 11, grant: false });
    expect(JSON.stringify(set.body)).not.toContain('01012345678');

    const list = await post('/vault/list', { passphrase: 'pp' }, token);
    expect(list.body['keys']).toContainEqual({ name: 'profile.personal.phone', type: 'phone', len: 11, grant: false, label: 'Mobile' });
    expect(JSON.stringify(list.body)).not.toContain('01012345678');

    const setLog = audit.records.find((r) => r.evt === 'vault_set');
    expect(setLog).toMatchObject({ client: 'admin:admin', key: 'profile.personal.phone', ok: true });
    expect(JSON.stringify(setLog)).not.toContain('01012345678');

    // 저장 후 unlock → health가 열림 상태와 잔여 TTL을 보고한다
    expect((await post('/vault/unlock', { passphrase: 'pp' }, token)).status).toBe(200);
    const after = (await (await fetch(`${baseUrl}/health`)).json()) as { vaultExists: boolean; vaultLocked: boolean; vaultTtlMs: number };
    expect(after.vaultExists).toBe(true);
    expect(after.vaultLocked).toBe(false);
    expect(after.vaultTtlMs).toBeGreaterThan(0);
  });

  it('admin 기기 키도 통과 (CLI 경로), 일반 기기 키는 403', async () => {
    const byAdminKey = await post('/vault/list', { passphrase: 'pp' }, 'frony_admin');
    expect(byAdminKey.status).toBe(200);
    const byAgentKey = await post('/vault/list', { passphrase: 'pp' }, 'frony_agent');
    expect(byAgentKey.status).toBe(403);
    expect(audit.records.some((r) => r.evt === 'auth_failed' && r.reason === 'not_admin')).toBe(true);
  });

  it('무효 wsess는 401', async () => {
    const r = await post('/vault/list', { passphrase: 'pp' }, 'wsess_deadbeef');
    expect(r.status).toBe(401);
  });

  it('틀린 패스프레이즈는 403 — 계정 불일치와 구분해 주지 않는다', async () => {
    const token = await login();
    const r = await post('/vault/set', { passphrase: 'wrong', key: 'a.b.c', type: 'text', value: 'v' }, token);
    expect(r.status).toBe(403);
    expect((r.body['error'] as { code: string }).code).toBe('vault_locked');
  });

  it('열린 금고에는 비밀번호 없이 저장된다 — 잠기면 vault_locked (FWL-068)', async () => {
    const token = await login();
    await post('/vault/unlock', { passphrase: 'pp' }, token);
    // 요청에 passphrase가 없다 — 서버가 메모리의 것으로 쓴다. 관리 UI의 "Save this group"이 이 경로다
    const open = await post('/vault/set', { key: 'open.no.pass', type: 'text', value: 'v' }, token);
    expect(open.status).toBe(200);
    expect((await post('/vault/list', {}, token)).body['keys']).toContainEqual(expect.objectContaining({ name: 'open.no.pass' }));
    vault.lock();
    const locked = await post('/vault/set', { key: 'locked.no.pass', type: 'text', value: 'v' }, token);
    expect(locked.status).toBe(403);
    expect((locked.body['error'] as { code: string }).code).toBe('vault_locked');
    await post('/vault/unlock', { passphrase: 'pp' }, token);
  });

  it('잘못된 키 이름·타입·빈 값은 400', async () => {
    const token = await login();
    for (const body of [
      { passphrase: 'pp', key: '{{vault:x}}', type: 'text', value: 'v' },
      { passphrase: 'pp', key: 'a.b.c', type: 'password', value: 'v' },
      { passphrase: 'pp', key: 'a.b.c', type: 'text', value: '' },
      { passphrase: 'pp', entries: [{ key: 'a.b.c', type: 'text' }] },
      { passphrase: 'pp', entries: [{ key: 'a.b.ok', type: 'text', value: 'v' }, { key: 'a.b.c', type: 'nope', value: 'v' }] }, // 하나라도 틀리면 전부 거부
    ]) {
      expect((await post('/vault/set', body, token)).status).toBe(400);
    }
    expect((await post('/vault/list', { passphrase: 'pp' }, token)).body['keys']).not.toContainEqual(expect.objectContaining({ name: 'a.b.ok' }));
  });

  it('entries[]로 여러 키를 한 번에 저장한다 — 응답에 값 없음, 키마다 vault_set 감사', async () => {
    const token = await login();
    const r = await post('/vault/set', { passphrase: 'pp', entries: [{ key: 'b.c.one', type: 'text', value: 'v1' }, { key: 'b.c.two', type: 'text', value: 'value2' }] }, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, keys: [{ key: 'b.c.one', type: 'text', len: 2, grant: false }, { key: 'b.c.two', type: 'text', len: 6, grant: false }] });
    expect(JSON.stringify(r.body)).not.toContain('value2');
    expect(audit.records.filter((x) => x.evt === 'vault_set' && (x.key === 'b.c.one' || x.key === 'b.c.two') && x.ok === true)).toHaveLength(2);
    const list = await post('/vault/list', { passphrase: 'pp' }, token);
    expect(list.body['keys']).toContainEqual({ name: 'b.c.two', type: 'text', len: 6, grant: false, label: 'Two' });
  });

  it('grant 플래그 — 저장한 대로 목록에 실리고, boolean이 아니면 400', async () => {
    const token = await login();
    const set = await post('/vault/set', { passphrase: 'pp', key: 'g.h.pin', type: 'text', value: '1234', grant: true }, token);
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ok: true, key: 'g.h.pin', grant: true });
    const list = await post('/vault/list', { passphrase: 'pp' }, token);
    expect(list.body['keys']).toContainEqual({ name: 'g.h.pin', type: 'text', len: 4, grant: true, label: 'Pin' });
    const bad = await post('/vault/set', { passphrase: 'pp', entries: [{ key: 'g.h.bad', type: 'text', value: 'v', grant: 'yes' }] }, token);
    expect(bad.status).toBe(400);
  });

  it('rm — 있으면 200, 없으면 404', async () => {
    const token = await login();
    await post('/vault/set', { passphrase: 'pp', key: 'tmp.k.key', type: 'text', value: 'v' }, token);
    expect((await post('/vault/rm', { passphrase: 'pp', key: 'tmp.k.key' }, token)).status).toBe(200);
    expect((await post('/vault/rm', { passphrase: 'pp', key: 'tmp.k.key' }, token)).status).toBe(404);
  });

  it('금고가 열려 있으면 set이 메모리도 갱신한다 — 스크러버가 새 값을 알아야 한다', async () => {
    const token = await login();
    await vault.unlock('pp');
    await post('/vault/set', { passphrase: 'pp', key: 'profile.personal.email', type: 'email', value: 'me@x.com' }, token);
    expect(vault.get('profile.personal.email')?.value).toBe('me@x.com');
    vault.lock();
  });
});

describe('/vault/handoff (FWL-042)', () => {
  it('서버 자신의 서비스 키는 인계만 된다 — 다른 vault 라우트는 그 키로 열리지 않는다 (FWL-042)', async () => {
    const t = await login();
    expect((await post('/vault/unlock', { passphrase: 'pp' }, t)).status).toBe(200);
    expect((await post('/vault/handoff', {}, 'frony_service_self')).status).toBe(200);
    expect(consumeUnlockHandoff(handoffFile, Date.now, fakeCipher)?.passphrase).toBe('pp');
    expect(audit.records.find((r) => r.evt === 'vault_handoff' && r.client === 'service:self')).toBeDefined();
    // 금고를 여는 것도 값을 쓰는 것도 이 키로는 안 된다
    expect((await post('/vault/unlock', { passphrase: 'pp' }, 'frony_service_self')).status).toBe(401);
    expect((await post('/vault/set', { passphrase: 'pp', key: 'x.y.z', type: 'text', value: 'v' }, 'frony_service_self')).status).toBe(401);
    vault.lock();
  });

  it('무인증 401, 일반 기기 키 403, 잠긴 금고 403, 열린 뒤 wsess 200 → 인계 파일에 같은 만료가 담긴다', async () => {
    expect((await post('/vault/handoff', {}, undefined)).status).toBe(401);
    expect((await post('/vault/handoff', {}, 'frony_agent')).status).toBe(403);
    const t = await login();
    vault.lock();
    expect((await post('/vault/handoff', {}, t)).status).toBe(403);
    expect((await post('/vault/unlock', { passphrase: 'pp' }, t)).status).toBe(200);
    const r = await post('/vault/handoff', {}, t);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    const h = consumeUnlockHandoff(handoffFile, Date.now, fakeCipher);
    expect(h?.passphrase).toBe('pp');
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as { vaultTtlMs: number };
    expect(Math.abs((h?.unlockedUntil ?? 0) - (Date.now() + health.vaultTtlMs))).toBeLessThan(2_000);
    expect(JSON.stringify(audit.records.filter((x) => x.evt === 'vault_handoff'))).not.toContain('pp');
  });
});

describe('/admin/test-mode (FWL-035/056) — 관리 UI 세션 전용', () => {
  const get = async (bearer?: string) => {
    const res = await fetch(`${baseUrl}/admin/test-mode`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { status: res.status, body: (await res.json()) as { ok: boolean; on?: boolean; held?: string[] } };
  };

  it('무인증 401, 기기 키는 admin이라도 403 — 에이전트 경로에서 결제를 빼는 스위치를 만질 수 없다', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('frony_admin')).status).toBe(403);
    expect((await get('frony_agent')).status).toBe(403);
    expect((await post('/admin/test-mode', { on: true }, 'frony_admin')).status).toBe(403);
    expect(testMode.get()).toBe(false);
  });

  it('wsess로 on과 held를 읽고 바꾼다 — /health에는 없다', async () => {
    const t = await login();
    expect((await get(t)).body).toEqual({ ok: true, on: false, held: [] });
    expect((await post('/admin/test-mode', { on: true }, t)).body).toEqual({ ok: true, on: true, held: [] });
    expect(testMode.get()).toBe(true);
    expect((await post('/admin/test-mode', { held: ['g.pin'] }, t)).body).toEqual({ ok: true, on: true, held: ['g.pin'] });
    expect(testMode.held()).toEqual(['g.pin']);
    expect((await get(t)).body.on).toBe(true);
    expect((await post('/admin/test-mode', { on: 'yes' }, t)).status).toBe(400);
    expect((await post('/admin/test-mode', { held: [1] }, t)).status).toBe(400);
    const health = await (await fetch(`${baseUrl}/health`)).text();
    expect(health.toLowerCase()).not.toContain('test');
    await post('/admin/test-mode', { on: false, held: [] }, t);
  });
});

describe('로컬 모드 (FWL-053)', () => {
  // 인증이 없는 서버 — FronyAuth를 부르는 자리에 닿으면 그건 버그다
  const boom = (): never => { throw new Error('not used in local mode'); };
  let local: Server;
  let url: string;
  let port: number;

  beforeAll(async () => {
    local = createHttpServer({
      handlers: createHandlers({
        vault,
        sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 2 }),
        targets: new Map([['browser', target]]), audit,
      }),
      vault, audit, verify: boom, verifyAdmin: boom,
      local: true,
      adminClients: ['local'],
      vaultAdmin: createVaultAdmin({ vaultFile, sessionsDir, vault, audit, cipher: fakeCipher }),
      vaultFile, staticDir,
    });
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    port = (local.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => local.close(() => r()));
  });

  /** Host 헤더를 직접 정하려면 fetch로는 부족하다 */
  function rawGet(path: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('/health가 local: true', async () => {
    const h = (await (await fetch(`${url}/health`)).json()) as { local: boolean };
    expect(h.local).toBe(true);
  });

  it('/mcp는 Authorization 없이 통과한다', async () => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('/login은 빈 본문에도 wsess_를 내주고, 그 토큰으로 금고를 읽는다', async () => {
    const res = await fetch(`${url}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.token).toMatch(/^wsess_/);
    expect(audit.records.some((r) => r.evt === 'gui_login' && r.username === 'local' && r.ok === true)).toBe(true);

    const list = await fetch(`${url}/vault/list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'pp' }),
    });
    expect(list.status).toBe(200);
  });

  it('루프백이 아닌 Host는 403 — DNS 리바인딩 방어', async () => {
    expect(await rawGet('/health', 'evil.example')).toBe(403);
    expect(await rawGet('/health', '127.0.0.1')).toBe(200);
    expect(await rawGet('/health', `localhost:${port}`)).toBe(200);
  });
});
