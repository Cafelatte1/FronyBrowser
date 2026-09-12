/**
 * 금고 왕복·TTL 자동 lock·틀린 패스프레이즈. DPAPI는 가짜 cipher로 대체한다
 * (실제 DPAPI 왕복은 dpapi.test.ts, win32 전용).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeCipher } from '../../helpers/fakes.js';
import type { VaultEntry } from '@wallet/core';
import {
  createVault,
  defaultLabelFor,
  migrateKeyNames,
  overviewVaultFile,
  removeVaultEntry,
  seedLabels,
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
      ['phone', { type: 'phone', value: '01012345678', grant: false, label: 'Mobile' }],
      ['card.number', { type: 'card', value: '1111222233334444', grant: false, label: 'Card number' }],
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
    expect(vault.list()).toContainEqual({ name: 'card.number', type: 'card', len: 16, grant: false, label: 'Card number' });
    expect(vault.live().size).toBe(2);
  });

  it('applyWrite — 열려 있으면 방금 쓴 항목으로 메모리를 갈아끼운다. 잠긴 금고는 열지 않는다 (FWL-058)', async () => {
    const vault = createVault(seed('applywrite.dpapi'), { cipher: fakeCipher });
    const written: Map<string, VaultEntry> = new Map([
      ['phone', { type: 'phone', value: '01099998888', grant: true, label: 'Mobile' }],
    ]);

    vault.applyWrite(written);
    expect(vault.locked).toBe(true);
    expect(() => vault.list()).toThrow(VaultLockedError);

    await vault.unlock('correct-horse');
    vault.applyWrite(written);
    expect(vault.list()).toEqual([{ name: 'phone', type: 'phone', len: 11, grant: true, label: 'Mobile' }]);
    expect(vault.get('phone')?.value).toBe('01099998888');
    expect(vault.currentPassphrase()).toBe('correct-horse');
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
    setVaultEntry(path, 'pp', 'login.shop.com.id', { type: 'text', value: 'me@x.com', grant: false, label: 'Login ID' }, fakeCipher);
    setVaultEntry(path, 'pp', 'login.shop.com.pw', { type: 'text', value: 'hunter22', grant: false, label: 'Login password' }, fakeCipher);

    const overview = overviewVaultFile(path, 'pp', fakeCipher);
    expect(overview).toContainEqual({ name: 'login.shop.com.pw', type: 'text', len: 8, grant: false, label: 'Login password' });
    expect(JSON.stringify(overview)).not.toContain('hunter22'); // 값은 나가지 않는다

    expect(() => setVaultEntry(path, 'wrong', 'x', { type: 'text', value: 'v', grant: false, label: 'X' }, fakeCipher)).toThrow();
    expect(() => removeVaultEntry(path, 'wrong', 'login.shop.com.id', fakeCipher)).toThrow();

    expect(removeVaultEntry(path, 'pp', 'login.shop.com.id', fakeCipher)).toBe(true);
    expect(removeVaultEntry(path, 'pp', 'no.such.key', fakeCipher)).toBe(false);
    expect(overviewVaultFile(path, 'pp', fakeCipher)).toHaveLength(1);
  });

  it('grant 플래그 — 저장한 대로 돌아오고, 필드가 없는 예전 파일은 false로 읽힌다', async () => {
    const path = join(dir, 'grant.dpapi');
    setVaultEntry(path, 'pp', 'shop.payment.pin', { type: 'text', value: 'x', grant: true, label: 'Pin' }, fakeCipher);
    expect(overviewVaultFile(path, 'pp', fakeCipher)).toContainEqual({
      name: 'shop.payment.pin', type: 'text', len: 1, grant: true, label: 'Pin',
    });

    // grant 필드가 없는 예전 스키마 — 파일을 직접 만들어 읽힌다
    const old = join(dir, 'grant-legacy.dpapi');
    const entropy = createHash('sha256').update('pp', 'utf8').digest();
    writeFileSync(old, fakeCipher.protect(Buffer.from('{"phone":{"type":"phone","value":"01012345678"}}', 'utf8'), entropy));
    const vault = createVault(old, { cipher: fakeCipher });
    await vault.unlock('pp');
    expect(vault.list()).toEqual([{ name: 'phone', type: 'phone', len: 11, grant: false, label: '' }]);
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
describe('라벨 (FWL-056)', () => {
  /** 라벨이 비어 있는 예전 스키마 파일을 그대로 만든다 */
  function seedUnlabelled(name: string, json: string): string {
    const path = join(dir, name);
    const entropy = createHash('sha256').update('pp', 'utf8').digest();
    writeFileSync(path, fakeCipher.protect(Buffer.from(json, 'utf8'), entropy));
    return path;
  }

  it('defaultLabelFor — 스키마 키 정확 일치 → 마지막 두 마디 → 마지막 마디 첫 글자 대문자', () => {
    expect(defaultLabelFor('card.personal.number')).toBe('Card number');
    expect(defaultLabelFor('passport.personal.givenname')).toBe('Given names (Latin)');
    expect(defaultLabelFor('profile.personal.rrn')).toBe('Resident reg. no.');
    expect(defaultLabelFor('shop.com.login.password')).toBe('Login password');
    expect(defaultLabelFor('naver.com.payment.pinnumber')).toBe('Payment PIN');
    expect(defaultLabelFor('shop.com.nickname')).toBe('Nickname');
    expect(defaultLabelFor('memo')).toBe('Memo');
  });

  it('unlock은 파일을 건드리지 않는다 — 라벨이 비어 있어도 바이트가 그대로다', async () => {
    const path = seedUnlabelled('nofill.dpapi', '{"phone":{"type":"phone","value":"01012345678","grant":false}}');
    const before = readFileSync(path);
    const vault = createVault(path, { cipher: fakeCipher });
    await vault.unlock('pp');
    expect(vault.list()).toEqual([{ name: 'phone', type: 'phone', len: 11, grant: false, label: '' }]);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('seedLabels — 백업을 먼저 만들고 빈 라벨만 채운다. 두 번째 호출은 no-op이고 백업도 더 만들지 않는다', () => {
    const path = seedUnlabelled(
      'seed.dpapi',
      '{"profile.personal.phone":{"type":"phone","value":"01012345678","grant":false},'
      + '"card.personal.cvv":{"type":"text","value":"123","grant":true,"label":"내 카드 뒷자리"}}',
    );
    const before = readFileSync(path);

    const first = seedLabels(path, 'pp', fakeCipher);
    expect(first.seeded).toEqual([{ key: 'profile.personal.phone', label: 'Mobile' }]);
    expect(existsSync(first.backup)).toBe(true);
    // 백업은 시딩 이전 내용 그대로 복호화된다
    expect(readFileSync(first.backup).equals(before)).toBe(true);

    const after = overviewVaultFile(path, 'pp', fakeCipher);
    expect(after).toContainEqual({ name: 'profile.personal.phone', type: 'phone', len: 11, grant: false, label: 'Mobile' });
    // 사용자가 이미 지어 둔 이름은 건드리지 않는다
    expect(after).toContainEqual({ name: 'card.personal.cvv', type: 'text', len: 3, grant: true, label: '내 카드 뒷자리' });

    const backupsAfterFirst = readdirSync(dir).filter((f) => f.startsWith('seed.dpapi.bak-'));
    const second = seedLabels(path, 'pp', fakeCipher);
    expect(second.backup).toBe('');
    expect(second.seeded).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.startsWith('seed.dpapi.bak-'))).toEqual(backupsAfterFirst);
  });
});

