/**
 * 이 폴더가 곧 기능 화이트리스트다 (규칙 2).
 *
 * 파일 추가 = 능력 노출. 임의 JS 실행(evaluate), HTML 덤프, 콘솔·네트워크
 * 조회는 추가하지 않는다 — 스크러버는 평문 일치로 동작하므로 btoa(value)
 * 한 줄이면 egress 방어 전체가 무력화된다.
 */

export const HANDLERS = [
  'session_begin',
  'session_end',
  'snapshot',
  'fill',
  'click',
  'select',
  'navigate',
  'wait',
  'vault_list',
  'vault_unlock',   // admin 전용·MCP 미노출 (8.4)
  'vault_handoff',  // admin 전용·MCP 미노출 — 배포 재시작을 넘기는 unlock 인계 (FWL-042)
  'approval_wait',  // v2
] as const;

export type HandlerName = (typeof HANDLERS)[number];
