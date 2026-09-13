/** origin별 기동 조합 기억의 영속 (FWL-065) — 재시작을 넘겨야 다음 세션이 같은 조합으로 뜬다 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BrowserLaunchProfile } from '@wallet/core';
import { createOriginProfiles, profileLabel, sameProfile } from '@wallet/core';

const dir = mkdtempSync(join(tmpdir(), 'wallet-originprofile-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHROME_HEADFUL: BrowserLaunchProfile = { kind: 'browser', browser: 'chrome', headless: false };
const CHROMIUM_HEADLESS: BrowserLaunchProfile = { kind: 'browser', browser: 'chromium', headless: true };

describe('origin별 기동 조합 기억', () => {
  it('기억은 파일로 남아 새 인스턴스가 읽는다', () => {
    const file = join(dir, 'a', 'origins.json');
    const p = createOriginProfiles(file);
    expect(p.get('https://shop.com')).toBeUndefined();
    p.remember('https://shop.com', CHROME_HEADFUL);
    expect(createOriginProfiles(file).get('https://shop.com')).toMatchObject({ browser: 'chrome', headless: false });
  });

  it('forget은 그 origin만 지운다 — 다른 origin의 기억은 남는다', () => {
    const file = join(dir, 'b', 'origins.json');
    const p = createOriginProfiles(file);
    p.remember('https://shop.com', CHROME_HEADFUL);
    p.remember('https://other.com', CHROMIUM_HEADLESS);
    p.forget('https://shop.com');
    const reopened = createOriginProfiles(file);
    expect(reopened.get('https://shop.com')).toBeUndefined();
    expect(reopened.get('https://other.com')).toMatchObject({ browser: 'chromium', headless: true });
  });

  it('깨진 파일과 모르는 조합은 기억 없음으로 읽는다 — 기억이 없으면 호출자를 그대로 믿으므로 안전한 기본값이다', () => {
    const broken = join(dir, 'c', 'origins.json');
    createOriginProfiles(broken).remember('https://shop.com', CHROME_HEADFUL);
    writeFileSync(broken, '{ this is not json', 'utf8');
    expect(createOriginProfiles(broken).get('https://shop.com')).toBeUndefined();

    const bogus = join(dir, 'd', 'origins.json');
    createOriginProfiles(bogus).remember('https://shop.com', CHROME_HEADFUL);
    writeFileSync(bogus, JSON.stringify({ 'https://shop.com': { browser: 'firefox', headless: false } }), 'utf8');
    expect(createOriginProfiles(bogus).get('https://shop.com')).toBeUndefined();
  });

  it('같은 조합을 다시 기억해도 파일을 다시 쓰지 않는다 — at만 바뀌는 쓰기는 의미가 없다', () => {
    const file = join(dir, 'e', 'origins.json');
    const p = createOriginProfiles(file);
    p.remember('https://shop.com', CHROME_HEADFUL);
    const first = readFileSync(file, 'utf8');
    p.remember('https://shop.com', CHROME_HEADFUL);
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('sameProfile은 엔진과 모드 둘 다 봐야 같다고 한다', () => {
    const p = createOriginProfiles(join(dir, 'f', 'origins.json'));
    p.remember('https://shop.com', CHROME_HEADFUL);
    const got = p.get('https://shop.com');
    if (!got) throw new Error('remembered');
    expect(sameProfile(got, CHROME_HEADFUL)).toBe(true);
    expect(sameProfile(got, { kind: 'browser', browser: 'chrome', headless: true })).toBe(false);
    expect(sameProfile(got, CHROMIUM_HEADLESS)).toBe(false);
    expect(profileLabel(got)).toBe('chrome/headful');
    expect(profileLabel(CHROMIUM_HEADLESS)).toBe('chromium/headless');
  });
});
