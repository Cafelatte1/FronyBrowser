/**
 * 승인 대기·토큰·만료 (v2).
 *
 * 승인은 wallet이 소유한다. MCP elicitation은 확인 경로를 모델 컨텍스트에
 * 태우고(인젝션당한 모델이 왜곡·대리응답 가능), 클라이언트 UI 지원이 보장되지
 * 않으며, 호출자 재시작 시 유실된다 (6절).
 *
 * 자동 승인 폴백은 존재하지 않는다 (규칙 9).
 */

import type { ApprovalWaitResponse } from './contract.js';
import type { ApprovalToken } from './types.js';

export type ApprovalRequest = {
  readonly token: ApprovalToken;
  readonly reason: string;
  /** 페이지에서 추출한 원문. 호출자가 준 텍스트를 싣지 않는다 (규칙 10) */
  readonly observed: string;
  readonly createdAt: number;
};

export interface ApprovalStore {
  create(reason: string, observed: string): ApprovalRequest;
  /** long-poll. waitMaxMs 초과 시 still_pending */
  wait(token: ApprovalToken, waitMaxMs: number): Promise<ApprovalWaitResponse>;
  /** api가 서빙하는 승인 페이지에서 사람이 호출한다 */
  settle(token: ApprovalToken, granted: boolean): void;
}

export function createApprovalStore(_opts: { timeoutMs: number }): ApprovalStore {
  // TODO(FWL-008): v2
  throw new Error('not implemented');
}
