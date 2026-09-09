/**
 * `{{vault:key}}` → 실제 값. 순수 함수라 core에 둔다.
 *
 * 이 함수의 반환값은 절대 호출자에게 나가지 않는다. app으로만 전달된다.
 */

import type { Vault } from './vault.js';

const PLACEHOLDER = /\{\{vault:([a-zA-Z0-9._-]+)\}\}/g;

export type Resolved = {
  readonly value: string;
  /** 치환에 쓰인 키. 감사 로그와 정책 검사 대상이다 */
  readonly keys: ReadonlyArray<string>;
};

export function findKeys(template: string): ReadonlyArray<string> {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

export class KeyNotFoundError extends Error {
  constructor(readonly key: string) {
    super('key_not_found'); // 키 이름은 message에 싣지 않는다 — 에러 응답에 그대로 나갈 수 있다
  }
}

/** 잠긴 금고는 VaultLockedError, 없는 키는 KeyNotFoundError를 던진다 */
export function resolve(template: string, vault: Vault): Resolved {
  const keys: string[] = [];
  const value = template.replace(PLACEHOLDER, (_m, key: string) => {
    const entry = vault.get(key);
    if (!entry) throw new KeyNotFoundError(key);
    keys.push(key);
    return entry.value;
  });
  return { value, keys };
}
