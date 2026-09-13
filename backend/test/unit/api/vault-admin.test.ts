/**
 * 콘솔이 쓰는 금고 admin 동작 (FWL-056) — grant 플래그만 바꾸기, 금고 생성, 초기화.
 * DPAPI는 가짜 cipher로 대체한다.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryAudit, createVault, overviewVaultFile, setVaultEntry } from '@wallet/core';
import { createVaultAdmin } from '@wallet/api';
import { fakeCipher } from '../../helpers/fakes.js';

const root = mkdtempSync(join(tmpdir(), 'wallet-admin-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const caller = { client: 'admin:admin' };

function setup(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const vaultFile = join(dir, 'vault.dpapi');
  const sessionsDir = join(dir, 'sessions');
  const vault = createVault(vaultFile, { cipher: fakeCipher });
  const audit = createMemoryAudit();
  const admin = createVaultAdmin({ vaultFile, sessionsDir, vault, audit, cipher: fakeCipher });
  return { admin, vault, audit, vaultFile, sessionsDir };
}

describe('grant — 값을 다시 받지 않고 플래그만 바꾼다', () => {
  it('값 길이는 그대로이고 플래그만 뒤집힌다. 없는 키는 key_not_found', async () => {
    const { admin, vaultFile } = setup('grant');
    expect((await admin.set(caller, 'pp', 'shop.payment.pinnumber', 'text', '1234')).ok).toBe(true);

    const r = await admin.grant(caller, 'pp', 'shop.payment.pinnumber', true);
    expect(r).toEqual({ ok: true, key: 'shop.payment.pinnumber', grant: true });
    expect(overviewVaultFile(vaultFile, 'pp', fakeCipher)).toEqual([
      { name: 'shop.payment.pinnumber', type: 'text', len: 4, grant: true, label: 'Payment PIN' },
    ]);

    const missing = await admin.grant(caller, 'pp', 'no.such.key', true);
    if (missing.ok) throw new Error('should fail');
    expect(missing.error.code).toBe('key_not_found');
  });
});

describe('create — 있는 금고를 덮어쓰지 않는다', () => {
  it('파일이 없으면 빈 금고를 만들고 열어 준다. 두 번째는 already_exists', async () => {
    const { admin, vault, vaultFile } = setup('create');
    expect(await admin.create(caller, 'pp')).toEqual({ ok: true });
    expect(existsSync(vaultFile)).toBe(true);
    expect(vault.locked).toBe(false);
    expect(vault.list()).toEqual([]);

    const again = await admin.create(caller, 'other');
    if (again.ok) throw new Error('should fail');
    expect(again.error.code).toBe('already_exists');
  });
});

describe('reset — 마스터 비밀번호 분실용', () => {
  it('금고 파일과 세션 파일을 지우고 메모리를 잠근다. 없는 파일은 에러가 아니다', async () => {
    const { admin, vault, vaultFile, sessionsDir } = setup('reset');
    expect((await admin.set(caller, 'pp', 'profile.personal.phone', 'phone', '01012345678')).ok).toBe(true);
    await vault.unlock('pp');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'shop.com.json'), 'encrypted', 'utf8');

    expect(await admin.reset(caller)).toEqual({ ok: true });
    expect(existsSync(vaultFile)).toBe(false);
    expect(existsSync(join(sessionsDir, 'shop.com.json'))).toBe(false);
    expect(vault.locked).toBe(true);

    // 이미 아무것도 없는 상태에서 한 번 더 불러도 성공이다
    expect(await admin.reset(caller)).toEqual({ ok: true });
  });
});

describe('열린 금고 — 파일을 다시 복호화하지 않는다 (FWL-058)', () => {
  it('grant는 틀린 패스프레이즈면 파일을 그대로 두고 실패한다', async () => {
    const { admin, vault, vaultFile } = setup('grant-wrong-pp');
    expect((await admin.set(caller, 'pp', 'shop.payment.pinnumber', 'text', '1234')).ok).toBe(true);
    await vault.unlock('pp');
    const before = readFileSync(vaultFile);

    const r = await admin.grant(caller, 'other', 'shop.payment.pinnumber', true);
    if (r.ok) throw new Error('should fail');
    expect(r.error.code).toBe('vault_locked');
    // 다른 패스프레이즈로 재암호화되지 않았다 — 바이트도 플래그도 그대로다
    expect(readFileSync(vaultFile).equals(before)).toBe(true);
    expect(overviewVaultFile(vaultFile, 'pp', fakeCipher)).toEqual([
      { name: 'shop.payment.pinnumber', type: 'text', len: 4, grant: false, label: 'Payment PIN' },
    ]);
  });

  it('overview는 열려 있어도 파일과 같은 줄을 돌려준다', async () => {
    const { admin, vault, vaultFile } = setup('overview-open');
    expect((await admin.set(caller, 'pp', 'card.personal.number', 'card', '1111222233334444', true)).ok).toBe(true);
    expect((await admin.set(caller, 'pp', 'profile.personal.phone', 'phone', '01012345678')).ok).toBe(true);
    await vault.unlock('pp');

    const r = await admin.overview(caller, 'pp');
    if (!r.ok) throw new Error('should succeed');
    expect(r.keys).toEqual([
      { name: 'card.personal.number', type: 'card', len: 16, grant: true, label: 'Card number' },
      { name: 'profile.personal.phone', type: 'phone', len: 11, grant: false, label: 'Mobile' },
    ]);
    expect(r.keys).toEqual(overviewVaultFile(vaultFile, 'pp', fakeCipher));
  });
});

describe('rmKeys — 지목한 키만 지운다', () => {
  it('이름을 댄 두 키만 사라지고 나머지는 그대로다. 같은 호출을 한 번 더 하면 key_not_found', async () => {
    const { admin, vaultFile } = setup('rm-keys');
    expect((await admin.set(caller, 'pp', 'kurly.login.id', 'text', 'me@example.com')).ok).toBe(true);
    expect((await admin.set(caller, 'pp', 'kurly.payment.pin', 'text', '1234', true)).ok).toBe(true);
    expect((await admin.set(caller, 'pp', 'card.personal.number', 'card', '1111222233334444')).ok).toBe(true);

    const r = await admin.rmKeys(caller, 'pp', ['kurly.login.id', 'kurly.payment.pin']);
    if (!r.ok) throw new Error('should succeed');
    expect(r.removed).toEqual(['kurly.login.id', 'kurly.payment.pin']);
    expect(overviewVaultFile(vaultFile, 'pp', fakeCipher).map((k) => k.name)).toEqual(['card.personal.number']);

    const again = await admin.rmKeys(caller, 'pp', ['kurly.login.id', 'kurly.payment.pin']);
    if (again.ok) throw new Error('should fail');
    expect(again.error.code).toBe('key_not_found');
  });

  it('있는 키와 없는 키를 섞어 보내면 있는 것만 지우고 그것만 removed에 담는다', async () => {
    const { admin, vaultFile } = setup('rm-keys-partial');
    expect((await admin.set(caller, 'pp', 'shop.login.id', 'text', 'a')).ok).toBe(true);
    expect((await admin.set(caller, 'pp', 'shop.login.password', 'text', 'b')).ok).toBe(true);

    const r = await admin.rmKeys(caller, 'pp', ['shop.login.id', 'shop.login.nosuch']);
    if (!r.ok) throw new Error('should succeed');
    expect(r.removed).toEqual(['shop.login.id']);
    expect(overviewVaultFile(vaultFile, 'pp', fakeCipher).map((k) => k.name)).toEqual(['shop.login.password']);
  });
});

describe('서버 밖에서 파일이 바뀐 경우 (FWL-058)', () => {
  it('CLI가 직접 쓴 키를 콘솔의 grant 토글이 되돌리지 않는다', async () => {
    const { admin, vault, vaultFile } = setup('stale-memory');
    expect((await admin.set(caller, 'pp', 'shop.payment.pinnumber', 'text', '1234')).ok).toBe(true);
    await vault.unlock('pp');

    // CLI가 하는 일 — 서버를 거치지 않고 금고 파일을 직접 고친다
    setVaultEntry(vaultFile, 'pp', 'shop.login.id', { type: 'text', value: 'me@example.com', grant: false, label: 'ID' }, fakeCipher);
    // 파일시스템 타임스탬프 해상도가 낮으면 두 쓰기의 mtime이 같아진다 — 밖에서 바뀐 사실만 재현하면 된다
    const bumped = new Date(statSync(vaultFile).mtimeMs + 2_000);
    utimesSync(vaultFile, bumped, bumped);

    expect((await admin.grant(caller, 'pp', 'shop.payment.pinnumber', true)).ok).toBe(true);
    expect(overviewVaultFile(vaultFile, 'pp', fakeCipher).map((k) => k.name).sort()).toEqual([
      'shop.login.id', 'shop.payment.pinnumber',
    ]);
  });
});
