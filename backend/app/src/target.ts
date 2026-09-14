/**
 * `ActionTarget`의 Playwright 구현. app이 존재하는 이유다.
 *
 * 에러는 코드로만 던진다 — Playwright 예외 메시지에는 입력값이 포함될 수
 * 있으므로 그대로 밖에 내보내지 않는다 (규칙 5).
 */

import type { ActionResult, ActionTarget, ErrorCode, Intent, PageImage, Ref, SafeSnapshot, SessionId } from '@wallet/core';
import { KeypadUnresolvedError, fitPng, resolveKeypadSprite, isBrowserProfile } from '@wallet/core';
import type { ElementHandle, Page } from 'patchright';
import { BrowserUnavailableError } from './context.js';
import type { BrowserPool, LaunchFailure, SessionBrowser, StorageState } from './context.js';
import { originOfHandle } from './frames.js';
import type { RefEntry, RefTable } from './refs.js';
import { createRefTable } from './refs.js';
import { buildSnapshot, FIELD_SELECTOR } from './snapshot.js';

export class TargetError extends Error {
  /** reason은 분류값이지 메시지가 아니다 (FWL-063) — 예외 메시지는 어디에도 싣지 않는다 (규칙 5) */
  constructor(readonly code: ErrorCode, readonly reason?: LaunchFailure) {
    super(code); // 원인 예외를 message에 싣지 않는다
  }
}

/** 마스크 박스 색 (FWL-062). 페이지에 자연스럽게 있을 수 없는 색이라, 가려진 자리가 사진에서 한눈에 보인다 */
const MASK_COLOR = '#FF00FF';
/** page_image의 긴 변 상한 (FWL-066). 1024면 페이지의 글자가 다 읽히고 토큰은 절반 이하다 — 근거는 core/image.ts */
const IMAGE_MAX_EDGE = 1024;

/** page: 현재 페이지. 새 탭이 열리면 그것으로 바뀐다 (FWL-043) — 사람이 브라우저를 쓰는 감각과 같다 */
type SessionState = { readonly browser: SessionBrowser; readonly refs: RefTable; readonly origin: string; page: Page; readonly follow: (p: Page) => void };

/** status().pages용 url — origin + 경로까지. 쿼리스트링·해시는 뗀다 (토큰이 실릴 수 있다). http(s)가 아니면 그대로 */
function pageUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname : url;
  } catch {
    return url;
  }
}

/**
 * 페이지 안에서 실행된다 (FWL-038). 버튼(keySelector)마다 셀(cellSelector)의 computed 배경 스프라이트(data URL)와
 * background-position·박스 크기를 읽는다. 스냅샷 스크립트처럼 문자열이다 — app은 DOM 타입을 갖지 않는다.
 * 숫자는 여기서 알 수 없다; 판독은 core가 한다
 */
function collectSpriteCells(keySelector: string, cellSelector: string): string {
  return `(() => {
  const cellSel = ${JSON.stringify(cellSelector)};
  return [...document.querySelectorAll(${JSON.stringify(keySelector)})].map((el) => {
    const cell = el.querySelector(cellSel);
    if (!cell) return null;
    const cs = getComputedStyle(cell);
    const bg = cs.backgroundImage;
    const start = bg.indexOf('data:image/png;base64,');
    if (start < 0) return null;
    const quote = bg.indexOf('"', start);
    const sprite = bg.slice(start, quote < 0 ? bg.indexOf(')', start) : quote);
    const pos = cs.backgroundPosition.split(' ').map((v) => Math.round(-parseFloat(v)));
    const r = cell.getBoundingClientRect();
    return { sprite, x: pos[0] || 0, y: pos[1] || 0, w: Math.round(r.width), h: Math.round(r.height) };
  });
})()`;
}

export type PlaywrightTargetOptions = {
  /** 세션 시작 시 주입할 로그인 상태 (storage.ts가 복호화해 넘긴다). 타겟 origin 것에 로그인 제공자 쿠키가 더해진다 (FWL-070) */
  readonly storageStateFor?: (origin: string) => StorageState | undefined;
  /**
   * 이 origin 자체의 저장 로그인이 있는가 — storedLogin 응답의 근거 (FWL-046). 없으면 "주입된 상태가 있다"로 대신하는데,
   * 주입 상태에 제공자 쿠키만 실릴 수 있으므로(FWL-070) 실제 배선(main.ts)은 반드시 넘긴다 — 아니면 어느 사이트든 true가 된다
   */
  readonly hasStoredLogin?: (origin: string) => boolean;
  /**
   * 세션 종료 직전의 storageState 콜백 — 사이트가 연장해 준 쿠키를 재저장한다.
   * 저장 실패가 세션 종료를 막으면 안 되므로 여기서 던진 예외는 무시된다.
   */
  readonly persistStorageState?: (state: object, origin: string) => void;
  readonly actionTimeoutMs?: number;
};

