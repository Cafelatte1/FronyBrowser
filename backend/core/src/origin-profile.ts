/**
 * origin별 "로그인까지 간 기동 조합" 기억 (FWL-065).
 *
 * 어느 사이트를 어떤 브라우저·모드로 열어야 하는지는 호출자의 지식이다 (FWL-055). 문제는 호출자가
 * 틀려도 서버가 모른다는 것이다 — 봇 매니저의 차단은 HTTP 200에 정상 DOM으로 도착하고, 그 내용은
 * 감사 로그에 남지 않는다 (규칙 5). 실제로 감사 로그 실측(2026-09-13)에서 차단당한 헤드리스 세션 3건이
 * 전부 `session_end: normal`로 끝나 있었다. 그래서 "세션이 돌았다"로는 배울 수 없다.
 *
 * 배울 수 있는 신호는 `session_end(loggedIn=true)` 하나뿐이다. 로그인까지 갔다면 차단당하지 않았다는
 * 뜻이고, 이건 FWL-026이 저장 쿠키를 덮어쓸 때 이미 믿고 있는 바로 그 단언이다 — 새로운 신뢰 가정을
 * 만들지 않는다. 실측에서도 쿠팡은 chrome/headful만 9번 여기 도달했고 헤드리스는 3번 중 0번이었다.
 *
 * 에이전트의 단언이라 틀릴 수 있으므로 자가 치유 장치를 하나 둔다: 기억된 조합이 아예 뜨지 못하면
 * (`browser_unavailable`) 호출부가 forget을 부른다. 그 밖의 정정은 운영자가 이 파일을 지우는 일이다.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserLaunchProfile, BrowserProfile } from './types.js';

/** 기억 한 줄. at은 운영자가 파일을 열어 볼 때를 위한 것이고 판정에는 쓰지 않는다 */
export type RememberedProfile = {
  readonly browser: BrowserProfile;
  readonly headless: boolean;
  readonly at: string;
};

export interface OriginProfiles {
  get(origin: string): RememberedProfile | undefined;
  remember(origin: string, profile: BrowserLaunchProfile): void;
  forget(origin: string): void;
}

export function sameProfile(a: RememberedProfile, b: BrowserLaunchProfile): boolean {
  return a.browser === b.browser && a.headless === b.headless;
}

/** `chrome/headful` — 에러 메시지와 감사에 쓰는 표기. 값이 아니라 설정이므로 밖으로 나가도 된다 */
export function profileLabel(p: RememberedProfile | BrowserLaunchProfile): string {
  return `${p.browser}/${p.headless ? 'headless' : 'headful'}`;
}

export function createOriginProfiles(file: string): OriginProfiles {
  const state = read(file);
  function persist(): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(state), null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  }
  return {
    get: (origin) => state.get(origin),
    remember(origin, profile) {
      const next: RememberedProfile = { browser: profile.browser, headless: profile.headless, at: new Date().toISOString() };
      const prev = state.get(origin);
      if (prev && sameProfile(prev, profile)) return; // 같은 조합의 재확인 — at만 바꾸자고 쓰지 않는다
      state.set(origin, next);
      persist();
    },
    forget(origin) {
      if (!state.delete(origin)) return;
      persist();
    },
  };
}

/** 파일이 없거나 깨졌으면 기억이 없는 것으로 본다 — 기억 없음이 곧 "호출자를 그대로 믿는다"라 안전한 기본값이다 */
function read(file: string): Map<string, RememberedProfile> {
  const out = new Map<string, RememberedProfile>();
  if (!existsSync(file)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [origin, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const { browser, headless, at } = raw as Record<string, unknown>;
    if ((browser !== 'chromium' && browser !== 'chrome') || typeof headless !== 'boolean') continue;
    out.set(origin, { browser, headless, at: typeof at === 'string' ? at : '' });
  }
  return out;
}

/** 테스트용 — 디스크 없이 */
export function createMemoryOriginProfiles(initial: Record<string, RememberedProfile> = {}): OriginProfiles {
  const state = new Map(Object.entries(initial));
  return {
    get: (origin) => state.get(origin),
    remember: (origin, profile) => {
      state.set(origin, { browser: profile.browser, headless: profile.headless, at: new Date().toISOString() });
    },
    forget: (origin) => {
      state.delete(origin);
    },
  };
}
