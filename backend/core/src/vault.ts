/**
 * 금고. 값은 이 프로세스 메모리에만 존재한다.
 *
 * 완전한 메모리 소거는 불가능하다 (Node 문자열은 immutable). 대응은
 * zeroize가 아니라 짧은 TTL + 자동 lock이다 (11절).
 *
 * 파일 스키마 (9.2): 단일 DPAPI 블롭. 복호화하면 key → {type, value, grant, label} 맵이다 —
 * 타입까지 담아 policy 없이 자기완결로 동작한다 (CLI가 policy를 몰라도 됨).
 * grant=true는 pay grant가 있어야만 입력되는 키를 뜻한다.
 * entropy = SHA-256(passphrase) — 계정 탈취만으로도, 패스프레이즈만으로도 못 연다.
 */

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as dpapi from './dpapi.js';
import type { ValueType } from './variants.js';

/** label은 사람이 보는 이름이다 (FWL-056). 값이 아니므로 목록·응답에 실어도 된다 */
export type VaultEntry = { readonly type: ValueType; readonly value: string; readonly grant: boolean; readonly label: string };

/** 라벨 최대 길이 — 넘는 입력은 admin 핸들러가 거부하고, 파일에 쓸 때 한 번 더 자른다 */
const LABEL_MAX = 60;

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
  /** 키 이름과 타입만. 값은 나가지 않는다 (len은 길이지 값이 아니다) */
  list(): ReadonlyArray<{ name: string; type: ValueType; len: number; grant: boolean; label: string }>;
  /**
   * 파일에 이미 쓴 항목을 메모리에도 반영한다 (FWL-058). 파일을 다시 복호화하지 않으려고 존재한다 —
   * 쓰기가 성공한 직후에만 부르고, 잠겨 있으면 아무 일도 하지 않는다.
   * 여기서 새 값이 들어오지는 않는다: 호출자가 방금 쓴 그대로를 넘긴다.
   */
  applyWrite(entries: ReadonlyMap<string, VaultEntry>): void;
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

/** 스키마가 정한 14개 키의 이름 — 정확히 일치할 때만 쓴다 */
const SCHEMA_LABELS: ReadonlyMap<string, string> = new Map([
  ['profile.personal.rrn', 'Resident reg. no.'],
  ['profile.personal.phone', 'Mobile'],
  ['profile.personal.carrier', 'Carrier'],
  ['profile.personal.email', 'Email'],
  ['profile.personal.address', 'Home address'],
  ['card.personal.number', 'Card number'],
  ['card.personal.expiry', 'Expiry'],
  ['card.personal.cvv', 'CVV'],
  ['card.personal.password2', 'Card password'],
  ['passport.personal.number', 'Passport number'],
  ['passport.personal.surname', 'Surname (Latin)'],
  ['passport.personal.givenname', 'Given names (Latin)'],
  ['passport.personal.issue', 'Date of issue'],
  ['passport.personal.expiry', 'Date of expiry'],
]);

/** origin마다 접두가 달라지는 키 — 마지막 두 마디로 알아본다 */
const SUFFIX_LABELS: ReadonlyMap<string, string> = new Map([
  ['login.id', 'Login ID'],
  ['login.password', 'Login password'],
  ['payment.pinnumber', 'Payment PIN'],
]);

/**
 * 라벨이 비어 있던 항목에 이름을 지어 준다 (FWL-056). 화면이 렌더 시점에 대체 문구를 고르지
 * 않도록, 이름을 한 번 정해 파일에 쓴다 — 채우는 시점은 seedLabels가 정한다.
 */
