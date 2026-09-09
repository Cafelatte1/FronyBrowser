/**
 * unlock 인계 (FWL-042) — 배포 재시작을 넘겨 금고 unlock을 이어간다.
 *
 * 패스프레이즈를 디스크에 영속하는 것은 거부했다 (DPAPI 한 겹만 남는다, 2026-09-06 decided). 대신 떠 있는
 * 프로세스가 요청을 받으면 `{ passphrase, unlockedUntil, issuedAt }`을 DPAPI로 감싼 파일 하나를 남기고,
 * 다음 프로세스가 기동 때 그 파일을 읽자마자 지우고 **같은 만료 시각**으로 unlock을 복원한다.
 * 파일은 재시작 창 동안만 존재하며, 10분이 지났거나 만료 시각을 넘긴 인계는 버린다.
 * 어떤 경로로도 이 파일의 내용이 로그·응답에 실리지 않는다.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as dpapi from './dpapi.js';
import type { Cipher } from './vault.js';

export type UnlockHandoff = {
  readonly passphrase: string;
  /** 인계 전 프로세스의 unlock 만료 시각(epoch ms). 새 프로세스는 이 시각을 넘기지 않는다 */
  readonly unlockedUntil: number;
  readonly issuedAt: number;
};

/** 이보다 오래된 인계 파일은 쓰지 않는다 — 실패한 배포 뒤에 남은 파일이 다음 주에 살아나면 안 된다 */
export const HANDOFF_MAX_AGE_MS = 10 * 60_000;

const ENTROPY = createHash('sha256').update('frony-wallet-unlock-handoff', 'utf8').digest();

export function writeUnlockHandoff(file: string, h: UnlockHandoff, cipher: Cipher = dpapi): void {
  mkdirSync(dirname(file), { recursive: true });
  const blob = cipher.protect(Buffer.from(JSON.stringify(h), 'utf8'), ENTROPY);
  const tmp = join(dirname(file), `.handoff-${process.pid}.tmp`);
  writeFileSync(tmp, blob);
  renameSync(tmp, file);
}

/** 파일이 있으면 무조건 지운다 — 읽혔든 깨졌든 두 번 쓰이지 않는다. 쓸 수 없는 인계는 null */
export function consumeUnlockHandoff(file: string, now: () => number = Date.now, cipher: Cipher = dpapi): UnlockHandoff | null {
  if (!existsSync(file)) return null;
  let blob: Buffer;
  try {
    blob = readFileSync(file);
  } finally {
    try { unlinkSync(file); } catch { /* 이미 없음 */ }
  }
  try {
    const raw = JSON.parse(cipher.unprotect(blob, ENTROPY).toString('utf8')) as Partial<UnlockHandoff>;
    if (typeof raw.passphrase !== 'string' || typeof raw.unlockedUntil !== 'number' || typeof raw.issuedAt !== 'number') return null;
    const t = now();
    if (t - raw.issuedAt > HANDOFF_MAX_AGE_MS || raw.unlockedUntil <= t) return null;
    return { passphrase: raw.passphrase, unlockedUntil: raw.unlockedUntil, issuedAt: raw.issuedAt };
  } catch {
    return null;
  }
}
