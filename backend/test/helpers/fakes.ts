/**
 * 테스트 공용 가짜들. 브라우저·DPAPI·네트워크 없이 handlers/egress/http 계층을 돌린다.
 *
 * 값을 흘리는 경로가 없는지 검증하는 테스트가 대부분이라, 가짜도 실제 계약(Vault·ActionTarget)을
 * 그대로 구현한다 — 인터페이스가 바뀌면 여기서 먼저 컴파일이 깨져야 한다.
 */

import { createHmac } from 'node:crypto';
import type { ActionTarget, Cipher, ErrorCode, Intent, PayGrantPayload, SafeSnapshot, Vault, VaultEntry } from '@wallet/core';
import { VaultLockedError } from '@wallet/core';
import { TargetError } from '@wallet/app';

/** entropy(패스프레이즈 해시)를 헤더로 박아 불일치 시 실패하는 가짜 cipher — 실DPAPI 없이 패스프레이즈 검사를 흉내낸다 */
export const fakeCipher: Cipher = {
  protect: (plain, entropy) => Buffer.concat([entropy.subarray(0, 8), plain]),
  unprotect: (blob, entropy) => {
    if (!blob.subarray(0, 8).equals(entropy.subarray(0, 8))) throw new Error('bad entropy');
    return blob.subarray(8);
  },
};

export type FakeVaultOptions = {
  readonly entries?: Record<string, VaultEntry>;
  readonly locked?: boolean;
  /** unlock 상태에서 currentPassphrase()가 돌려줄 값. 기본 null (storageState 주입 없음) */
  readonly passphrase?: string | null;
};

export function fakeVault(opts: FakeVaultOptions = {}): Vault {
  const entries = opts.entries ?? {};
  const locked = opts.locked ?? false;
  return {
    locked,
    unlock: async () => {},
    lock: () => {},
    list: () => Object.entries(entries).map(([name, e]) => ({ name, type: e.type })),
    get: (key) => {
      if (locked) throw new VaultLockedError();
      return entries[key];
    },
    live: () => new Map(Object.entries(entries)),
    currentPassphrase: () => (locked ? null : (opts.passphrase ?? null)),
    remainingMs: () => (locked ? 0 : 60_000),
  };
}

export type FakeTargetOptions = {
  /** 브라우저가 "있는" 페이지 URL */
  readonly url?: string;
  /** 대상 요소가 속한 프레임의 origin (규칙 4) — 기본은 url의 origin */
  readonly frameOrigin?: string;
  /** 스냅샷 트리 본문. 값이 되비치는 최악 케이스를 여기 넣어 egress를 시험한다 */
  readonly tree?: string;
  /** extract()가 돌려줄 금액 텍스트. null이면 추출 실패 */
  readonly amountText?: string | null;
  /** matches()가 돌려줄 값 — require_selector 검사 결과. 기본 true */
  readonly matches?: boolean;
  /** open()이 돌려줄 storedLogin. 기본 false (저장 로그인 없음) */
  readonly storedLogin?: boolean;
  /** open()이 돌려줄 storedLogin. 기본 false (저장 로그인 없음) */
  readonly storedLogin?: boolean;
  /** open()이 돌려줄 storedLogin. 기본 false (저장 로그인 없음) */
  readonly storedLogin?: boolean;
  /** open()이 던질 예외. 세션 누수·에러 매핑 검증용 */
  readonly openError?: unknown;
};

export type FakeTarget = {
  readonly target: ActionTarget;
  /** fill로 브라우저에 들어간 실제 값 — 여기엔 값이 있어야 정상이다 */
  readonly filled: Array<{ ref: string; value: string }>;
  /** navigate로 방문한 URL */
  readonly visited: string[];
  /** open()에 넘어온 origin·프로필 */
  readonly opened: unknown[];
  /** close()된 세션 id */
  readonly closed: string[];
  /** close() 호출별 세션 id와 persist 여부 (FWL-026) */
  readonly closeCalls: Array<{ id: string; persist: boolean }>;
  /** act()로 들어온 intent 전부 (순서대로) */
  readonly intents: Intent[];
  /** 다음 act()·snapshot() 한 번만 이 코드로 실패시킨다 — 실패 경로 감사 검증용 (FWL-030) */
  failNext(code: ErrorCode): void;
};

export function fakeTarget(opts: FakeTargetOptions = {}): FakeTarget {
  const url = opts.url ?? 'https://shop.com/checkout';
  const frameOrigin = opts.frameOrigin ?? new URL(url).origin;
  const filled: FakeTarget['filled'] = [];
  const visited: string[] = [];
  const opened: unknown[] = [];
  const closed: string[] = [];
  const closeCalls: FakeTarget['closeCalls'] = [];
  const intents: Intent[] = [];
  let nextFailure: ErrorCode | null = null;
  function takeFailure(): void {
    if (nextFailure === null) return;
    const code = nextFailure;
    nextFailure = null;
    throw new TargetError(code); // 실제 어댑터와 같은 예외 — toFailure가 코드를 그대로 넘긴다
  }
  const target: ActionTarget = {
    name: 'fake',
    open: async (_sid, o) => {
      if (opts.openError !== undefined) throw opts.openError;
      opened.push(o);
      return { storedLogin: opts.storedLogin === true };
    },
    close: async (sid, closeOpts) => {
      closed.push(String(sid));
      closeCalls.push({ id: String(sid), persist: closeOpts?.persist === true });
    },
    originOf: async () => frameOrigin,
    snapshot: async () => {
      takeFailure();
      return { gen: 1, pages: 1, url, tree: opts.tree ?? '- textbox "휴대폰" [ref=1:e1]' } as SafeSnapshot;
    },
    extract: async () => opts.amountText ?? null,
    matches: async () => opts.matches ?? true,
    status: async () => ({ url, pages: [{ index: 0, url, current: true }], snapshotGen: 1 }),
    switchPage: async (_sid, index: number) => {
      takeFailure();
      if (index !== 0) throw new TargetError('stale_ref');
    },
    act: async (_sid, intent: Intent) => {
      takeFailure();
      intents.push(intent);
      if (intent.kind === 'fill') filled.push({ ref: String(intent.ref), value: intent.value });
      if (intent.kind === 'navigate') visited.push(intent.url);
      // navigate엔 요소가 없다 — 나머지는 지목한 요소의 role을 돌려준다
      return intent.kind === 'navigate' ? { url } : { url, role: 'button' };
    },
  };
  return {
    target,
    filled,
    visited,
    opened,
    closed,
    closeCalls,
    intents,
    failNext: (code) => {
      nextFailure = code;
    },
  };
}

// ── pay grant 서명 — 테스트 전용. 실제 발급자는 FronyShopping의 `begin_checkout`이다.
// wallet은 검증만 하므로 프로덕션 core에는 서명 코드를 두지 않는다 (계약: docs/pay-grant.md).

export function signPayGrant(payload: PayGrantPayload, key: string): string {
  const payloadSeg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigSeg = createHmac('sha256', key).update(payloadSeg, 'ascii').digest('base64url');
  return `pg1.${payloadSeg}.${sigSeg}`;
}

/** 지금 시각 기준으로 유효한(iat=now, exp=now+300) grant 하나 */
export function freshGrant(
  key: string,
  over: Partial<PayGrantPayload> & { session_id: string },
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  return signPayGrant({ v: 1, txn_id: 'txn-1', max_total: 20000, iat, exp: iat + 300, ...over }, key);
}
