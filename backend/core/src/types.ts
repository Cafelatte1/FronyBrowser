/**
 * 브랜디드 타입과 공통 계약.
 *
 * 여기 정의된 브랜드는 "이 값이 특정 관문을 통과했다"는 증거다.
 * 생성자를 export 하지 않는 것이 핵심 — 타입 단언 없이는 만들 수 없다.
 */

declare const brand: unique symbol;

type Brand<T, B> = T & { readonly [brand]: B };

// ─────────────────────────────────────────────────────────────
// egress를 통과한 응답
// ─────────────────────────────────────────────────────────────

/**
 * egress 스크러버를 통과한 응답. 모든 핸들러의 반환 타입이다.
 *
 * 이 타입의 값은 `api/egress.ts`의 `scrub()`만이 만들 수 있다.
 * 핸들러가 평범한 객체를 반환하면 컴파일이 실패한다 (규칙 3).
 */
export type ScrubbedResponse<T = unknown> = Brand<T, 'ScrubbedResponse'>;

/**
 * 값이 제거된 스냅샷. `ActionTarget.snapshot()`의 반환 타입이다.
 *
 * 어댑터가 원시 a11y 데이터를 그대로 반환하면 컴파일이 실패한다 (규칙 1).
 * `app/snapshot.ts`의 직렬화기만이 이 타입을 만든다.
 */
export type SafeSnapshot = Brand<SnapshotBody, 'SafeSnapshot'>;

/**
 * 스냅샷 슬라이스 (FWL-043). 수집·번호는 전문과 같고 출력만 줄인다 — DOM이 같으면 같은 요소의 ref index가 같다.
 * ref: 그 요소의 서브트리만 (현재 세대의 ref여야 한다, 아니면 stale_ref). filter: 클릭·입력 대상만
 */
export type SnapshotOptions = {
  readonly ref?: Ref;
  readonly filter?: 'interactive';
  /**
   * 잘린 트리를 이 ref 다음 줄부터 이어 받는다 (FWL-076). 잘림 안내 줄이 알려준 ref를 그대로 넣는다.
   * 세대가 아니라 index로 맞추므로 새 스냅샷에서도 같은 자리를 가리킨다 — DOM이 바뀌었으면 처음부터 준다
   */
  readonly after?: Ref;
  /** true면 lean 전처리 없이 전부 (FWL-044). 기본은 lean — 이름 없는 img·푸터·이미 요소 이름으로 나온 텍스트를 빼고 빈 이름 연속을 접는다 */
  readonly raw?: boolean;
};

/**
 * 현재 화면 한 장 (FWL-062).
 *
 * 입력창은 마스크 박스로 덮인 채 찍힌다 — 규칙 1의 경계선을 픽셀에도 그은 것이다.
 * 사이트가 **화면에 표시한** 값(배송지 이름·전화·주소)은 가려지지 않는다. 그건 스크러버의 영역인데,
 * PNG는 사후 치환이 불가능하다 (규칙 3 예외 — CLAUDE.md 참조).
 */
export type PageImage = {
  readonly png: Uint8Array;
  /** png의 실제 픽셀 크기 — 긴 변 1024로 줄인 뒤의 값이다 (FWL-066). 뷰포트의 CSS 크기가 아니다 */
  readonly width: number;
  readonly height: number;
  /** 덮은 입력창 수. 마스킹이 실제로 돌았다는 유일한 증거라 감사에 남긴다 */
  readonly masked: number;
};

/** 컨텍스트에 열린 페이지 하나 (FWL-043). url은 origin + 경로까지 — 쿼리스트링에 토큰이 실릴 수 있다 */
export type PageInfo = {
  readonly index: number;
  readonly url: string;
  readonly current: boolean;
};

export type SnapshotBody = {
  /** 스냅샷 세대. 이 세대의 ref만 유효하다 (8.1) */
  readonly gen: number;
  /** 컨텍스트에 열린 페이지 수 */
  readonly pages: number;
  /** 최상위 페이지 URL */
  readonly url: string;
  /** 들여쓰기 텍스트 트리. input/textarea의 value는 어떤 노드에도 없다 */
  readonly tree: string;
};

// ─────────────────────────────────────────────────────────────
// 식별자
// ─────────────────────────────────────────────────────────────

/** 서버가 발급하는 불투명 세션 id. 호출자가 정할 수 없다 (규칙 8) */
export type SessionId = Brand<string, 'SessionId'>;

/** 승인 대기 토큰. 서버 발급 */
export type ApprovalToken = Brand<string, 'ApprovalToken'>;

/**
 * 스냅샷이 발급한 요소 참조. `"<gen>:e<n>"` 형식 (8.1).
 *
 * 호출자는 CSS 셀렉터를 보내지 않는다 — 임의 요소 접근을 허용하면
 * 기능 화이트리스트가 무의미해진다.
 */
