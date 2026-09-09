import { describe, expect, it } from 'vitest';
import { ERROR_CODES, fail, failFromUnknown, formatRef, parseRef } from '@wallet/core';

describe('ref (8.1)', () => {
  it('세대와 인덱스를 왕복한다', () => {
    expect(parseRef(formatRef(7, 42))).toEqual({ gen: 7, index: 42 });
  });

  it('형식이 아니면 거부한다 — 셀렉터를 ref 자리에 넣을 수 없다', () => {
    for (const bad of ['e42', '7:42', 'input[name=card]', '', '7:e']) {
      expect(parseRef(bad)).toBeNull();
    }
  });
});

describe('에러 모델 (8.3)', () => {
  it('retriable을 코드 표에서 가져온다', () => {
    expect(fail('stale_ref', 'x').error.retriable).toBe(true);
    expect(fail('vault_locked', 'x').error.retriable).toBe(false);
  });

  it('예외 원문을 메시지에 싣지 않는다 (규칙 5)', () => {
    const leaked = new Error('fill failed: value "4111111111111111" rejected');
    const f = failFromUnknown('timeout', leaked);
    expect(f.error.message).not.toContain('4111111111111111');
  });

  it('모든 코드에 retriable이 정의돼 있다', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(typeof spec.retriable, code).toBe('boolean');
    }
  });
});
