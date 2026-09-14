/**
 * keepalive — 시딩된 origin 순회·리스 존중·잠긴 금고 스킵. 가짜 target으로 검증한다.
 * (쿠키 재저장 자체는 storage-live.test.ts가 실브라우저로 검증)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryAudit, createSessionStore } from '@wallet/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createHandlers } from '@wallet/api';
import { runKeepaliveOnce, seededHosts } from '@wallet/api';
import { fakeTarget, fakeVault } from '../../helpers/fakes.js';

const root = mkdtempSync(join(tmpdir(), 'wallet-keepalive-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seededDir(name: string, hosts: string[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const h of hosts) writeFileSync(join(dir, `${h}.dpapi`), 'blob');
  return dir;
}

function setup(locked = false) {
  const { target, visited } = fakeTarget({ url: 'https://x', tree: '' });
  const audit = createMemoryAudit();
  const sessions = createSessionStore({ ttlMs: 60_000, maxConcurrent: 4 });
  const vault = fakeVault({ locked, passphrase: 'pp' });
  const handlers = createHandlers({ vault, sessions, targets: new Map([['browser', target]]), audit });
  return { handlers, audit, sessions, vault, visited };
}

describe('keepalive', () => {
  it('시딩된 host마다 방문하고 세션을 정리한다 (포트 슬러그 복원 포함)', async () => {
    const dir = seededDir('visit', ['www.shop-a.example', 'www.shop-b.example', '127.0.0.1_8080']);
    writeFileSync(join(dir, 'idp-google.com.dpapi'), 'blob'); // 제공자 파일은 방문할 사이트가 아니다 (FWL-070)
    expect(seededHosts(dir).sort()).toEqual(['127.0.0.1:8080', 'www.shop-a.example', 'www.shop-b.example']);

    const { handlers, audit, vault, visited } = setup();
    await runKeepaliveOnce({ handlers, vault, audit, sessionsDir: dir });
    expect(visited.sort()).toEqual([
      'https://127.0.0.1:8080/', 'https://www.shop-a.example/', 'https://www.shop-b.example/',
    ]);
    expect(audit.records.filter((r) => r.evt === 'keepalive' && r.ok === true)).toHaveLength(3);
    // 세션이 남아 있으면 안 된다 — session_end까지 마쳤다
    expect(audit.records.filter((r) => r.evt === 'session_end')).toHaveLength(3);
  });

  it('금고가 잠겨 있으면 아무것도 하지 않는다', async () => {
    const dir = seededDir('locked', ['www.shop-a.example']);
    const { handlers, audit, vault, visited } = setup(true);
    await runKeepaliveOnce({ handlers, vault, audit, sessionsDir: dir });
    expect(visited).toEqual([]);
    expect(audit.records).toHaveLength(0);
  });

  it('사용자 세션이 리스를 쥔 origin은 건드리지 않는다 — lease_conflict 기록 후 스킵', async () => {
    const dir = seededDir('leased', ['shop.example.com']);
    const { handlers, audit, vault, visited } = setup();
    // 사용자 세션이 먼저 리스를 잡는다
    const user = await handlers.session_begin({ client: 'key:frony' }, { origin: 'https://shop.example.com' });
    if (!user.ok) throw new Error('setup failed');
    await handlers.navigate({ client: 'key:frony' }, user.sessionId, 'https://shop.example.com/cart');

    const before = visited.length;
    await runKeepaliveOnce({ handlers, vault, audit, sessionsDir: dir });
    expect(visited.length).toBe(before); // keepalive의 begin이 리스에서 막혔다
    expect(
      audit.records.some((r) => r.evt === 'keepalive' && r.ok === false && r.code === 'lease_conflict'),
    ).toBe(true);
  });
});