export function createPlaywrightTarget(pool: BrowserPool, opts: PlaywrightTargetOptions = {}): ActionTarget {
  const sessions = new Map<string, SessionState>();
  const timeout = opts.actionTimeoutMs ?? 10_000;

  function state(sessionId: SessionId): SessionState {
    const s = sessions.get(sessionId);
    if (!s) throw new TargetError('session_not_found');
    return s;
  }

  function entryOf(s: SessionState, ref: Ref | string): RefEntry {
    const found = s.refs.get(ref as string);
    if (!found.ok) throw new TargetError(found.code);
    return found.entry;
  }

  function handleOf(s: SessionState, ref: Ref | string): ElementHandle {
    return entryOf(s, ref).handle as unknown as ElementHandle;
  }

  async function guarded<T>(op: () => Promise<T>, code: ErrorCode): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof TargetError) throw e;
      throw new TargetError(code); // 원본 예외는 버린다 — 메시지에 값이 섞일 수 있다
    }
  }

  return {
    name: 'playwright',

    async open(sessionId, { origin, ...profile }) {
      if (sessions.has(sessionId)) throw new TargetError('session_not_found');
      // 이 어댑터는 브라우저 kind만 띄운다 — 다른 kind의 프로필이 오면 핸들러 라우팅이 어긋난 것이다 (FWL-037)
      if (!isBrowserProfile(profile)) throw new TargetError('browser_unavailable');
      const storageState = opts.storageStateFor?.(origin);
      let browser: SessionBrowser;
      try {
        browser = await pool.open(sessionId, storageState, profile);
      } catch (e) {
        // 원인 분류는 여기서만 실려 나간다 — 응답에는 안 붙고 핸들러가 감사에만 남긴다 (FWL-063)
        if (e instanceof BrowserUnavailableError) throw new TargetError('browser_unavailable', e.reason);
        throw new TargetError('navigation_failed');
      }
      // 새 페이지(새 탭·팝업)가 열리면 현재 페이지를 그것으로 바꾼다. 옛 ref는 옛 페이지 것이라 세대를 올려 stale_ref로 만든다.
      // 이전 페이지는 닫지 않는다 — status().pages 목록으로 드러나고, 광고 팝업이면 switchPage로 돌아온다
      const refs = createRefTable();
      const st: SessionState = {
        browser,
        refs,
        origin,
        page: browser.page,
        follow(p) {
          if (st.page === p) return;
          st.page = p;
          refs.newGeneration();
        },
      };
      sessions.set(sessionId, st);
      const storedLogin = opts.hasStoredLogin ? opts.hasStoredLogin(origin) : storageState !== undefined;
      const follow = st.follow;
      const watchClose = (p: Page): void => {
        p.on('close', () => {
          if (st.page !== p) return;
          const rest = browser.context.pages();
          const last = rest[rest.length - 1];
          if (last) follow(last); // 현재 페이지가 닫히면 남은 것 중 가장 최근 페이지로
        });
      };
      watchClose(browser.page);
      browser.context.on('page', (p) => {
        follow(p);
        watchClose(p);
      });
      return { storedLogin };
    },

    async close(sessionId, closeOpts) {
      const s = sessions.get(sessionId);
      if (!s) return;
      sessions.delete(sessionId);
      s.refs.disposeAll();
      // 재저장은 에이전트가 loggedIn을 단언한 정상 종료에서만 (FWL-026)
      if (closeOpts?.persist === true && opts.persistStorageState) {
        try {
          opts.persistStorageState(await s.browser.context.storageState(), s.origin);
        } catch {
          // 페이지가 이미 죽었거나 저장 실패 — 종료는 계속한다
        }
      }
      await pool.close(sessionId);
    },

    async originOf(sessionId, ref) {
      const s = state(sessionId);
      const handle = handleOf(s, ref);
      return guarded(() => originOfHandle(handle), 'ref_not_found');
    },

    async snapshot(sessionId, opts = {}): Promise<SafeSnapshot> {
      const s = state(sessionId);
      // 슬라이스 루트는 새 세대를 열기 전에 표에서 빼 둔다 — newGeneration이 옛 핸들을 전부 dispose 한다
      let root: { readonly handle: ElementHandle; readonly ref: Ref } | undefined;
      if (opts.ref !== undefined) {
        const found = s.refs.detach(opts.ref as string);
        if (!found.ok) throw new TargetError(found.code);
        root = { handle: found.entry.handle as unknown as ElementHandle, ref: opts.ref };
      }
      // 방금 열린 새 탭이면 DOM이 준비될 때까지 잠깐 기다린다 — about:blank 스냅샷을 주지 않기 위해
      await s.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      const pages = s.browser.context.pages().length;
      try {
        return await guarded(() => buildSnapshot(s.page, s.refs, pages, { ...opts, ...(root ? { root } : {}) }), 'timeout');
      } finally {
        void root?.handle.dispose().catch(() => {});
      }
    },

    /**
     * 현재 화면 한 장 (FWL-062). 프레임마다 locator를 만들어 넘긴다 —
     * `page.locator()`는 최상위 프레임만 훑는데, 카드번호가 사는 곳은 PG사 cross-origin iframe이다 (규칙 4).
     * 한 프레임이라도 빠뜨리면 가장 지켜야 할 필드만 정확히 드러난 사진이 나온다.
     * 찍은 뒤 긴 변 1024로 줄여서 내보낸다 (FWL-066) — 마스크는 셔터 전에 브라우저가 그리므로 축소와 무관하다.
     */
    async image(sessionId): Promise<PageImage> {
      const s = state(sessionId);
      // 방금 열린 새 탭이면 DOM이 준비될 때까지 기다린다 — snapshot과 같은 이유다. 없으면 about:blank를 찍는다
      await s.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      const mask = s.page.frames().map((f) => f.locator(FIELD_SELECTOR));
      let masked = 0;
      for (const m of mask) masked += await m.count().catch(() => 0);
      const shot = await guarded(() => s.page.screenshot({ mask, maskColor: MASK_COLOR, type: 'png' }), 'timeout');
      // 크기는 PNG에서 직접 읽는다 — 축소 뒤의 실제 픽셀 수와 응답이 어긋나지 않는 유일한 방법이다 (FWL-066)
      const { png, width, height } = fitPng(shot, IMAGE_MAX_EDGE);
      return { png, width, height, masked };
    },

    async extract(sessionId, selector) {
      const s = state(sessionId);
      // 모든 프레임을 훑어 처음 매치되는 요소의 표시 텍스트를 돌려준다.
      for (const frame of s.page.frames()) {
        try {
          const el = frame.locator(selector).first();
          if ((await el.count()) > 0) {
            return (await el.innerText({ timeout: 2_000 })).trim();
          }
        } catch {
          // 이 프레임에 없음 — 다음 프레임
        }
      }
      return null;
    },

    async status(sessionId) {
      const s = state(sessionId);
      return {
        url: s.page.url(),
        pages: s.browser.context.pages().map((p, index) => ({ index, url: pageUrl(p.url()), current: p === s.page })),
        snapshotGen: s.refs.gen,
      };
    },

    async switchPage(sessionId, index) {
      const s = state(sessionId);
      const p = s.browser.context.pages()[index];
      if (!p || p.isClosed()) throw new TargetError('stale_ref'); // 목록이 바뀌었다 — status를 다시 읽으면 된다
      s.follow(p);
    },

    async act(sessionId, intent): Promise<ActionResult> {
      const s = state(sessionId);
      const page = s.page;
      // 요소를 지목하는 동작은 그 요소의 role을 돌려준다 — 감사 로그로 세션을 재구성하기 위해서다 (FWL-030)
      let role: string | undefined;

      switch (intent.kind) {
        case 'navigate':
          await guarded(async () => {
            await page.goto(intent.url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
          }, 'navigation_failed');
          break;
        case 'fill': {
          const entry = entryOf(s, intent.ref);
          role = entry.role;
          await guarded(
            () => (entry.handle as unknown as ElementHandle).fill(intent.value, { timeout }),
            'element_not_actionable',
          );
          break;
        }
        case 'keypad': {
          // 보안 키패드 — <input>이 없고 숫자 버튼 클릭이 곧 입력이다 (FWL-033).
          // ref는 프레임을 좁히는 용도이고, 실제로 누르는 것은 정책 셀렉터가 찾은 버튼이다.
          const entry = entryOf(s, intent.ref);
          role = entry.role;
          const frame = await (entry.handle as unknown as ElementHandle).ownerFrame();
          if (!frame) throw new TargetError('element_not_actionable');
          for (const d of intent.value) {
            // 누를 때마다 배치가 섞이는 키패드라 자릿수마다 다시 찾는다
            const loc = frame.locator(intent.digitSelector.split('{digit}').join(d));
            const n = await guarded(() => loc.count(), 'element_not_actionable');
            // 0개면 셀렉터가 안 맞는 것, 2개 이상이면 어느 버튼인지 모른다 — 둘 다 누르지 않고 멈춘다
            if (n !== 1) throw new TargetError('element_not_actionable');
            await guarded(() => loc.first().click({ timeout }), 'element_not_actionable');
          }
          break;
        }
        case 'keypad_sprite': {
          // 스프라이트 키패드 (FWL-038) — 버튼의 숫자가 DOM에 없어 셀 이미지를 서버가 판독한다.
          // 판독은 core(순수 로직), 여기서는 computed style만 읽고 인덱스로 누른다. 숫자는 어디에도 남기지 않는다
          const entry = entryOf(s, intent.ref);
          role = entry.role;
          const frame = await (entry.handle as unknown as ElementHandle).ownerFrame();
          if (!frame) throw new TargetError('element_not_actionable');
          const keys = frame.locator(intent.keySelector);
          const cells = (await guarded(
            () => frame.evaluate(collectSpriteCells(intent.keySelector, intent.cellSelector)),
            'element_not_actionable',
          )) as ReadonlyArray<{ sprite: string; x: number; y: number; w: number; h: number } | null>;
          if (cells.length === 0 || cells.some((c) => c === null)) throw new TargetError('keypad_unresolved');
          const known = cells as ReadonlyArray<{ sprite: string; x: number; y: number; w: number; h: number }>;
          // 스프라이트는 한 장이어야 한다 — 버튼마다 다른 이미지면 우리가 아는 키패드가 아니다
          if (new Set(known.map((c) => c.sprite)).size !== 1) throw new TargetError('keypad_unresolved');
          const spriteBytes = Buffer.from((known[0] as { sprite: string }).sprite.slice('data:image/png;base64,'.length), 'base64');
          let digitsByIndex: string[];
          try {
            digitsByIndex = resolveKeypadSprite(spriteBytes, known.map(({ x, y, w, h }) => ({ x, y, w, h })));
          } catch (e) {
            if (e instanceof KeypadUnresolvedError) throw new TargetError('keypad_unresolved');
            throw e;
          }
          for (const d of intent.value) {
            const i = digitsByIndex.indexOf(d);
            if (i < 0) throw new TargetError('keypad_unresolved');
            // 판독 뒤 버튼 수가 달라졌으면 배치가 바뀐 것 — 인덱스를 믿지 않는다
            if ((await guarded(() => keys.count(), 'element_not_actionable')) !== known.length) throw new TargetError('keypad_unresolved');
            await guarded(() => keys.nth(i).click({ timeout }), 'element_not_actionable');
          }
          break;
        }
        case 'click': {
          const entry = entryOf(s, intent.ref);
          role = entry.role;
          // 클릭이 새 탭을 열면 잠깐 기다려 그 페이지의 url을 돌려준다 (FWL-043). 더 늦게 열려도 context 'page' 리스너가 따라간다
          const opened = s.browser.context
            .waitForEvent('page', { timeout: 800 })
            .then((p) => p.waitForLoadState('domcontentloaded', { timeout: 10_000 }))
            .catch(() => {});
          await guarded(
            () => (entry.handle as unknown as ElementHandle).click({ timeout }),
            'element_not_actionable',
          );
          await opened;
          break;
        }
        case 'select': {
          const entry = entryOf(s, intent.ref);
          role = entry.role;
          await guarded(async () => {
            await (entry.handle as unknown as ElementHandle).selectOption(intent.option, { timeout });
          }, 'element_not_actionable');
          break;
        }
        case 'scroll': {
          const entry = entryOf(s, intent.ref);
          role = entry.role;
          // 새 세대를 열지 않는다 — 스크롤은 DOM을 바꾸지 않으므로 기존 ref가 그대로 유효하다
          await guarded(
            () => (entry.handle as unknown as ElementHandle).scrollIntoViewIfNeeded({ timeout }),
            'element_not_actionable',
          );
          break;
        }
        case 'wait':
          await guarded(
            () => handleOf(s, intent.ref).waitForElementState('visible', { timeout: intent.timeoutMs }),
            'timeout',
          );
          break;
      }
      return { url: s.page.url(), ...(role === undefined ? {} : { role }) };
    },
  };
}
