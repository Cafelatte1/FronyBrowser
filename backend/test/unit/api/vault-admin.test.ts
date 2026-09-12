/**
 * 콘솔이 쓰는 금고 admin 동작 (FWL-056) — grant 플래그만 바꾸기, 금고 생성, 초기화.
 * DPAPI는 가짜 cipher로 대체한다.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryAudit, createVault, overviewVaultFile } from '@wallet/core';
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
    expect((await admin.set(caller, 'pp', 'phone', 'phone', '01012345678')).ok).toBe(true);
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
