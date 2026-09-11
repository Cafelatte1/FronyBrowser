/**
 * 금고. 값은 이 프로세스 메모리에만 존재한다.
 *
 * 완전한 메모리 소거는 불가능하다 (Node 문자열은 immutable). 대응은
 * zeroize가 아니라 짧은 TTL + 자동 lock이다 (11절).
 *
 * 파일 스키마 (9.2): 단일 DPAPI 블롭. 복호화하면 key → {type, value, grant} 맵이다 —
 * 타입까지 담아 policy 없이 자기완결로 동작한다 (CLI가 policy를 몰라도 됨).
 * grant=true는 pay grant가 있어야만 입력되는 키를 뜻한다.
 * entropy = SHA-256(passphrase) — 계정 탈취만으로도, 패스프레이즈만으로도 못 연다.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as dpapi from './dpapi.js';
import type { ValueType } from './variants.js';

export type VaultEntry = { readonly type: ValueType; readonly value: string; readonly grant: boolean };

/** 테스트에서 DPAPI를 대체하기 위한 주입점 */
export type Cipher = {
  protect(plaintext: Buffer, entropy: Buffer): Buffer;
  unprotect(blob: Buffer, entropy: Buffer): Buffer;
};

export class VaultLockedError extends Error {
  constructor() {
    super('vault_locked');
  }
}

export interface Vault {
  readonly locked: boolean;
  /** `until`이 있으면 만료를 그 시각으로 복원한다 — 단 now+TTL을 넘기지 않는다 (인계용, FWL-042) */
  unlock(passphrase: string, opts?: { readonly until?: number }): Promise<void>;
  lock(): void;
  /** 키 이름과 타입만. 값은 나가지 않는다 */
  list(): ReadonlyArray<{ name: string; type: ValueType; grant: boolean }>;
  get(key: string): VaultEntry | undefined;
  /** 스크러버가 매칭에 쓸 현재 살아 있는 값들 */
  live(): ReadonlyMap<string, VaultEntry>;
  /**
   * unlock에 쓴 패스프레이즈 — storageState 암복호화용 (같은 키 체계, 규칙 11).
   * 잠겨 있으면(TTL 만료 포함) null. 응답으로 내보내는 코드는 존재하면 안 된다.
   */
  currentPassphrase(): string | null;
  /** unlock 잔여 시간(ms). 잠겨 있으면 0. 값이 아니라 상태라 /health로 내보내도 된다 */
  remainingMs(): number;
}

const VALUE_TYPES: ReadonlySet<string> = new Set([
  'card', 'phone', 'rrn', 'email', 'name', 'address', 'text',
]);

function entropyOf(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase, 'utf8').digest();
}

function decode(json: string): Map<string, VaultEntry> {
  const raw: unknown = JSON.parse(json);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('vault file: not an object');
  }
  const out = new Map<string, VaultEntry>();
  for (const [key, entry] of Object.entries(raw)) {
    const e = entry as { type?: unknown; value?: unknown; grant?: unknown };
    if (typeof e?.value !== 'string' || typeof e?.type !== 'string' || !VALUE_TYPES.has(e.type)) {
      throw new Error(`vault file: malformed entry for key "${key}"`);
    }
    // grant가 없는 예전 파일은 false로 읽는다 — 있으면 boolean이어야 한다
    if (e.grant !== undefined && typeof e.grant !== 'boolean') {
      throw new Error(`vault file: malformed entry for key "${key}"`);
    }
    out.set(key, {
      type: e.type as ValueType,
      value: e.value,
      grant: typeof e.grant === 'boolean' ? e.grant : false,
    });
  }
  return out;
}

/** CLI용 파일 입출력. 서버 쪽 Vault 인터페이스는 읽기 전용이다 */
export function readVaultFile(
  path: string,
  passphrase: string,
  cipher: Cipher = dpapi,
): Map<string, VaultEntry> {
  const blob = readFileSync(path);
  const plain = cipher.unprotect(blob, entropyOf(passphrase));
  return decode(plain.toString('utf8'));
}

