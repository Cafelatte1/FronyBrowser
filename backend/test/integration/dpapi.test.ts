/**
 * 실제 Windows DPAPI 왕복. win32에서만 돈다 (PowerShell 자식 프로세스라 느리다).
 */

import { describe, expect, it } from 'vitest';
import { dpapi } from '@wallet/core';
const { protect, unprotect } = dpapi;

const isWin = process.platform === 'win32';

describe.skipIf(!isWin)('dpapi (win32)', () => {
  const entropy = Buffer.from('test-entropy-32-bytes-aaaaaaaaaa');

  it('protect → unprotect 왕복', () => {
    const plain = Buffer.from('금고 값 roundtrip ✓', 'utf8');
    const blob = protect(plain, entropy);
    expect(blob.equals(plain)).toBe(false);
    expect(unprotect(blob, entropy).toString('utf8')).toBe('금고 값 roundtrip ✓');
  }, 30_000);

  it('entropy가 다르면 복호화 실패', () => {
    const blob = protect(Buffer.from('secret'), entropy);
    expect(() => unprotect(blob, Buffer.from('different-entropy'))).toThrow();
  }, 30_000);
});
