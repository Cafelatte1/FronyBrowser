import { describe, expect, it } from 'vitest';
import { findKeys } from '@wallet/core';

describe('플레이스홀더 (contract)', () => {
  it('키 이름을 뽑는다', () => {
    expect(findKeys('{{vault:card.personal.number}}')).toEqual(['card.personal.number']);
  });

  it('여러 개를 모두 찾는다', () => {
    expect(findKeys('{{vault:name}} / {{vault:phone}}')).toEqual(['name', 'phone']);
  });

  it('플레이스홀더가 없으면 빈 배열', () => {
    expect(findKeys('홍길동')).toEqual([]);
  });
});

// ── resolve (FWL-005) ─────────────────────────────────────────

import { KeyNotFoundError, VaultLockedError, resolve } from '@wallet/core';
import { fakeVault } from '../../helpers/fakes.js';


describe('resolve', () => {
  const vault = fakeVault({ entries: {
    phone: { type: 'phone', value: '01012345678', grant: false },
    name: { type: 'name', value: '홍길동', grant: false },
  } });

  it('플레이스홀더를 실제 값으로 치환하고 쓰인 키를 보고한다', () => {
    const r = resolve('{{vault:name}} / {{vault:phone}}', vault);
    expect(r.value).toBe('홍길동 / 01012345678');
    expect(r.keys).toEqual(['name', 'phone']);
  });

  it('플레이스홀더가 없으면 원문 그대로, keys는 빈 배열', () => {
    expect(resolve('그냥 텍스트', vault)).toEqual({ value: '그냥 텍스트', keys: [] });
  });

  it('없는 키는 KeyNotFoundError — message에 키 이름을 싣지 않는다', () => {
    try {
      resolve('{{vault:nope}}', vault);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KeyNotFoundError);
      expect((e as Error).message).toBe('key_not_found');
      expect((e as KeyNotFoundError).key).toBe('nope');
    }
  });

  it('잠긴 금고는 VaultLockedError 전파', () => {
    expect(() => resolve('{{vault:phone}}', fakeVault({ entries: {}, locked: true }))).toThrow(VaultLockedError);
  });
});
