/**
 * 입구 무관 공통 처리. MCP·내부 HTTP 어느 쪽으로 들어와도 여기로 모인다.
 *
 * 반환은 전부 `Result<T>` 평문이고, 입구가 egress.scrub()을 통과시킨다.
 * 값이 응답에 실리는 경로는 이 파일에 존재하지 않는다 — fill은 키 이름과
 * 길이만 돌려준다.
 */

import type {
  ActionTarget,
  Audit,
  FillResponse,
  Result,
  SessionBeginRequest,
  SessionBeginResponse,
  SessionId,
  SessionListResponse,
  SessionStatusResponse,
  SessionStore,
  SessionSummary,
  SnapshotBody,
  Vault,
  VaultListResponse,
  Session,
} from '@wallet/core';
import { KeyNotFoundError, VaultLockedError, fail, failFromUnknown, findKeys, markGrantUsed, resolve, verifyPayGrant, writeUnlockHandoff } from '@wallet/core';
import type { BrowserProfile, Cipher, GlyphSet, KeypadSpec, LaunchProfile, OriginProfiles, PageImage, Ref, SnapshotOptions, TargetKind, TestMode } from '@wallet/core';
import { TEMPLATE_NAME, isBrowserProfile } from '@wallet/core';
import { TargetError, baseDomain } from '@wallet/app';

export type HandlerDeps = {
  readonly vault: Vault;
  readonly sessions: SessionStore;
  /** kind별 ActionTarget. 'browser'는 필수; session_begin이 요청한 kind에 타겟이 없으면 bad_request */
  readonly targets: ReadonlyMap<TargetKind, ActionTarget>;
  readonly audit: Audit;
  /** grant 플래그 키가 있으면 fill이 이 키로 검증한다; 없으면 grant 키 fill은 grant_invalid(fail-closed) */
  readonly grantKey?: string | null;
  /** 켜져 있으면 grant 플래그 키의 fill이 입력만 건너뛰고, 보류 키의 fill은 key_held로 거부된다 (FWL-035/056). 없으면 꺼진 것 */
  readonly testMode?: TestMode;
  /** unlock 인계 파일 경로 (FWL-042). 없으면 vault_handoff는 거부된다 */
  readonly handoffFile?: string;
  /** origin별로 로그인까지 갔던 기동 조합 (FWL-065). 없으면 호출자 말을 그대로 따른다 — 기억도 검사도 없다 */
  readonly originProfiles?: OriginProfiles;
  readonly handoffCipher?: Cipher;
  /** 이름 → 스프라이트 키패드 글리프 템플릿 (FWL-073). 없으면 `keypad.template`을 댄 fill은 전부 bad_request */
  readonly keypadTemplates?: (name: string) => GlyphSet | undefined;
};

export type Caller = { readonly client: string };

function toFailure(e: unknown): ReturnType<typeof fail> {
  if (e instanceof TargetError) return fail(e.code, e.code);
  if (e instanceof VaultLockedError) return fail('vault_locked', 'unlock required');
  // 없는 키도 origin_not_permitted로 답한다 — 구분되면 금고 내용을 탐색당한다 (8.3)
  if (e instanceof KeyNotFoundError) return fail('origin_not_permitted', 'not permitted');
  return failFromUnknown('timeout', e);
}


function isExactOrigin(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === s;
  } catch {
    return false;
  }
}

const BROWSER_PROFILES: ReadonlyArray<BrowserProfile> = ['chromium', 'chrome'];

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/**
 * 같은 사이트인가 — 스킴·포트가 같고 등록 가능 도메인이 같다. 서브도메인은 자유다 (FWL-069).
 * IP 리터럴은 도메인이 아니므로 정확히 같아야 한다 — baseDomain('127.0.0.1')은 '0.1'이라 다른 IP끼리 같다고 답한다.
 * 포트도 본다: 같은 호스트의 다른 포트는 다른 서비스다 (이 서버의 관리 화면도 루프백의 다른 포트에 있다)
 */
