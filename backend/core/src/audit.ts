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
   * 필드: kind('navigate'|'click'|'fill'|'select'|'wait'|'snapshot'), ref?, code(호출자에게 돌려준 에러 코드).
   * fill 실패는 key만 남긴다 — len은 없다 (규칙 5)
   */
  | 'action_failed'
  /** 스냅샷을 읽었다 (FWL-030). 필드: generation, pages */
  | 'snapshot'
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
  | 'auth_failed' | 'gui_login' | 'keepalive';

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
