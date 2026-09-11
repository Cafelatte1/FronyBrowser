/**
 * dry-run 런타임 토글 (FWL-035).
 *
 * 켜져 있으면 볼트에서 grant 플래그가 켜진 키의 fill이 grant 검증·소모까지 평소대로 하고 실제 입력(타이핑·키패드
 * 클릭)만 건너뛴다 — 실결제 없이 재구매 E2E를 돌리는 스위치다. 응답은 실제 fill과 같고 감사로그
 * `dry: true`에만 드러난다. 주행 중인 에이전트가 알 수 없어야 하므로 /health에 싣지 않는다.
 *
 * 환경변수가 아니라 런타임 설정인 이유: 테스트마다 재시작하는 건 번거롭다 (2026-09-06 decided).
 * 데이터 디렉터리의 JSON 파일에 영속돼 재시작을 넘긴다.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DryRun {
  get(): boolean;
  set(on: boolean): void;
}

export function createDryRun(file: string): DryRun {
  let on = readDryRunFlag(file);
  return {
    get: () => on,
    set(next) {
      on = next;
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ dryRun: next }), 'utf8');
      renameSync(tmp, file);
    },
  };
}

/** 파일이 없거나 깨졌으면 꺼진 것으로 본다 — dry-run은 예외 모드라 기본은 "입력함"이다. 켜진 상태는 기동 로그·UI 배지·`wallet status`가 알린다 */
export function readDryRunFlag(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dryRun?: unknown };
    return parsed.dryRun === true;
  } catch {
    return false;
  }
}

/** 테스트용 — 디스크 없이 */
export function createMemoryDryRun(initial = false): DryRun {
  let on = initial;
  return { get: () => on, set: (next) => { on = next; } };
}
