/**
 * 소비자(에이전트·미래 프로그램 소비자)가 의존하는 요청/응답 스키마.
 *
 * v1에서 동작하지 않는 필드(`onApproval`)도 여기 들어 있다.
 * 나중에 추가하면 모든 소비자가 깨지므로, 계약은 처음부터 최종형이다.
 */

import type { KeypadResolver } from './keypad-sprite.js';
import type { ApprovalToken, BrowserProfile, PageInfo, Ref, SessionId, TargetKind, SnapshotOptions } from './types.js';

// ─────────────────────────────────────────────────────────────
// 세션
// ─────────────────────────────────────────────────────────────

export type SessionBeginRequest = {
  /**
   * 이 세션이 타겟하는 사이트의 origin (scheme+host[+port], 정확 일치). 필수.
   * 세션 = origin 하나: 여기서 배타 리스·브라우저 프로필·주입할 로그인 세션이 정해진다.
   * navigate는 이 origin 안에서만 허용된다. 페이지가 스스로 옮기는 리디렉트(PG·소셜 로그인·카드사)는 예외다.
   */
  readonly origin: string;
  /** 타겟 종류. 기본 'browser'. 등록되지 않은 kind는 bad_request (FWL-037) */
  readonly kind?: TargetKind;
  /** 브라우저 타겟의 프로필. 기본 chromium · headless. 사이트마다 어느 조합이 통하는지는 호출자(플레이북)가 안다 (2026-09-12 decided, FWL-055) */
  readonly browser?: BrowserProfile;
  readonly headless?: boolean;
  /** 호출자의 불투명 문자열. PII 금지. 감사 로그에 그대로 기록된다 */
  readonly traceId?: string;
  /**
   * 승인이 필요해졌을 때의 동작.
   * `wait` — 대화형. 사람이 곧 누를 것으로 기대한다
   * `fail_fast` — 무인 배치. 즉시 실패시키고 나중에 재시도한다
   */
  readonly onApproval?: 'wait' | 'fail_fast';
};

export type SessionBeginResponse = {
  readonly sessionId: SessionId;
  /** 이 origin의 저장 로그인 컨텍스트를 주입했는가 (FWL-046). 만료됐을 수 있으니 로그인 여부는 에이전트가 페이지에서 확인한다 */
  readonly storedLogin: boolean;
};

/**
 * 세션 이어받기용 상태 조회 (FWL-008). 호출 클라이언트 소유 세션만 보인다.
 * URL은 값이 아니라 위치 정보지만, 값이 URL에 박힌 페이지에 대비해
 * egress 스크러버는 그대로 통과시킨다.
 */
export type SessionSummary = {
  readonly sessionId: SessionId;
  readonly createdAt: number;
  readonly ttlRemainingMs: number;
  /** begin에서 확정된 타겟 origin과 타겟 종류 */
  readonly origin: string;
  readonly kind: TargetKind;
  /** 브라우저 타겟의 프로필. 다른 종류에서는 없다 */
  readonly browser?: BrowserProfile;
  readonly headless?: boolean;
};

export type SessionEndRequest = {
  readonly sessionId: SessionId;
  /**
   * 사이트의 로그인 표식이 보이는 상태로 마쳤으면 true → 로그인 쿠키를 재저장한다.
   * 로그인 화면·차단 페이지를 봤거나 모르면 false/생략 → 저장하지 않는다.
   */
  readonly loggedIn?: boolean;
};

export type SessionListResponse = { readonly sessions: ReadonlyArray<SessionSummary> };

export type SessionStatusResponse = SessionSummary & {
  readonly url: string;
  /** 브라우저 타겟만 낸다. 열린 페이지 목록 — current가 지금 액션이 가는 페이지 */
  readonly pages?: ReadonlyArray<PageInfo>;
  readonly snapshotGen: number;
};

// ─────────────────────────────────────────────────────────────
// 액션
// ─────────────────────────────────────────────────────────────

export type FillRequest = {
  readonly sessionId: SessionId;
  readonly ref: Ref;
  /** `{{vault:key}}` 플레이스홀더를 포함할 수 있다. 실제 값은 서버에서만 치환된다 */
  readonly value: string;
  /** 신뢰하는 grant 발급자(호출 서비스)가 발급한 pay grant. 볼트에서 grant 플래그가 켜진 키에만 필요. 불투명 문자열 */
  readonly grant?: string;
  /**
   * 보안 키패드 (FWL-033/038). 값을 타이핑하는 대신 서버가 자릿수마다 버튼을 누른다.
   * 셀렉터는 사이트 지식이라 호출자가 넘긴다 (FWL-055). 값은 한 개의 vault 키여야 하고 숫자만 허용된다
   */
  readonly keypad?: KeypadSpec;
};

export type KeypadSpec =
  | { readonly digitSelector: string }
  /** template: 운영자가 이 서버에 둔 글리프 템플릿 이름 (`keypads/<name>.json`, FWL-073). 없으면 내장 템플릿 */
  | { readonly keySelector: string; readonly cellSelector: string; readonly resolver: KeypadResolver; readonly template?: string };

/** 값은 절대 반환하지 않는다. 키 이름과 길이뿐이다 */
export type FillResponse = {
  readonly filledFrom: string | null;
  readonly len: number;
};

export type ClickRequest = { readonly sessionId: SessionId; readonly ref: Ref };
export type NavigateRequest = { readonly sessionId: SessionId; readonly url: string };
export type SnapshotRequest = { readonly sessionId: SessionId } & SnapshotOptions;

// ─────────────────────────────────────────────────────────────
// 승인 (v2)
// ─────────────────────────────────────────────────────────────

/**
 * 액션은 블로킹하지 않는다. 승인이 필요하면 토큰을 즉시 반환하고,
 * 호출자가 `approval_wait`로 따로 기다린다 (6절).
 */
export type PendingApproval = {
  readonly status: 'pending_approval';
  readonly token: ApprovalToken;
  readonly reason: string;
};

export type ApprovalWaitRequest = {
  readonly token: ApprovalToken;
  /** 서버가 `wait_max`로 상한을 건다. 초과하면 still_pending */
  readonly timeoutMs?: number;
};

export type ApprovalWaitResponse =
  | { readonly status: 'granted' }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' }
  | { readonly status: 'still_pending' };

// ─────────────────────────────────────────────────────────────
// 금고
// ─────────────────────────────────────────────────────────────

/** 키 이름과 타입만. 값은 어떤 경우에도 나가지 않는다 */
export type VaultListResponse = {
  /**
   * grant는 이 키를 채우려면 pay grant가 필요하다는 뜻, label은 운영자가 붙인 이름이다. 둘 다 값이 아니다.
   * public=true인 항목만 value가 함께 실린다 (FWL-080) — 운영자가 내보내도 된다고 표시한 값이다
   */
  readonly keys: ReadonlyArray<{
    readonly name: string; readonly type: string;
    readonly grant: boolean; readonly public: boolean; readonly label: string;
    readonly value?: string;
  }>;
};

/** admin 클라이언트만 호출할 수 있다. MCP 도구로 노출하지 않는다 (8.4) */
export type VaultUnlockRequest = { readonly passphrase: string };
export type VaultUnlockResponse = { readonly ttlMs: number };
