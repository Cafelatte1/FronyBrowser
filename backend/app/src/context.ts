/**
 * 브라우저 수명주기 (8.5).
 *
 * Browser 인스턴스는 (엔진, 모드) 조합당 하나, BrowserContext는 세션당 하나다.
 * 마지막 컨텍스트가 닫히고 idleMs 동안 새 컨텍스트가 없으면 Browser를 닫는다 (FWL-036) —
 * 다음 open이 다시 띄운다. 헤드풀 Chrome 창도 같은 규칙이다
 *
 * trace / video / HAR을 절대 켜지 않는다 (규칙 6) — 컨텍스트를 지키고
 * 디스크로 새는 최악의 경우다. newContext 옵션에 recordVideo/recordHar를
 * 추가하는 변경은 리뷰에서 반드시 걸러야 한다.
 */

import type { BrowserLaunchProfile, SessionId } from '@wallet/core';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'patchright';
import { chromium } from 'patchright';

export type StorageState = BrowserContextOptions['storageState'];

export type SessionBrowser = {
  readonly context: BrowserContext;
  readonly page: Page;
};

export interface BrowserPool {
  /** profile을 못 띄우면 BrowserUnavailableError */
  open(sessionId: SessionId, storageState?: StorageState, profile?: BrowserLaunchProfile): Promise<SessionBrowser>;
  get(sessionId: SessionId): SessionBrowser | undefined;
  close(sessionId: SessionId): Promise<void>;
  /** 살아 있는 Browser 인스턴스 수 — idle 종료 확인용 */
  browserCount(): number;
  shutdown(): Promise<void>;
}

export type BrowserPoolOptions = {
  /** 마지막 컨텍스트가 닫힌 뒤 Browser를 유지하는 시간. 기본 5분 */
  readonly idleMs?: number;
};

/**
 * 한국 Windows 데스크톱 일반 사용자 프로필. 봇탐지는 UA·언어·시간대·해상도의
 * 불일치를 본다 — 전부 같은 그림(한국 사무실 PC)으로 맞춘다.
 * trace/video/HAR·geolocation은 넣지 않는다 (규칙 6, 권한 프롬프트 회피).
 */
const KR_DESKTOP_PROFILE = {
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: 'light' as const,
  extraHTTPHeaders: { 'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
};

export class BrowserUnavailableError extends Error {
  constructor(readonly profile: BrowserLaunchProfile) {
    super(`browser profile unavailable: ${profileKey(profile)}`);
  }
}

const DEFAULT_PROFILE: BrowserLaunchProfile = { kind: 'browser', browser: 'chromium', headless: true };
const profileKey = (p: BrowserLaunchProfile): string => `${p.browser}:${p.headless ? 'headless' : 'headful'}`;

export function createBrowserPool(opts: BrowserPoolOptions = {}): BrowserPool {
  const idleMs = opts.idleMs ?? 5 * 60_000;
  /** (엔진, 모드) 조합별 Browser 하나씩 — 세션 컨텍스트는 그 위에 격리된다 */
  const browsers = new Map<string, Browser>();
  const sessions = new Map<string, SessionBrowser & { readonly key: string }>();
  /** 컨텍스트가 하나도 없는 Browser의 종료 예약 */
  const idleTimers = new Map<string, NodeJS.Timeout>();

  function cancelIdle(key: string): void {
    const t = idleTimers.get(key);
    if (t) clearTimeout(t);
    idleTimers.delete(key);
  }

  function scheduleIdle(key: string): void {
    cancelIdle(key);
    const t = setTimeout(() => {
      idleTimers.delete(key);
      for (const s of sessions.values()) if (s.key === key) return; // 그 사이 새 컨텍스트가 열렸다
      const b = browsers.get(key);
      browsers.delete(key);
      void b?.close().catch(() => {});
    }, idleMs);
    t.unref();
    idleTimers.set(key, t);
  }

  async function ensureBrowser(profile: BrowserLaunchProfile): Promise<Browser> {
    const key = profileKey(profile);
    cancelIdle(key);
    const existing = browsers.get(key);
    if (existing?.isConnected()) return existing;
    try {
      // 기본 headless shell은 UA에 HeadlessChrome이 박혀 봇 매니저가 있는 사이트가 Access Denied를 낸다.
      // 새 headless(channel chromium) + Headless 표기를 뗀 UA면 홈은 통과한다 (2026-09 실측).
      // chrome 채널은 시스템 Chrome — 없으면 launch가 던지고 browser_unavailable로 끝난다
      // headful은 interactive 로그온이 있어야 뜬다 — S4U 태스크에서는 launch가 던진다
      // navigator.webdriver: --enable-automation을 빼는 것만으로는 headful 실제 Chrome에서도 true다 (2026-09-04 실측).
      // AutomationControlled를 끄면 headful·headless 모두 false — 봇 매니저가 로그인 페이지에서 가장 먼저 보는 값
      const b = await chromium.launch({
        headless: profile.headless,
        channel: profile.browser,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
      });
      browsers.set(key, b);
      return b;
    } catch {
      throw new BrowserUnavailableError(profile);
    }
  }

  /** 실제 브라우저 버전에 맞춘 UA — 버전만 따고 Headless 표기는 뺀다 */
  function userAgentFor(b: Browser): string {
    const major = b.version().split('.')[0] ?? '120';
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  return {
    async open(sessionId, storageState, profile = DEFAULT_PROFILE) {
      if (sessions.has(sessionId)) throw new Error('session already open');
      const b = await ensureBrowser(profile);
      // 실제 Chrome(chrome 채널)은 에뮬레이션을 걸지 않는다 — UA 덮어쓰기는 Client Hints(sec-ch-ua)와 어긋나고
      // viewport 강제는 CDP Emulation 흔적을 남겨 봇 매니저가 잡는다 (2026-09-04 실측). KR 프로필은 chromium headless용
      const emulation = profile.browser === 'chrome' ? { viewport: null } : { ...KR_DESKTOP_PROFILE, userAgent: userAgentFor(b) };
      const context = await b.newContext({
        ...emulation,
        ...(storageState !== undefined ? { storageState } : {}),
      });
      const page = await context.newPage();
      const sb = { context, page, key: profileKey(profile) };
      sessions.set(sessionId, sb);
      return sb;
    },
    get(sessionId) {
      return sessions.get(sessionId);
    },
    async close(sessionId) {
      const sb = sessions.get(sessionId);
      if (!sb) return;
      sessions.delete(sessionId);
      await sb.context.close().catch(() => {});
      for (const s of sessions.values()) if (s.key === sb.key) return;
      scheduleIdle(sb.key); // 이 Browser의 마지막 컨텍스트였다
    },
    browserCount() {
      return browsers.size;
    },
    async shutdown() {
      for (const key of [...idleTimers.keys()]) cancelIdle(key);
      for (const id of [...sessions.keys()]) await this.close(id as SessionId);
      for (const key of [...idleTimers.keys()]) cancelIdle(key);
      for (const b of browsers.values()) await b.close().catch(() => {});
      browsers.clear();
    },
  };
}