export function defaultLabelFor(key: string): string {
  const exact = SCHEMA_LABELS.get(key);
  if (exact !== undefined) return exact;
  const segments = key.split('.');
  const suffix = SUFFIX_LABELS.get(segments.slice(-2).join('.'));
  if (suffix !== undefined) return suffix;
  const last = segments[segments.length - 1] ?? key;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

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
    const e = entry as { type?: unknown; value?: unknown; grant?: unknown; label?: unknown };
    if (typeof e?.value !== 'string' || typeof e?.type !== 'string' || !VALUE_TYPES.has(e.type)) {
      throw new Error(`vault file: malformed entry for key "${key}"`);
    }
    // grant가 없는 예전 파일은 false로 읽는다 — 있으면 boolean이어야 한다
    if (e.grant !== undefined && typeof e.grant !== 'boolean') {
      throw new Error(`vault file: malformed entry for key "${key}"`);
    }
    // label이 없는 예전 파일은 빈 문자열로 읽는다 — 이름은 seedLabels가 운영자 요청으로만 채운다 (FWL-056)
    if (e.label !== undefined && typeof e.label !== 'string') {
      throw new Error(`vault file: malformed entry for key "${key}"`);
    }
    out.set(key, {
      type: e.type as ValueType,
      value: e.value,
      grant: typeof e.grant === 'boolean' ? e.grant : false,
      label: typeof e.label === 'string' ? e.label : '',
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
  const json = JSON.stringify(Object.fromEntries(
    [...entries].map(([key, e]) => [key, { ...e, label: e.label.trim().slice(0, LABEL_MAX) }]),
  ));
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
): Array<{ name: string; type: ValueType; len: number; grant: boolean; label: string }> {
  if (!existsSync(path)) return [];
  return [...readVaultFile(path, passphrase, cipher)].map(([name, e]) => ({
    name,
    type: e.type,
    len: e.value.length,
    grant: e.grant,
    label: e.label,
  }));
}

/** 백업 파일 접미 — `.bak-YYYYMMDD-HHMMSS` */
function backupStamp(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

/**
 * 라벨이 비어 있는 항목에 이름을 지어 넣는다 (FWL-056). 볼트를 열 때마다 자동으로 하지 않는다 —
 * 운영자가 부를 때 한 번만, 그것도 기존 파일을 백업한 뒤에 쓴다.
 * 반환은 채운 키와 그 이름, 그리고 방금 쓴 항목들이다 — entries는 호출자가 메모리에 반영하려고
 * 쓴다 (Vault.applyWrite, FWL-058). 응답에 실리는 것은 seeded뿐이다. 값은 실리지 않는다 (규칙 5).
 */
export function seedLabels(
  path: string,
  passphrase: string,
  cipher: Cipher = dpapi,
): { readonly backup: string; readonly seeded: ReadonlyArray<{ key: string; label: string }>; readonly entries: ReadonlyMap<string, VaultEntry> } {
  const entries = readVaultFile(path, passphrase, cipher);
  const empty = [...entries].filter(([, e]) => e.label === '');
  if (empty.length === 0) return { backup: '', seeded: [], entries };

  // 쓰기 전에 원본을 복사해 둔다 — 이름을 잘못 지어도 되돌릴 수 있어야 한다
  const backup = `${path}.bak-${backupStamp(new Date())}`;
  copyFileSync(path, backup);

  const seeded = empty.map(([key, e]) => {
    const label = defaultLabelFor(key);
    entries.set(key, { ...e, label });
    return { key, label };
  });
  writeVaultFile(path, passphrase, entries, cipher);
  return { backup, seeded, entries };
}

/** FWL-057: 두 조각이던 옛 이름 → `그룹.대상.항목`. 값·grant·label은 그대로 옮긴다 */
export const KEY_RENAMES: ReadonlyMap<string, string> = new Map([
  ['profile.rrn', 'profile.personal.rrn'],
  ['profile.phone', 'profile.personal.phone'],
  ['profile.carrier', 'profile.personal.carrier'],
  ['profile.email', 'profile.personal.email'],
  ['profile.address', 'profile.personal.address'],
  ['passport.number', 'passport.personal.number'],
  ['passport.surname', 'passport.personal.surname'],
  ['passport.givenname', 'passport.personal.givenname'],
  ['passport.issue', 'passport.personal.issue'],
  ['passport.expiry', 'passport.personal.expiry'],
]);

/**
 * 옛 이름을 새 이름으로 옮긴다. 볼트를 열 때 자동으로 하지 않는다 — 운영자가 부를 때 한 번,
 * 기존 파일을 백업한 뒤에 쓴다. 옮길 것이 없으면 아무것도 하지 않는다.
 */
export function migrateKeyNames(
  path: string,
  passphrase: string,
  cipher: Cipher = dpapi,
): { readonly backup: string; readonly moved: ReadonlyArray<{ from: string; to: string }> } {
  const entries = readVaultFile(path, passphrase, cipher);
  // 새 이름이 이미 있으면 덮어쓰지 않는다 — 옛 이름은 그대로 두고 moved에서 뺀다
  const movable = [...KEY_RENAMES]
    .filter(([from, to]) => entries.has(from) && !entries.has(to))
    .map(([from, to]) => ({ from, to }));
  if (movable.length === 0) return { backup: '', moved: [] };

  // 쓰기 전에 원본을 복사해 둔다 — 이름을 잘못 옮겨도 되돌릴 수 있어야 한다
  const backup = `${path}.bak-${backupStamp(new Date())}`;
  copyFileSync(path, backup);

  for (const { from, to } of movable) {
    entries.set(to, entries.get(from)!);
    entries.delete(from);
  }
  writeVaultFile(path, passphrase, entries, cipher);
  return { backup, moved: movable };
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
      return [...ensureUnlocked()].map(([name, e]) => ({ name, type: e.type, len: e.value.length, grant: e.grant, label: e.label }));
    },
    applyWrite(next: ReadonlyMap<string, VaultEntry>) {
      // 잠긴 금고를 쓰기 부수효과로 열지 않는다 — TTL도 패스프레이즈도 건드리지 않는다
      if (this.locked) return;
      entries = new Map(next);
    },
    get(key: string) {
      return ensureUnlocked().get(key);
    },
    live() {
      return ensureUnlocked();
    },
  };
}