/** 임시 파일 + rename 원자적 교체 (9.2) — 쓰는 도중 죽어도 금고가 날아가지 않는다 */
export function writeVaultFile(
  path: string,
  passphrase: string,
  entries: ReadonlyMap<string, VaultEntry>,
  cipher: Cipher = dpapi,
): void {
  const json = JSON.stringify(Object.fromEntries(entries));
  const blob = cipher.protect(Buffer.from(json, 'utf8'), entropyOf(passphrase));
  const tmp = join(dirname(path), `.vault-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, blob);
  renameSync(tmp, path);
}

/**
 * 파일 뮤테이션 (CLI·admin GUI 공용). 패스프레이즈가 맞아야만 재암호화된다 —
 * 파일이 없을 때의 첫 set이 패스프레이즈를 확정한다.
 */
export function setVaultEntry(
  path: string,
  passphrase: string,
  key: string,
  entry: VaultEntry,
  cipher: Cipher = dpapi,
): void {
  setVaultEntries(path, passphrase, [[key, entry]], cipher);
}

/** 여러 항목을 한 번의 복호화·재암호화로 쓴다 — DPAPI 호출은 프로세스 spawn이라 항목마다 하면 초 단위로 느리다 */
export function setVaultEntries(
  path: string,
  passphrase: string,
  items: ReadonlyArray<readonly [string, VaultEntry]>,
  cipher: Cipher = dpapi,
): void {
  const entries = existsSync(path)
    ? readVaultFile(path, passphrase, cipher)
    : new Map<string, VaultEntry>();
  for (const [key, entry] of items) entries.set(key, entry);
  writeVaultFile(path, passphrase, entries, cipher);
}

export function removeVaultEntry(
  path: string,
  passphrase: string,
  key: string,
  cipher: Cipher = dpapi,
): boolean {
  const entries = readVaultFile(path, passphrase, cipher);
  if (!entries.delete(key)) return false;
  writeVaultFile(path, passphrase, entries, cipher);
  return true;
}

/** 이름·타입·길이만 — 값은 반환하지 않는다 */
export function overviewVaultFile(
  path: string,
  passphrase: string,
  cipher: Cipher = dpapi,
): Array<{ name: string; type: ValueType; len: number; grant: boolean }> {
  if (!existsSync(path)) return [];
  return [...readVaultFile(path, passphrase, cipher)].map(([name, e]) => ({
    name,
    type: e.type,
    len: e.value.length,
    grant: e.grant,
  }));
}

export type VaultOptions = {
  /** unlock 유지 시간. 만료 시 자동 lock (기본 15분 — 서버는 WALLET_UNLOCK_TTL로 늘린다) */
  readonly ttlMs?: number;
  readonly cipher?: Cipher;
  readonly now?: () => number;
};

export function createVault(path: string, opts: VaultOptions = {}): Vault {
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const cipher = opts.cipher ?? dpapi;
  const now = opts.now ?? Date.now;

  let entries: Map<string, VaultEntry> | null = null;
  let unlockedUntil = 0;
  let passphraseInMemory: string | null = null;

  function ensureUnlocked(): Map<string, VaultEntry> {
    if (entries !== null && now() >= unlockedUntil) {
      entries = null; // TTL 만료 — 자동 lock
    }
    if (entries === null) throw new VaultLockedError();
    return entries;
  }

  return {
    get locked() {
      if (entries !== null && now() >= unlockedUntil) entries = null;
      return entries === null;
    },
    async unlock(passphrase: string, opts = {}) {
      // 실패 시 원인(파일 없음 vs 패스프레이즈 오류)을 구분해 주지 않는다 —
      // 감사 로그에는 남기되 호출자에게는 동일한 실패다
      entries = readVaultFile(path, passphrase, cipher);
      passphraseInMemory = passphrase;
      const fresh = now() + ttlMs;
      unlockedUntil = opts.until !== undefined ? Math.min(opts.until, fresh) : fresh;
      if (unlockedUntil <= now()) {
        entries = null;
        passphraseInMemory = null;
        throw new VaultLockedError();
      }
    },
    lock() {
      entries = null;
      passphraseInMemory = null;
    },
    currentPassphrase() {
      // locked getter가 TTL 만료를 반영한다 — 잠긴 뒤에는 절대 내주지 않는다
      if (this.locked) {
        passphraseInMemory = null;
        return null;
      }
      return passphraseInMemory;
    },
    remainingMs() {
      return this.locked ? 0 : unlockedUntil - now();
    },
    list() {
      return [...ensureUnlocked()].map(([name, e]) => ({ name, type: e.type, grant: e.grant }));
    },
    get(key: string) {
      return ensureUnlocked().get(key);
    },
    live() {
      return ensureUnlocked();
    },
  };
}