describe('키 이름 이전 (FWL-057)', () => {
  /** 두 조각이던 옛 이름 열 개 — 값 길이·grant·label을 서로 다르게 둔다 */
  const OLD_KEYS = [
    'profile.rrn', 'profile.phone', 'profile.carrier', 'profile.email', 'profile.address',
    'passport.number', 'passport.surname', 'passport.givenname', 'passport.issue', 'passport.expiry',
  ];
  const newName = (key: string): string => key.replace('.', '.personal.');

  it('migrateKeyNames — 백업을 먼저 만들고 열 개를 그대로 옮긴다. 두 번째 호출은 no-op이고 백업도 더 만들지 않는다', () => {
    const path = join(dir, 'migrate.dpapi');
    writeVaultFile(
      path,
      'pp',
      new Map(OLD_KEYS.map((key, i) => [key, { type: 'text' as const, value: 'v'.repeat(i + 1), grant: i % 2 === 0, label: `L${i}` }])),
      fakeCipher,
    );
    const before = readFileSync(path);

    const first = migrateKeyNames(path, 'pp', fakeCipher);
    expect(first.moved).toEqual(OLD_KEYS.map((key) => ({ from: key, to: newName(key) })));
    expect(existsSync(first.backup)).toBe(true);
    // 백업은 옮기기 이전 내용 그대로 복호화된다
    expect(readFileSync(first.backup).equals(before)).toBe(true);

    // 값 길이·grant·label은 그대로 따라온다
    expect(overviewVaultFile(path, 'pp', fakeCipher)).toEqual(
      OLD_KEYS.map((key, i) => ({ name: newName(key), type: 'text', len: i + 1, grant: i % 2 === 0, label: `L${i}` })),
    );

    const backupsAfterFirst = readdirSync(dir).filter((f) => f.startsWith('migrate.dpapi.bak-'));
    const second = migrateKeyNames(path, 'pp', fakeCipher);
    expect(second).toEqual({ backup: '', moved: [] });
    expect(readdirSync(dir).filter((f) => f.startsWith('migrate.dpapi.bak-'))).toEqual(backupsAfterFirst);
  });
});
