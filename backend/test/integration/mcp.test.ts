/**
 * MCP 입구 E2E — 실제 SDK 클라이언트로 /mcp 왕복. 브라우저는 가짜 target.
 * 인증(401/503), 도구 목록(vault_unlock 미노출), egress 스크럽까지 확인한다.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMemoryAudit, createSessionStore, parsePolicy } from '@wallet/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Verifier } from '@wallet/api';
import { createHandlers } from '@wallet/api';
import { createVaultAdmin } from '@wallet/api';
import { createHttpServer } from '@wallet/api';
import { fakeTarget, fakeVault } from '../helpers/fakes.js';
import { connectMcp } from '../helpers/mcp-client.js';

const SECRET_PHONE = '01012345678';

const vault = fakeVault({ entries: { phone: { type: 'phone', value: SECRET_PHONE } } });

/** 페이지가 입력값을 본문에 되비추는 최악 케이스 — egress가 가려야 한다 */
const { target } = fakeTarget({
  url: 'https://shop.com',
  tree: `- textbox "휴대폰" [ref=1:e1]\n- text "확인: 010-1234-5678"`,
});

const verify: Verifier = async (bearer) => {
  if (bearer === 'frony_valid') return { ok: true, client: 'frony' };
  if (bearer === 'frony_down') return { ok: false, status: 503 };
  return { ok: false, status: 401 };
};

const audit = createMemoryAudit();
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const handlers = createHandlers({
    vault,
    policy: parsePolicy('[keys."phone"]\ntype="phone"\nallow_origins=["https://shop.com"]\n'),
    sessions: createSessionStore({ ttlMs: 60_000, maxConcurrent: 4 }),
    targets: new Map([['browser', target]]),
    audit,
  });
  server = createHttpServer({
    handlers,
    vault,
    audit,
    verify,
    adminClients: ['admin-box'],
    vaultAdmin: createVaultAdmin({ vaultFile: join(tmpdir(), 'unused-vault.dpapi'), vault, audit }),
    verifyAdmin: async () => ({ ok: false, status: 401 }),
    staticDir: join(tmpdir(), 'unused-static'),
    authIssuer: 'https://auth.example.ts.net',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const connect = (token: string) => connectMcp(baseUrl, token);

describe('MCP 입구', () => {
  it('도구 목록에 vault_unlock이 없다 (8.4)', async () => {
    const s = await connect('frony_valid');
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('fill');
    expect(tools).toContain('vault_list');
    expect(tools).not.toContain('vault_unlock');
    await s.close();
  });

  it('에이전트가 읽는 문자열은 영어이고 특정 서비스·사이트를 부르지 않는다 (FWL-039)', async () => {
    const s = await connect('frony_valid');
    const { tools } = await s.client.listTools();
    const instructions = s.client.getInstructions() ?? '';
    const texts = [instructions, ...tools.map((t) => `${t.description ?? ''}\n${JSON.stringify(t.inputSchema)}`)];
    const banned = /[가-힣]|FronyShopping|begin_checkout|Kurly|Coupang|Coupay|KCP|playbook/i;
    for (const t of texts) expect(t).not.toMatch(banned);
    expect(instructions).toContain('vault_locked');
    expect(instructions).not.toMatch(/check_cart|open_transaction|record_purchase/);
    // 소비자가 이름으로 의존하는 계약 (2026-09-06 frozen)
    const byName = new Map(tools.map((t) => [t.name, t]));
    const props = (n: string) => Object.keys((byName.get(n)?.inputSchema as { properties?: object }).properties ?? {});
    expect(props('session_begin')).toEqual(expect.arrayContaining(['origin', 'traceId', 'expect']));
    expect(JSON.stringify(byName.get('session_begin')?.inputSchema)).toContain('maxAmount');
    expect(JSON.stringify(byName.get('session_begin')?.inputSchema)).not.toContain('merchant');
    expect(props('session_end')).toContain('loggedIn');
    expect(props('fill')).toEqual(expect.arrayContaining(['ref', 'value', 'grant']));
    await s.close();
  });

  it('session_begin → fill 왕복 — 응답 어디에도 값이 없다', async () => {
    const s = await connect('frony_valid');
    const begun = await s.call<{ ok: boolean; sessionId: string }>('session_begin', { origin: 'https://shop.com' });
    expect(begun.ok).toBe(true);
    const filled = await s.text('fill', { sessionId: begun.sessionId, ref: '1:e1', value: '{{vault:phone}}' });
    expect(JSON.parse(filled)).toMatchObject({ ok: true, filledFrom: 'phone', len: 11 });
    expect(filled).not.toContain(SECRET_PHONE);
    await s.call('session_end', { sessionId: begun.sessionId });
    await s.close();
  });

  it('페이지가 값을 본문에 되비춰도 egress가 [REDACTED:key]로 가리고 scrub_hit을 남긴다', async () => {
    const s = await connect('frony_valid');
    const begun = await s.call<{ sessionId: string }>('session_begin', { origin: 'https://shop.com' });
    const snap = await s.text('snapshot', { sessionId: begun.sessionId });
    expect(snap).not.toContain('010-1234-5678'); // variants 하이픈 변형까지 매칭
    expect(snap).toContain('[REDACTED:phone]');
    expect(audit.records.some((r) => r.evt === 'scrub_hit' && r.key === 'phone')).toBe(true);
    await s.call('session_end', { sessionId: begun.sessionId });
    await s.close();
  });

  it('sessionId를 잃어도 session_list → session_status로 이어받는다 (FWL-008)', async () => {
    const s = await connect('frony_valid');
    const begun = await s.call<{ sessionId: string }>('session_begin', { origin: 'https://shop.com' });

    const listed = await s.call<{ ok: boolean; sessions: Array<{ sessionId: string; ttlRemainingMs: number }> }>('session_list');
    expect(listed.ok).toBe(true);
    const found = listed.sessions.find((x) => x.sessionId === begun.sessionId);
    expect(found).toBeDefined();
    expect(found!.ttlRemainingMs).toBeGreaterThan(0);

    const status = await s.call('session_status', { sessionId: begun.sessionId });
    expect(status).toMatchObject({ ok: true, url: 'https://shop.com', pages: [{ index: 0, current: true }], snapshotGen: 1 });
    await s.call('session_end', { sessionId: begun.sessionId });
    await s.close();
  });

  it('무효 토큰은 연결 거부(401), FronyAuth 불통은 503', async () => {
    await expect(connect('bad_token')).rejects.toThrow(/invalid token/);
    await expect(connect('frony_down')).rejects.toThrow(/auth backend unavailable/);
  });
});

describe('내부 HTTP 경로', () => {
  it('/health는 무인증', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('/vault/unlock은 admin이 아니면 403', async () => {
    const res = await fetch(`${baseUrl}/vault/unlock`, {
      method: 'POST',
      headers: { authorization: 'Bearer frony_valid', 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(audit.records.some((r) => r.evt === 'auth_failed' && r.reason === 'not_admin')).toBe(true);
  });
});
