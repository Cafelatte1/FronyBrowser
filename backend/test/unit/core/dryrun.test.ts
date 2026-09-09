/** dry-run 토글의 영속 (FWL-035) — 재시작을 넘겨야 UI에서 켠 상태가 유지된다 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDryRun, readDryRunFlag } from '@wallet/core';

const dir = mkdtempSync(join(tmpdir(), 'wallet-dry-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('dry-run 토글', () => {
  it('파일이 없으면 꺼짐, set(true)는 파일로 남아 새 인스턴스가 읽는다', () => {
    const file = join(dir, 'a', 'dry-run.json');
    const d = createDryRun(file);
    expect(d.get()).toBe(false);
    d.set(true);
    expect(d.get()).toBe(true);
    expect(createDryRun(file).get()).toBe(true);
    d.set(false);
    expect(createDryRun(file).get()).toBe(false);
  });

  it('깨진 파일은 꺼진 것으로 본다 — dry-run은 예외 모드다', () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(readDryRunFlag(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ dryRun: 'yes' }), 'utf8');
    expect(readDryRunFlag(file)).toBe(false);
  });
});