export type Ref = Brand<string, 'Ref'>;

const REF_PATTERN = /^(\d+):e(\d+)$/;

export function parseRef(raw: string): { gen: number; index: number } | null {
  const m = REF_PATTERN.exec(raw);
  if (!m) return null;
  return { gen: Number(m[1]), index: Number(m[2]) };
}

export function formatRef(gen: number, index: number): Ref {
  return `${gen}:e${index}` as Ref;
}

// ─────────────────────────────────────────────────────────────
// 에러 모델 (8.3)
// ─────────────────────────────────────────────────────────────

export const ERROR_CODES = {
  unauthorized: { retriable: false },
  bad_request: { retriable: false },
  vault_locked: { retriable: false },
  key_not_found: { retriable: false },
  /** 만들려는 것이 이미 있다 (FWL-056) — 금고 파일이 있는 채로 create를 부른 경우 */
  already_exists: { retriable: false },
  /** 운영자가 Test Mode 주행에서 이 키를 보류했다 (FWL-056). 아무것도 입력하지 않았다 — 빈 칸을 제출하지 말고 멈춘다 */
  key_held: { retriable: false },
  origin_not_permitted: { retriable: false },
  grant_required: { retriable: false },
  grant_invalid: { retriable: false },
  stale_ref: { retriable: true },
  ref_not_found: { retriable: false },
  element_not_actionable: { retriable: true },
  /** 스프라이트 키패드의 자리→숫자 판독 실패 (FWL-038). 아무것도 누르지 않았다. 마크업·스프라이트가 바뀐 것 — 재시도로 풀리지 않는다 */
  keypad_unresolved: { retriable: false },
  session_not_found: { retriable: false },
  session_expired: { retriable: false },
  session_limit: { retriable: true },
  lease_conflict: { retriable: true },
  browser_unavailable: { retriable: false },
  approval_denied: { retriable: false },
  approval_expired: { retriable: false },
  navigation_failed: { retriable: true },
  timeout: { retriable: true },
} as const satisfies Record<string, { retriable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * 세션이 도는 브라우저 프로필. session_begin에서 호출자가 고른다 (FWL-055).
 *   chromium — Playwright 새 headless Chromium (기본)
 *   chrome   — 시스템에 설치된 실제 Chrome 채널 (봇탐지가 센 사이트용, 서버에 없으면 browser_unavailable)
 */
export type BrowserProfile = 'chromium' | 'chrome';

/**
 * 세션이 붙는 타겟의 종류 (FWL-037). 'browser'가 내장이고, 다른 종류는 어댑터가 ActionTarget을
 * 그 이름으로 등록하며 생긴다. session_begin의 kind가 고르고, 핸들러는 세션의 kind로 타겟을 찾는다.
 * 등록되지 않은 kind는 bad_request다 (fail-closed)
 */
export type TargetKind = string;

/**
 * 브라우저 타겟의 기동 프로필 = 엔진 + 모드. 둘 다 session_begin에서 호출자가 정한다 (FWL-055).
 * headful은 interactive 로그온이 있는 환경에서만 뜬다 — 못 띄우면 browser_unavailable.
 */
export type BrowserLaunchProfile = {
  readonly kind: 'browser';
  readonly browser: BrowserProfile;
  readonly headless: boolean;
};

/** 브라우저가 아닌 종류 — 기동 옵션은 그 어댑터가 정의한다. 지금은 kind만 있다 */
export type OtherLaunchProfile = {
  readonly kind: TargetKind;
};

/** 세션을 띄우는 방식. kind로 구분한다 — 브라우저 전용 필드는 브라우저 어댑터만 본다 */
export type LaunchProfile = BrowserLaunchProfile | OtherLaunchProfile;

export function isBrowserProfile(p: LaunchProfile): p is BrowserLaunchProfile {
  return p.kind === 'browser' && 'browser' in p && 'headless' in p;
}

export type WalletError = {
  readonly code: ErrorCode;
  /** 사람이 읽는 용도. 값이 절대 들어가지 않는다 (규칙 5) */
  readonly message: string;
  readonly retriable: boolean;
};

export type Failure = { readonly ok: false; readonly error: WalletError };
export type Success<T> = { readonly ok: true } & T;
export type Result<T> = Success<T> | Failure;

export function fail(code: ErrorCode, message: string): Failure {
  return { ok: false, error: { code, message, retriable: ERROR_CODES[code].retriable } };
}

/**
 * 값이 섞일 수 있는 예외를 에러로 바꾼다.
 *
 * 예외 메시지를 그대로 싣지 않는다 — Playwright 에러에 입력값이 포함되는
 * 경우가 있다 (규칙 5). 원문이 필요하면 스크러버를 통과시킨 뒤 감사 로그로 보낸다.
 */
export function failFromUnknown(code: ErrorCode, _cause: unknown): Failure {
  return fail(code, `${code} (details suppressed)`);
}
