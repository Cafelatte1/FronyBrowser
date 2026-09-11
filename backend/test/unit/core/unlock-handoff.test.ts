/** unlock 인계 파일 (FWL-042) — 한 번만 읽히고, 오래되면 버려지고, 어떤 경우에도 지워진다 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HANDOFF_MAX_AGE_MS, consumeUnlockHandoff, createVault, writeUnlockHandoff, writeVaultFile } from '@wallet/core';
import { fakeCipher } from '../../helpers/fakes.js';

const dir = mkdtempSync(join(tmpdir(), 'wallet-handoff-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'unlock-handoff.dpapi');
const T0 = 1_700_000_000_000;

describe('unlock 인계 파일', () => {
  it('write → consume 왕복, 파일은 읽는 즉시 사라지고 두 번째는 null', () => {
    writeUnlockHandoff(file, { passphrase: 'pp', unlockedUntil: T0 + 60_000, issuedAt: T0 }, fakeCipher);
    expect(existsSync(file)).toBe(true);
    expect(consumeUnlockHandoff(file, () => T0 + 5_000, fakeCipher)).toEqual({ passphrase: 'pp', unlockedUntil: T0 + 60_000, issuedAt: T0 });
    expect(existsSync(file)).toBe(false);
    expect(consumeUnlockHandoff(file, () => T0 + 5_000, fakeCipher)).toBeNull();
  });

  it('10분이 지났거나 만료를 넘긴 인계는 null — 파일은 그래도 지운다', () => {
    writeUnlockHandoff(file, { passphrase: 'pp', unlockedUntil: T0 + 3_600_000, issuedAt: T0 }, fakeCipher);
    expect(consumeUnlockHandoff(file, () => T0 + HANDOFF_MAX_AGE_MS + 1, fakeCipher)).toBeNull();
    expect(existsSync(file)).toBe(false);
    writeUnlockHandoff(file, { passphrase: 'pp', unlockedUntil: T0 + 1_000, issuedAt: T0 }, fakeCipher);
    expect(consumeUnlockHandoff(file, () => T0 + 1_000, fakeCipher)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('깨진 파일·다른 키로 싼 파일은 null', () => {
    writeFileSync(file, 'garbage');
    expect(consumeUnlockHandoff(file, () => T0, fakeCipher)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('vault.unlock(until)은 인계된 만료를 쓰되 now+TTL을 넘기지 않고, 이미 지난 만료는 거부한다', async () => {
    const vaultFile = join(dir, 'vault.dpapi');
    writeVaultFile(vaultFile, 'pp', new Map([['phone', { type: 'phone', value: '01012345678', grant: false }]]), fakeCipher);
    let t = T0;
    const v = createVault(vaultFile, { cipher: fakeCipher, ttlMs: 60_000, now: () => t });
    await v.unlock('pp', { until: T0 + 20_000 });
    expect(v.remainingMs()).toBe(20_000);
    await v.unlock('pp', { until: T0 + 999_999 });
    expect(v.remainingMs()).toBe(60_000);
    await expect(v.unlock('pp', { until: T0 })).rejects.toThrow();
    expect(v.locked).toBe(true);
    t += 1;
  });
});
