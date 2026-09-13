/**
 * 외부 시스템 어댑터가 지켜야 할 계약.
 *
 * `core`는 이 인터페이스만 알고, 구현(`app`)을 import 하지 않는다.
 * 안전 규칙이 계약에 박혀 있어 새 어댑터에도 자동으로 적용된다.
 */

import type { KeypadResolver } from './keypad-sprite.js';
import type { LaunchProfile, PageInfo, Ref, SafeSnapshot, SessionId, SnapshotOptions } from './types.js';

/** 어댑터가 수행할 수 있는 동작. 화이트리스트다 */
export type Intent =
  | { readonly kind: 'fill'; readonly ref: Ref; readonly value: string }
  /**
   * 보안 키패드 입력 (FWL-033). `ref`는 키패드 프레임 안의 아무 요소나 — 프레임을 좁히는 데만 쓴다.
   * 어댑터가 `value`의 문자 하나마다 `digitSelector`(`{digit}` 치환)로 버튼을 찾아 한 번씩 누른다.
   * `value`는 숫자만이며, 로그·응답 어디에도 실리지 않는다
   */
  | { readonly kind: 'keypad'; readonly ref: Ref; readonly digitSelector: string; readonly value: string }
  /**
   * 스프라이트 키패드 입력 (FWL-038). 숫자가 DOM에 없다 — 어댑터가 `keySelector` 버튼마다 `cellSelector`의
   * computed 배경 스프라이트·위치·박스를 읽어 core의 판독기로 자리→숫자를 얻은 뒤 `value`의 자릿수 순서로 버튼을 누른다.
   * 판독이 하나라도 애매하면 keypad_unresolved — 아무것도 누르지 않는다
   */
  | { readonly kind: 'keypad_sprite'; readonly ref: Ref; readonly keySelector: string; readonly cellSelector: string; readonly resolver: KeypadResolver; readonly value: string }
  | { readonly kind: 'click'; readonly ref: Ref }
  | { readonly kind: 'select'; readonly ref: Ref; readonly option: string }
  /** 요소가 보이도록 스크롤 (FWL-061). 페이지가 아니라 그 요소를 품은 스크롤 컨테이너를 움직인다 — 모달·사이드패널 안에서도 듣는다 */
  | { readonly kind: 'scroll'; readonly ref: Ref }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'wait'; readonly ref: Ref; readonly timeoutMs: number };

/** `role`은 대상 요소의 role — 감사 로그 재구성용이다. navigate처럼 요소가 없는 동작엔 없다 (FWL-030) */
export type ActionResult = { readonly url: string; readonly role?: string };

/** 세션 타겟의 현재 상태. 값이 아니라 위치·구조 정보만 담는다 */
export type TargetStatus = {
  readonly url: string;
  /** 컨텍스트에 열린 페이지 목록 (팝업 포함 여부는 어댑터 구현에 따른다). 브라우저 타겟만 낸다 */
  readonly pages?: ReadonlyArray<PageInfo>;
  /** 현재 스냅샷 세대. 이 세대의 ref만 유효하다 */
  readonly snapshotGen: number;
};

/** 세션 시작 시 확정되는 것들 — 어댑터는 이걸로 프로필을 고르고 그 origin의 로그인 세션만 주입한다. 자기 kind가 아닌 프로필은 거부한다 */
export type OpenOptions = LaunchProfile & { readonly origin: string };

export interface ActionTarget {
  readonly name: string;

  /**
   * 세션별 격리 컨텍스트를 연다. 프로필을 못 띄우면 browser_unavailable.
   * storedLogin: 이 origin의 저장 로그인 컨텍스트를 주입했는가 (FWL-046) — 만료됐을 수 있으니 힌트일 뿐이다
   */
  open(sessionId: SessionId, opts: OpenOptions): Promise<{ readonly storedLogin: boolean }>;
  /**
   * 세션 컨텍스트를 닫는다.
   * `persist=true`일 때만 storageState 재저장 (에이전트가 loggedIn을 단언한 정상 종료). 기본 false
   */
  close(sessionId: SessionId, opts?: { readonly persist?: boolean }): Promise<void>;

  /**
   * 대상 요소가 속한 **프레임의** origin. 최상위 페이지가 아니다 (3.1).
   *
   * 카드 필드는 보통 PG사 cross-origin iframe 안에 있다. 최상위로 검사하면
   * 정상 결제가 거부되거나, 페이지가 삽입한 임의 iframe에 값을 넣어도 통과한다.
   */
  originOf(sessionId: SessionId, ref: Ref): Promise<string>;

  /** 값이 제거된 스냅샷. 브랜디드 타입이 규칙 1을 강제한다. opts는 출력 범위만 줄인다 (FWL-043) */
  snapshot(sessionId: SessionId, opts?: SnapshotOptions): Promise<SafeSnapshot>;

  /** 셀렉터로 표시 텍스트 하나를 읽는다. 핸들러에는 이 경로가 없다 — 통합 테스트의 오라클이다 */
  extract(sessionId: SessionId, selector: string): Promise<string | null>;

  /** 현재 URL·페이지 수·스냅샷 세대 — 세션 이어받기용 상태 조회 */
  status(sessionId: SessionId): Promise<TargetStatus>;

  /**
   * status().pages의 index 페이지를 현재 페이지로 (FWL-043). 없거나 닫힌 index면 stale_ref — 목록을 다시 읽으면 된다.
   * 다음 새 페이지가 열리면 auto-follow가 다시 이긴다
   */
  switchPage(sessionId: SessionId, index: number): Promise<void>;

  act(sessionId: SessionId, intent: Intent): Promise<ActionResult>;
}
