/** 규칙 10 — 바인딩 화이트리스트. 거부 목록이면 `0`·`::0` 같은 표기가 전체 인터페이스로 샌다 */

import { describe, expect, it } from 'vitest';
import { assertBindable } from '@wallet/api';

describe('assertBindable', () => {
  it('Tailscale(100.64/10)·루프백만 허용', () => {
    for (const ok of ['127.0.0.1', '::1', '100.108.1.2', '100.64.0.1', '100.127.255.254']) {
      expect(() => assertBindable(ok), ok).not.toThrow();
    }
  });
  it('전체 인터페이스로 풀리는 표기와 그 밖의 주소는 거부', () => {
    for (const bad of ['0.0.0.0', '::', '', '0', '::0', '192.168.0.10', '100.63.0.1', '100.128.0.1', 'localhost']) {
      expect(() => assertBindable(bad), bad).toThrow(/rule 10/);
    }
  });
});
