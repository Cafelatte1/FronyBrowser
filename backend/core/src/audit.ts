/**
 * append-only 감사 로그 (9.1). 메타데이터만 기록한다.
 *
 * 값은 물론 해시도 넣지 않는다 — 짧은 값은 역산된다.
 * 예외 객체를 그대로 싣는 것도 금지다 (규칙 5).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuditEvent =
  | 'session_begin' | 'session_end'
  | 'fill' | 'click' | 'select' | 'navigate' | 'page_switch'
  /**
   * 액션이 실패했다 (FWL-030). 세션을 나중에 재구성하려면 실패 지점도 남아야 한다.
   * 필드: kind('session_begin'|'navigate'|'click'|'fill'|'select'|'scroll'|'wait'|'page_tree'|'page_image'), ref?, code(호출자에게 돌려준 에러 코드).
   * kind가 'session_begin'이면 profile과 reason('not_installed'|'launch_failed')이 붙는다 (FWL-063) —
   * 호출자에게는 안 나가는 분류값이고, 운영자가 무엇을 고쳐야 하는지 아는 유일한 단서다.
   * fill 실패는 key만 남긴다 — len은 없다 (규칙 5)
   */
  | 'action_failed'
  /** 스냅샷을 읽었다 (FWL-030). 필드: generation, pages */
  | 'page_tree'
  /** 화면을 한 장 찍었다 (FWL-062). 필드: w, h, masked(덮은 입력창 수). 이미지 바이트는 남기지 않는다 (규칙 5) */
  | 'page_image'
  /** 요소가 보이도록 스크롤했다 (FWL-061). 필드: ref, role */
  | 'scroll'
  /** 요소 대기가 끝났다 (FWL-030). 필드: ref, timeoutMs */
  | 'wait'
  | 'policy_denied' | 'grant_denied'
  | 'approval_created' | 'approval_granted' | 'approval_denied' | 'approval_expired'
  | 'scrub_hit'
  | 'vault_unlock' | 'vault_lock' | 'vault_set' | 'vault_rm'
  /** 다음 프로세스로 unlock을 인계했다 (FWL-042). 필드: ok, remainingMs. 패스프레이즈는 없다 */
  | 'vault_handoff'
  /** 관리 UI에서 Test Mode 토글을 바꿨다 (FWL-035/056). 필드: on, held. 이벤트 이름은 기록된 사실이라 옛 로그와 이어지도록 그대로 둔다 */
  | 'dry_run_set'
  /** 세션 종료 시 쿠키 재저장을 건너뜀 (FWL-025). 필드: host, reason */
  | 'storage_persist_skipped'
  | 'auth_failed' | 'gui_login' | 'keepalive'
  /**
   * 프로세스가 떴다 (FWL-065). 필드: pid.
   * 이 줄 위쪽에 session_end 없이 끝난 세션은 버려진 게 아니라 재시작에 죽은 것이다 — 그 구분이
   * 이 줄이 없으면 불가능하다 (실측 2026-09-13: 그런 세션이 61건 중 4건).
   */
  | 'server_start';

export type AuditRecord = {
  readonly evt: AuditEvent;
  readonly sid: string | null;
  readonly client: string | null;
  readonly traceId: string | null;
  readonly origin: string | null;
} & Record<string, unknown>;

export interface Audit {
  /** ts는 여기서 찍는다. 값이 들어올 수 있는 필드는 호출부가 걸러야 한다 */
  append(record: AuditRecord): void;
}

export function createAudit(path: string): Audit {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append(record) {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
      appendFileSync(path, `${line}\n`, 'utf8');
    },
  };
}

/** 테스트·드라이런용 — 디스크에 쓰지 않고 모은다 */
export function createMemoryAudit(): Audit & { readonly records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    append(record) {
      records.push(record);
    },
  };
}
