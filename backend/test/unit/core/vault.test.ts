/**
 * 금고 왕복·TTL 자동 lock·틀린 패스프레이즈. DPAPI는 가짜 cipher로 대체한다
 * (실제 DPAPI 왕복은 dpapi.test.ts, win32 전용).
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeCipher } from '../../helpers/fakes.js';
import {
  createVault,
  overviewVaultFile,
  removeVaultEntry,
  setVaultEntry,
  VaultLockedError,
  writeVaultFile,
} from '@wallet/core';


const dir = mkdtempSync(join(tmpdir(), 'wallet-vault-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seed(name: string): string {
  const path = join(dir, name);
  writeVaultFile(
    path,
    'correct-horse',
    new Map([
      ['phone', { type: 'phone', value: '01012345678', grant: false }],
      ['card.number', { type: 'card', value: '1111222233334444', grant: false }],
    ]),
    fakeCipher,
  );
  return path;
}

describe('vault', () => {
  it('쓰기 → unlock → get/list/live 왕복', async () => {
    const vault = createVault(seed('roundtrip.dpapi'), { cipher: fakeCipher });
    expect(vault.locked).toBe(true);
    await vault.unlock('correct-horse');
    expect(vault.locked).toBe(false);
    expect(vault.get('phone')?.value).toBe('01012345678');
    expect(vault.list()).toContainEqual({ name: 'card.number', type: 'card', grant: false });
    expect(vault.live().size).toBe(2);
  });

  it('틀린 패스프레이즈는 unlock 실패, 잠김 유지', async () => {
    const vault = createVault(seed('wrongpass.dpapi'), { cipher: fakeCipher });
    await expect(vault.unlock('wrong')).rejects.toThrow();
    expect(vault.locked).toBe(true);
    expect(() => vault.get('phone')).toThrow(VaultLockedError);
  });

  it('TTL 만료 시 자동 lock', async () => {
    let t = 0;
    const vault = createVault(seed('ttl.dpapi'), {
      cipher: fakeCipher,
      ttlMs: 1000,
      now: () => t,
    });
    await vault.unlock('correct-horse');
    expect(vault.locked).toBe(false);
    t = 999;
    expect(vault.get('phone')).toBeDefined();
    t = 1000;
    expect(vault.locked).toBe(true);
    expect(() => vault.live()).toThrow(VaultLockedError);
  });

  it('currentPassphrase — unlock 동안만, TTL 만료·lock 후에는 null', async () => {
    let t = 0;
    const vault = createVault(seed('pp.dpapi'), { cipher: fakeCipher, ttlMs: 1000, now: () => t });
    expect(vault.currentPassphrase()).toBeNull();
    await vault.unlock('correct-horse');
    expect(vault.currentPassphrase()).toBe('correct-horse');
    t = 1000; // TTL 만료
    expect(vault.currentPassphrase()).toBeNull();
    t = 0;
    await vault.unlock('correct-horse');
    vault.lock();
    expect(vault.currentPassphrase()).toBeNull();
  });

  it('수동 lock', async () => {
    const vault = createVault(seed('manual.dpapi'), { cipher: fakeCipher });
    await vault.unlock('correct-horse');
    vault.lock();
    expect(() => vault.list()).toThrow(VaultLockedError);
  });

  it('원자적 쓰기 — 임시 파일이 남지 않는다', () => {
    seed('atomic.dpapi');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('파일 뮤테이션 — set/remove/overview, 첫 set이 패스프레이즈를 확정한다', () => {
    const path = join(dir, 'mutate.dpapi'); // 파일 없음에서 시작
    setVaultEntry(path, 'pp', 'login.shop.com.id', { type: 'text', value: 'me@x.com', grant: false }, fakeCipher);
    setVaultEntry(path, 'pp', 'login.shop.com.pw', { type: 'text', value: 'hunter22', grant: false }, fakeCipher);

    const overview = overviewVaultFile(path, 'pp', fakeCipher);
    expect(overview).toContainEqual({ name: 'login.shop.com.pw', type: 'text', len: 8, grant: false });
    expect(JSON.stringify(overview)).not.toContain('hunter22'); // 값은 나가지 않는다

    expect(() => setVaultEntry(path, 'wrong', 'x', { type: 'text', value: 'v', grant: false }, fakeCipher)).toThrow();
    expect(() => removeVaultEntry(path, 'wrong', 'login.shop.com.id', fakeCipher)).toThrow();

    expect(removeVaultEntry(path, 'pp', 'login.shop.com.id', fakeCipher)).toBe(true);
    expect(removeVaultEntry(path, 'pp', 'no.such.key', fakeCipher)).toBe(false);
    expect(overviewVaultFile(path, 'pp', fakeCipher)).toHaveLength(1);
  });

  it('grant 플래그 — 저장한 대로 돌아오고, 필드가 없는 예전 파일은 false로 읽힌다', async () => {
    const path = join(dir, 'grant.dpapi');
    setVaultEntry(path, 'pp', 'shop.payment.pin', { type: 'text', value: 'x', grant: true }, fakeCipher);
    expect(overviewVaultFile(path, 'pp', fakeCipher)).toContainEqual({
      name: 'shop.payment.pin', type: 'text', len: 1, grant: true,
    });

    // grant 필드가 없는 예전 스키마 — 파일을 직접 만들어 읽힌다
    const old = join(dir, 'grant-legacy.dpapi');
    const entropy = createHash('sha256').update('pp', 'utf8').digest();
    writeFileSync(old, fakeCipher.protect(Buffer.from('{"phone":{"type":"phone","value":"01012345678"}}', 'utf8'), entropy));
    const vault = createVault(old, { cipher: fakeCipher });
    await vault.unlock('pp');
    expect(vault.list()).toEqual([{ name: 'phone', type: 'phone', grant: false }]);
  });

  it('overview — 파일이 없으면 빈 목록', () => {
    expect(overviewVaultFile(join(dir, 'nope.dpapi'), 'pp', fakeCipher)).toEqual([]);
  });

  it('망가진 파일은 unlock 실패', async () => {
    const path = join(dir, 'corrupt.dpapi');
    writeVaultFile(path, 'p', new Map(), fakeCipher);
    const vault = createVault(path, {
      cipher: {
        ...fakeCipher,
        unprotect: () => Buffer.from('{"phone": "raw-string-not-entry"}'),
      },
    });
    await expect(vault.unlock('p')).rejects.toThrow(/malformed/);
  });
});
