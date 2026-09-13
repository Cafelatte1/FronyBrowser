/** Test Mode 토글의 영속 (FWL-035/056) — 재시작을 넘겨야 UI에서 켠 상태가 유지된다 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestMode, readTestModeFlag } from '@wallet/core';

const dir = mkdtempSync(join(tmpdir(), 'wallet-testmode-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Test Mode 토글', () => {
  it('파일이 없으면 꺼짐, set(true)는 파일로 남아 새 인스턴스가 읽는다', () => {
    const file = join(dir, 'a', 'test-mode.json');
    const t = createTestMode(file);
    expect(t.get()).toBe(false);
    t.set(true);
    expect(t.get()).toBe(true);
    expect(createTestMode(file).get()).toBe(true);
    t.set(false);
    expect(createTestMode(file).get()).toBe(false);
  });

  it('보류 키도 같은 파일에 남는다 — on과 독립적으로 바뀐다', () => {
    const file = join(dir, 'held', 'test-mode.json');
    const t = createTestMode(file);
    expect(t.held()).toEqual([]);
    t.setHeld(['shop.payment.pinnumber']);
    t.set(true);
    const reopened = createTestMode(file);
    expect(reopened.get()).toBe(true);
    expect(reopened.held()).toEqual(['shop.payment.pinnumber']);
  });

  it('깨진 파일은 꺼진 것으로 본다 — Test Mode는 예외 모드다', () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(readTestModeFlag(file)).toEqual({ on: false, held: [] });
    writeFileSync(file, JSON.stringify({ on: 'yes' }), 'utf8');
    expect(readTestModeFlag(file)).toEqual({ on: false, held: [] });
  });

  it('새 파일이 없을 때만 이웃한 옛 dry-run.json을 읽는다 — 업그레이드에서 켜둔 상태를 잃지 않는다', () => {
    const legacyDir = join(dir, 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    const file = join(legacyDir, 'test-mode.json');
    writeFileSync(join(legacyDir, 'dry-run.json'), JSON.stringify({ dryRun: true }), 'utf8');

    expect(readTestModeFlag(file)).toEqual({ on: true, held: [] });
    const t = createTestMode(file);
    expect(t.get()).toBe(true);

    // 한 번 새 파일이 생기면 옛 파일은 더 보지 않는다. 옛 파일 자체는 지우지 않는다
    t.set(false);
    expect(existsSync(join(legacyDir, 'dry-run.json'))).toBe(true);
    expect(readTestModeFlag(file)).toEqual({ on: false, held: [] });
  });
});