function sameSite(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  if (ua.protocol !== ub.protocol || ua.port !== ub.port) return false;
  if (IP_LITERAL.test(ua.hostname) || IP_LITERAL.test(ub.hostname)) return ua.hostname === ub.hostname;
  return baseDomain(ua.hostname) === baseDomain(ub.hostname);
}

export function createHandlers(deps: HandlerDeps) {
  const { vault, sessions, targets, audit } = deps;
  if (!targets.has('browser')) throw new Error('no ActionTarget registered for kind "browser"');
  function targetOf(s: { readonly kind: TargetKind }): ActionTarget {
    const t = targets.get(s.kind);
    if (!t) throw new Error(`no ActionTarget registered for kind "${s.kind}"`); // 기동 검사로 막혀 있다
    return t;
  }
  let vaultWasOpen = !vault.locked;
  /** 이미 쓴 pay grant. 1회용이므로 여기에 쌓이고, exp 5분이라 재사용 창 자체가 짧다 */
  const usedGrants = new Set<string>();

  function session(caller: Caller, id: SessionId): Result<{ session: Session }> {
    const s = sessions.get(id);
    if (!s) return fail('session_not_found', 'unknown or expired session');
    if (s.client !== caller.client) return fail('session_not_found', 'unknown or expired session');
    sessions.touch(id); // 살아 움직이는 세션 — TTL 연장 (승인 대기 중 죽으면 안 된다)
    return { ok: true, session: s };
  }

  function summarize(s: Session): SessionSummary {
    return {
      sessionId: s.id,
      createdAt: s.createdAt,
      ttlRemainingMs: Math.max(0, s.expiresAt - Date.now()),
      origin: s.origin,
      kind: s.kind,
      ...(isBrowserProfile(s.profile) ? { browser: s.profile.browser, headless: s.profile.headless } : {}),
    };
  }

  function baseAudit(s: Session | null, caller: Caller) {
    return {
      sid: s?.id ?? null,
      client: caller.client,
      traceId: s?.request.traceId ?? null,
    };
  }

  return {
    async session_begin(caller: Caller, req: SessionBeginRequest): Promise<Result<SessionBeginResponse>> {
      // 세션 = 타겟 origin 하나. 정확한 origin만 받는다 — 경로·와일드카드가 섞이면 리스 단위가 흐려진다
      if (typeof req.origin !== 'string' || !isExactOrigin(req.origin)) {
        return fail('bad_request', 'origin must be an exact http(s) origin');
      }
      const kind = req.kind ?? 'browser';
      if (!targets.has(kind)) return fail('bad_request', `unknown target kind "${kind}"`);
      if (req.browser !== undefined && !BROWSER_PROFILES.includes(req.browser)) return fail('bad_request', 'browser must be "chromium" or "chrome"');
      // 호출자가 고른다 — 사이트별 조합은 플레이북 지식이다 (FWL-055). chrome/headful을 못 띄우면 browser_unavailable로 그대로 실패한다
      const wanted: LaunchProfile = kind === 'browser'
        ? { kind, browser: req.browser ?? 'chromium', headless: req.headless ?? true }
        : { kind };
      // 호출자가 조합을 말하지 않았을 때만, 이 origin이 로그인까지 갔던 조합으로 채운다 (FWL-065, FWL-067).
      // 지목한 조합을 거부하지는 않는다 — 기억은 관찰값이고 호출자의 플레이북이 선언값이다.
      // 파생값이 선언값을 막으면 사이트 정책이 바뀐 날 되돌릴 방법이 없어진다
      let profile = wanted;
      if (isBrowserProfile(wanted) && req.browser === undefined && req.headless === undefined) {
        const remembered = deps.originProfiles?.get(req.origin);
        if (remembered) profile = { kind: 'browser', browser: remembered.browser, headless: remembered.headless };
      }
      const begun = sessions.begin(caller.client, req, profile);
      if (!begun.ok) {
        return begun.code === 'lease_conflict'
          ? fail('lease_conflict', 'origin held by another client\'s session')
          : fail('session_limit', 'too many concurrent sessions');
      }
      // 같은 클라이언트의 이전 세션을 이어받았다 (FWL-036) — 컨텍스트를 닫고 종료를 남긴다. 쿠키는 재저장하지 않는다
      if (begun.replaced) {
        const old = begun.replaced;
        await targetOf(old).close(old.id).catch(() => {});
        audit.append({ evt: 'session_end', sid: old.id, client: old.client, traceId: old.request.traceId ?? null, origin: old.origin, reason: 'replaced' });
      }
      const target = targetOf(begun.session);
      let opened: { readonly storedLogin: boolean };
      try {
        opened = await target.open(begun.session.id, { origin: req.origin, ...profile });
      } catch (e) {
        sessions.end(begun.session.id, 'error');
        const f = toFailure(e);
        // 기억한 조합이 아예 뜨지 못하면 기억을 버린다 (FWL-065) — 크롬이 사라진 경우 등.
        // 여기 닿는 시점에 기억이 있다면 profile은 반드시 그 기억과 같다 (다르면 위에서 이미 거절했다)
        if (f.error.code === 'browser_unavailable') deps.originProfiles?.forget(req.origin);
        // 세션 시작 실패도 남긴다 (FWL-063). 없으면 browser_unavailable의 원인이 어디에도 안 남아
        // 운영자가 Chrome을 고쳐야 하는지 로그온을 해야 하는지 알 길이 없다.
        // reason은 분류값이고 예외 메시지가 아니다 (규칙 5) — profile과 짝지어야 뜻이 산다
        audit.append({
          evt: 'action_failed',
          ...baseAudit(begun.session, caller),
          origin: req.origin,
          kind: 'session_begin',
          code: f.error.code,
          profile,
          reason: e instanceof TargetError ? (e.reason ?? null) : null,
        });
        return f;
      }
      audit.append({
        evt: 'session_begin',
        ...baseAudit(begun.session, caller),
        origin: req.origin,
        kind: profile.kind,
        profile,
        onApproval: req.onApproval ?? null,
      });
      // 실제 로그인 여부는 에이전트가 스냅샷으로 판단한다 (FWL-046) — 서버는 저장 컨텍스트를 주입했는지만 안다
      return { ok: true, sessionId: begun.session.id, storedLogin: opened.storedLogin };
    },

    /**
     * TTL 만료 세션 정리 — 주기적으로 부른다. 스토어에서 빠진 세션의 브라우저 컨텍스트를 닫아야
     * 누수가 없고, 닫히면서 session_end 감사가 남는다.
     * 로그인 쿠키는 재저장하지 않는다 — 단언 없는 종료다 (FWL-026)
     */
    async sweep_expired(): Promise<void> {
      // 금고 TTL 만료는 접근 시점에 게으르게 판정된다 — 여기서 열림→잠김 전이를 잡아 감사에 남긴다
      const open = !vault.locked;
      if (vaultWasOpen && !open) {
        audit.append({ evt: 'vault_lock', sid: null, client: null, traceId: null, origin: null, reason: 'ttl' });
      }
      vaultWasOpen = open;
      for (const s of sessions.sweepExpired()) {
        await targetOf(s).close(s.id).catch(() => {});
        audit.append({ evt: 'session_end', sid: s.id, client: s.client, traceId: s.request.traceId ?? null, origin: s.origin, reason: 'ttl' });
      }
    },

    /** 이어받기용 — sessionId를 잃은 에이전트가 자기 세션을 되찾는다 (FWL-008) */
    async session_list(caller: Caller): Promise<Result<SessionListResponse>> {
      const sessions = deps.sessions.listByClient(caller.client).map((s) => summarize(s));
      return { ok: true, sessions };
    },

    async session_status(caller: Caller, id: SessionId): Promise<Result<SessionStatusResponse>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      try {
        const status = await target.status(id);
        return { ok: true, ...summarize(found.session), ...status };
      } catch (e) {
        return toFailure(e);
      }
    },

    /**
     * 로그인 쿠키 재저장은 에이전트가 `loggedIn`을 단언했을 때만 (FWL-026).
     * TTL·오류 종료는 저장하지 않는다 — 비로그인 상태가 시딩본을 덮어쓰지 않게
     */
    async session_end(caller: Caller, id: SessionId, loggedIn?: boolean): Promise<Result<object>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      sessions.end(id, 'normal');
      await target.close(id, { persist: loggedIn === true }).catch(() => {});
      // 로그인까지 갔다 = 이 조합이 차단당하지 않았다 (FWL-065). 쿠키를 덮어쓸 때 이미 믿는 단언을 같은 자리에서 한 번 더 쓴다.
      // 단, 호출자가 스스로 고른 조합만 배운다 — 아무도 고르지 않은 기본값은 아무것도 증명하지 않는다.
      // keepalive가 그 경우다: 조합을 생략하고 열어서 `loggedIn` 자리에 "홈이 열렸다"를 싣는데,
      // 쿠팡 홈은 헤드리스로도 열린다 (2026-09-13 실측) — 이 단서가 없으면 keepalive가 틀린 조합을 굳혀 버린다
      const chosen = found.session.request.browser !== undefined || found.session.request.headless !== undefined;
      if (loggedIn === true && chosen && isBrowserProfile(found.session.profile)) {
        deps.originProfiles?.remember(found.session.origin, found.session.profile);
      }
      audit.append({
        evt: 'session_end',
        ...baseAudit(found.session, caller),
        origin: found.session.origin,
        reason: 'normal',
        loggedIn: loggedIn ?? null,
      });
      return { ok: true };
    },

    /** 탈출구 (FWL-043): auto-follow가 데려간 페이지에서 원래 탭으로 돌아온다. 다음 새 페이지가 열리면 다시 auto-follow가 이긴다 */
    async page_switch(caller: Caller, id: SessionId, index: number): Promise<Result<{ url: string }>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      if (!Number.isInteger(index) || index < 0) return fail('bad_request', 'index must be a non-negative integer');
      try {
        await target.switchPage(id, index);
        const { url } = await target.status(id);
        audit.append({ evt: 'page_switch', ...baseAudit(found.session, caller), origin: null, index, url });
        return { ok: true, url };
      } catch (e) {
        const f = toFailure(e);
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin: null, kind: 'page_switch', code: f.error.code });
        return f;
      }
    },

    async page_tree(caller: Caller, id: SessionId, opts: SnapshotOptions = {}): Promise<Result<{ snapshot: SnapshotBody }>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      try {
        const snap = await target.snapshot(id, opts);
        // 스냅샷을 언제 읽었는지가 남아야 나중에 세션을 재구성할 수 있다 (FWL-030). 트리 본문은 싣지 않는다
        audit.append({
          evt: 'page_tree',
          ...baseAudit(found.session, caller),
          origin: null,
          generation: snap.gen,
          pages: snap.pages,
          slice: opts.ref !== undefined ? 'ref' : (opts.filter ?? null), // 어떤 슬라이스였는지만 — ref 문자열은 값이 아니지만 남길 이유도 없다
          raw: opts.raw === true,
        });
        return { ok: true, snapshot: snap };
      } catch (e) {
        const f = toFailure(e);
        audit.append({
          evt: 'action_failed',
          ...baseAudit(found.session, caller),
          origin: null,
          kind: 'page_tree',
          code: f.error.code,
        });
        return f;
      }
    },

    /**
     * 현재 화면 한 장 (FWL-062). 입력창은 덮인 채로 찍힌다 (규칙 1).
     * 반환에 PNG 바이트가 실리지만, 그건 `scrub()`을 통과할 수 없다 — 입구(mcp/server.ts)가
     * 메타데이터만 스크러버에 넣고 바이트는 별도 콘텐츠 블록으로 내보낸다 (규칙 3 예외).
     */
    async page_image(caller: Caller, id: SessionId): Promise<Result<{ image: PageImage }>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      try {
        const image = await target.image(id);
        // 마스킹이 돌았다는 증거는 masked 수뿐이다 — 이미지 자체는 절대 남기지 않는다 (규칙 5)
        audit.append({
          evt: 'page_image',
          ...baseAudit(found.session, caller),
          origin: null,
          w: image.width,
          h: image.height,
          masked: image.masked,
        });
        return { ok: true, image };
      } catch (e) {
        const f = toFailure(e);
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin: null, kind: 'page_image', code: f.error.code });
        return f;
      }
    },

    async navigate(caller: Caller, id: SessionId, url: string): Promise<Result<{ url: string }>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      let origin: string;
      let logged: string;
      try {
        const u = new URL(url);
        origin = u.origin;
        // 감사에는 쿼리를 빼고 남긴다 — 쿼리에 토큰이 실릴 수 있다
        logged = `${u.origin}${u.pathname}`;
      } catch {
        // 에이전트가 잘못된 URL을 낸 것도 재구성에 필요하다 (FWL-030) — origin은 없으니 null
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin: null, kind: 'navigate', code: 'navigation_failed' });
        return fail('navigation_failed', 'malformed url');
      }
      // 에이전트의 navigate는 세션의 사이트 안에서만 — 정확한 origin이 아니라 등록 가능 도메인으로 본다 (FWL-069).
      // 상품·검색·주문이 서브도메인으로 갈라진 사이트(실측 2026-09-14: 서점 하나가 www/product/search/store)에서
      // origin 비교는 클릭으로는 되는 이동을 URL로는 막았다. 검사의 목적은 호출자가 딴 사이트로 새는 걸 잡는 것이지
      // 서브도메인 격리가 아니다. 리스 단위(FWL-017)는 그대로 origin이다. 페이지가 스스로 옮기는 리디렉트
      // (PG·소셜 로그인·카드사 인증)는 이 핸들러를 거치지 않으므로 그대로 흐른다
      if (!sameSite(origin, found.session.origin)) {
        audit.append({ evt: 'policy_denied', ...baseAudit(found.session, caller), origin, rule: 'session_origin' });
        return fail('origin_not_permitted', 'session is bound to another origin');
      }
      try {
        const r = await target.act(id, { kind: 'navigate', url });
        audit.append({ evt: 'navigate', ...baseAudit(found.session, caller), origin, url: logged });
        return { ok: true, url: r.url };
      } catch (e) {
        const f = toFailure(e);
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin, kind: 'navigate', code: f.error.code });
        return f;
      }
    },

    async fill(caller: Caller, id: SessionId, ref: Ref, value: string, grant?: string, keypad?: KeypadSpec): Promise<Result<FillResponse>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);

      const keys = findKeys(value);
      // 실패한 fill도 남긴다 — 키 이름과 에러 코드만이다. 값도 길이도 싣지 않는다 (규칙 5, FWL-030)
      let filledRole: string | null = null;
      const failed = (e: unknown, origin: string | null) => {
        const f = toFailure(e);
        audit.append({
          evt: 'action_failed',
          ...baseAudit(found.session, caller),
          origin,
          kind: 'fill',
          ref: String(ref),
          key: keys[0] ?? null,
          code: f.error.code,
        });
        return f;
      };

      let frameOrigin: string;
      try {
        frameOrigin = await target.originOf(id, ref);
      } catch (e) {
        return failed(e, null); // origin을 못 읽은 실패다 — 프레임 origin이 없다
      }

      let resolved;
      try {
        resolved = resolve(value, vault);
      } catch (e) {
        if (e instanceof KeyNotFoundError) {
          // 금고에 없는 키 — 탐색 가치가 없는 자기 설정 문제
          audit.append({
            evt: 'policy_denied',
            ...baseAudit(found.session, caller),
            origin: frameOrigin,
            key: e.key,
            rule: 'vault_missing',
          });
          return fail('key_not_found', 'not in vault');
        }
        return failed(e, frameOrigin);
      }

      // 보안 키패드 — 값을 채우는 게 아니라 서버가 숫자 버튼을 누른다. 셀렉터는 호출자가 넘긴다 (FWL-033/038, FWL-055)
      let glyphs: GlyphSet | undefined;
      if (keypad !== undefined) {
        // 키패드는 한 번에 한 값만 누른다 — 여러 키를 이어붙인 값은 자릿수 대응이 없다
        if (keys.length !== 1) return fail('bad_request', 'keypad fill takes exactly one vault key');
        if (!/^[0-9]+$/.test(resolved.value)) {
          // 값은 절대 남기지 않는다 — 어느 키가 규약을 어겼는지만 (규칙 5)
          audit.append({
            evt: 'policy_denied',
            ...baseAudit(found.session, caller),
            origin: frameOrigin,
            key: keys[0] ?? null,
            rule: 'keypad_digits_only',
          });
          return fail('bad_request', 'keypad value must be digits');
        }
        if (!('digitSelector' in keypad) && keypad.template !== undefined) {
          // 템플릿은 운영자가 이 서버에 둔 파일이다 (FWL-073). 없으면 호출자 쪽 문제로 답한다 —
          // 판독 실패(keypad_unresolved)와 섞이면 셀렉터를 고칠지 템플릿을 만들지 알 수 없다
          if (!TEMPLATE_NAME.test(keypad.template)) return fail('bad_request', 'keypad template name must be lowercase letters, digits and hyphens');
          glyphs = deps.keypadTemplates?.(keypad.template);
          if (glyphs === undefined) return fail('bad_request', `keypad template is not registered on this server: ${keypad.template}`);
        }
      }

      // Test Mode 보류 키 (FWL-056). PIN 스킵은 에이전트가 눈치채지 못하도록 일부러 감추지만,
      // 보류는 빈 칸을 제출시키는 대신 주행을 멈추라는 뜻이라 에러로 돌려준다
      if (deps.testMode?.get() === true) {
        const held = deps.testMode.held();
        const heldKey = keys.find((k) => held.includes(k));
        if (heldKey !== undefined) {
          audit.append({
            evt: 'policy_denied',
            ...baseAudit(found.session, caller),
            origin: frameOrigin,
            key: heldKey,
            rule: 'key_held',
          });
          return fail('key_held', 'key held back from test runs');
        }
      }

      // 볼트에서 grant 플래그가 켜진 키 — grant 발급자의 grant가 있어야 채운다 (규칙 13).
      // resolve가 통과했으니 금고는 열려 있고 키도 전부 있다
      const grantNeededFor = keys.find((k) => vault.get(k)?.grant === true) ?? null;

      // grant는 fill 1회당 한 번만 검증한다 — 1회용이라 키마다 검증하면 두 번째 키에서 reused가 된다
      if (grantNeededFor !== null) {
        const denied = (reason: string) => {
          audit.append({
            evt: 'grant_denied',
            ...baseAudit(found.session, caller),
            origin: frameOrigin,
            key: grantNeededFor,
            reason, // 토큰 자체는 절대 남기지 않는다 (규칙 5)
          });
        };
        if (grant === undefined) {
          denied('missing');
          return fail('grant_required', 'this key requires a pay grant');
        }
        // grant 키가 없으면 검증할 수 없다 — fail-closed
        if (!deps.grantKey) {
          denied('no_grant_key');
          return fail('grant_invalid', 'pay grant rejected');
        }
        const verdict = verifyPayGrant(grant, deps.grantKey, {
          sessionId: String(id),
          nowMs: Date.now(),
          used: usedGrants,
        });
        if (!verdict.ok) {
          // 어느 단계에서 걸렸는지는 감사 로그에만 남긴다 — 호출자에겐 grant_invalid 하나다
          denied(verdict.reason);
          return fail('grant_invalid', 'pay grant rejected');
        }
      }

      // Test Mode: grant 키는 여기까지(세션·grant·키패드 규칙) 전부 통과한 뒤 입력만 건너뛴다 (FWL-035).
      // 응답은 실제 fill과 같아야 한다 — 주행 중인 에이전트가 Test Mode임을 알 수 없어야 한다
      const dry = grantNeededFor !== null && (deps.testMode?.get() ?? false);
      if (!dry) {
        try {
          const r = await target.act(
            id,
            keypad === undefined
              ? { kind: 'fill', ref, value: resolved.value }
              : 'digitSelector' in keypad
                ? { kind: 'keypad', ref, digitSelector: keypad.digitSelector, value: resolved.value }
                : { kind: 'keypad_sprite', ref, keySelector: keypad.keySelector, cellSelector: keypad.cellSelector, resolver: keypad.resolver, ...(glyphs ? { glyphs } : {}), value: resolved.value },
          );
          filledRole = r.role ?? null;
        } catch (e) {
          return failed(e, frameOrigin);
        }
      }

      // grant는 행위가 성공한 뒤에 태운다 — 검증 시점에 태우면 실패한 fill 하나가 grant를 날린다 (FWL-033)
      if (grantNeededFor !== null && grant !== undefined) markGrantUsed(usedGrants, grant);

      audit.append({
        evt: 'fill',
        ...baseAudit(found.session, caller),
        origin: frameOrigin,
        key: keys[0] ?? null,
        len: resolved.value.length,
        ref: String(ref),
        role: filledRole,
        mode: keypad !== undefined ? 'keypad' : 'text',
        ...(keypad !== undefined && !('digitSelector' in keypad) ? { resolver: keypad.resolver, ...(keypad.template !== undefined ? { template: keypad.template } : {}) } : {}),
        ...(grantNeededFor !== null ? { grant: true } : {}),
        ...(dry ? { dry: true } : {}), // Test Mode는 감사로그에만 드러난다 — 응답에는 절대 싣지 않는다. 필드 이름은 기록된 사실이라 그대로 둔다
      });
      return { ok: true, filledFrom: keys[0] ?? null, len: resolved.value.length };
    },

    async click(caller: Caller, id: SessionId, ref: Ref): Promise<Result<{ url: string }>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);

      // origin은 감사 기록용이다 — 클릭 자체에 값 규칙은 없다
      let origin: string | null = null;
      try {
        origin = await target.originOf(id, ref);
      } catch {
        // 요소 origin을 못 읽으면 아래 act에서 같은 이유로 실패한다
      }

      try {
        const r = await target.act(id, { kind: 'click', ref });
        audit.append({ evt: 'click', ...baseAudit(found.session, caller), origin, ref: String(ref), role: r.role ?? null });
        return { ok: true, url: r.url };
      } catch (e) {
        const f = toFailure(e);
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin, kind: 'click', ref: String(ref), code: f.error.code });
        return f;
      }
    },

    async select(caller: Caller, id: SessionId, ref: Ref, option: string): Promise<Result<{ url: string }>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      try {
        const r = await target.act(id, { kind: 'select', ref, option });
        audit.append({ evt: 'select', ...baseAudit(found.session, caller), origin: null, ref: String(ref), role: r.role ?? null });
        return { ok: true, url: r.url };
      } catch (e) {
        const f = toFailure(e);
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin: null, kind: 'select', ref: String(ref), code: f.error.code });
        return f;
      }
    },

    /** 요소가 보이도록 스크롤 (FWL-061). 세대를 올리지 않으므로 호출 전후의 ref가 모두 유효하다 */
    async scroll(caller: Caller, id: SessionId, ref: Ref): Promise<Result<{ url: string }>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      try {
        const r = await target.act(id, { kind: 'scroll', ref });
        audit.append({ evt: 'scroll', ...baseAudit(found.session, caller), origin: null, ref: String(ref), role: r.role ?? null });
        return { ok: true, url: r.url };
      } catch (e) {
        const f = toFailure(e);
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin: null, kind: 'scroll', ref: String(ref), code: f.error.code });
        return f;
      }
    },

    async wait(caller: Caller, id: SessionId, ref: Ref, timeoutMs: number): Promise<Result<object>> {
      const found = session(caller, id);
      if (!found.ok) return found;
      const target = targetOf(found.session);
      // 0 이하는 Playwright에서 "무제한"이다 — 요청 하나가 영원히 매달리지 않게 1ms~30s로 묶는다
      const bounded = Math.min(Math.max(timeoutMs, 1), 30_000);
      try {
        await target.act(id, { kind: 'wait', ref, timeoutMs: bounded });
        audit.append({ evt: 'wait', ...baseAudit(found.session, caller), origin: null, ref: String(ref), timeoutMs: bounded });
        return { ok: true };
      } catch (e) {
        const f = toFailure(e);
        audit.append({ evt: 'action_failed', ...baseAudit(found.session, caller), origin: null, kind: 'wait', ref: String(ref), code: f.error.code });
        return f;
      }
    },

    async vault_list(_caller: Caller): Promise<Result<VaultListResponse>> {
      try {
        // 길이는 싣지 않는다 — 값의 크기는 에이전트가 알 필요가 없고, 무차별 대입의 범위를 좁혀 준다 (FWL-058)
        return { ok: true, keys: vault.list().map(({ name, type, grant, label }) => ({ name, type, grant, label })) };
      } catch (e) {
        return toFailure(e);
      }
    },

    /** admin 전용·MCP 미노출 (8.4). 입구(http)가 admin 판정을 마친 뒤에만 부른다 */
    async vault_unlock(caller: Caller, passphrase: string): Promise<Result<{ ttlMs: number }>> {
      try {
        await vault.unlock(passphrase);
        audit.append({ evt: 'vault_unlock', sid: null, client: caller.client, traceId: null, origin: null, ok: true });
        return { ok: true, ttlMs: vault.remainingMs() };
      } catch {
        audit.append({ evt: 'vault_unlock', sid: null, client: caller.client, traceId: null, origin: null, ok: false });
        return fail('vault_locked', 'unlock failed');
      }
    },

    /**
     * unlock 인계 (FWL-042) — admin 전용·MCP 미노출. 열려 있는 금고의 패스프레이즈와 만료 시각을 DPAPI 파일로 남겨
     * 재시작 뒤 프로세스가 같은 만료로 이어받게 한다. 잠겨 있으면 인계할 것이 없다
     */
    async vault_handoff(caller: Caller): Promise<Result<{ remainingMs: number }>> {
      const passphrase = vault.currentPassphrase();
      const remainingMs = vault.remainingMs();
      if (passphrase === null || remainingMs <= 0) {
        audit.append({ evt: 'vault_handoff', sid: null, client: caller.client, traceId: null, origin: null, ok: false });
        return fail('vault_locked', 'nothing to hand off — vault is locked');
      }
      if (deps.handoffFile === undefined) return fail('bad_request', 'handoff not configured');
      writeUnlockHandoff(deps.handoffFile, { passphrase, unlockedUntil: Date.now() + remainingMs, issuedAt: Date.now() }, deps.handoffCipher);
      audit.append({ evt: 'vault_handoff', sid: null, client: caller.client, traceId: null, origin: null, ok: true, remainingMs });
      return { ok: true, remainingMs };
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
