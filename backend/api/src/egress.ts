/**
 * 모든 응답이 통과하는 단일 지점 (규칙 3).
 *
 * 입구가 HTTP·MCP 둘이므로 어느 한쪽에 두면 다른 쪽이 스크러버를 우회한다.
 * HTTP 소비자라고 건너뛰지 않는다 — 그쪽이 응답을 자기 LLM에 먹일지
 * wallet은 알 수 없다.
 *
 * `ScrubbedResponse`를 만드는 코드는 이 파일의 `scrub()` 하나뿐이다.
 * 핸들러가 평범한 객체를 반환하면 컴파일이 실패한다.
 */

import type { Failure, Result, ScrubbedResponse, ScrubEntry } from '@wallet/core';
import { scrubDeep } from '@wallet/core';

export type EgressContext = {
  /** scrub_hit 감사 기록에 남길 핸들러 이름 (12절) */
  readonly handler: string;
  readonly url: string | null;
  /** live vault 값의 variants(). 잠긴 키는 목록에 없다 — 구조적 필터가 1차 방어인 이유 (11절) */
  readonly scrubEntries: ReadonlyArray<ScrubEntry>;
  readonly onScrubHit: (hit: { key: string; count: number; handler: string; url: string | null }) => void;
};

/**
 * 2단 파이프라인 (7.3).
 *
 * 1. 구조적 필터 — input/textarea의 value 제거. 값을 몰라도 동작한다
 * 2. 스크러버 — live vault 값 + variants() 평문 매칭
 *
 * 2단계 히트는 이상 신호가 아니다. 주된 경우는 사이트가 **자기가 이미 아는 사용자 정보**를
 * 화면에 그린 것이다 — 배송지의 이름·전화·주소, 로그인된 계정 아이디. 입력창이 아니라 본문
 * 텍스트라서 1단계는 여기서 지울 게 없고, 2단계가 유일한 방어다. 실측(2026-09-13): 감사
 * 레코드 1,183건 중 scrub_hit 172건, 전부 page_tree에서 나왔다. 0을 기대하지 말 것.
 */
export function scrub<T>(payload: Result<T>, ctx: EgressContext): ScrubbedResponse<Result<T>> {
  const { value, hits } = scrubDeep(payload, ctx.scrubEntries);

  for (const hit of hits) {
    ctx.onScrubHit({ key: hit.key, count: hit.count, handler: ctx.handler, url: ctx.url });
  }

  return value as ScrubbedResponse<Result<T>>;
}

/** 실패 응답도 예외 없이 통과시킨다 — 에러 메시지에 값이 섞일 수 있다 */
export function scrubFailure(failure: Failure, ctx: EgressContext): ScrubbedResponse<Failure> {
  return scrub(failure, ctx) as ScrubbedResponse<Failure>;
}
