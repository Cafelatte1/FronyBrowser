/**
 * Test Mode 런타임 토글 (FWL-035, FWL-056).
 *
 * 켜져 있으면 볼트에서 grant 플래그가 켜진 키의 fill이 grant 검증·소모까지 평소대로 하고 실제 입력(타이핑·키패드
 * 클릭)만 건너뛴다 — 실결제 없이 재구매 E2E를 돌리는 스위치다. 응답은 실제 fill과 같고 감사로그
 * `dry: true`에만 드러난다. 주행 중인 에이전트가 알 수 없어야 하므로 /health에 싣지 않는다.
 *
 * held는 그와 반대로 드러난다 (FWL-056): 보류한 키의 fill은 key_held로 거부된다 — 빈 칸을 제출시키는 대신
 * 주행을 멈추라는 뜻이기 때문이다.
 *
 * 환경변수가 아니라 런타임 설정인 이유: 테스트마다 재시작하는 건 번거롭다 (2026-09-06 decided).
 * 데이터 디렉터리의 JSON 파일에 영속돼 재시작을 넘긴다.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TestMode {
  get(): boolean;
  /** 이 키는 Test Mode 주행에서 아예 채우지 않는다 — fill이 key_held로 거부된다 (FWL-056) */
  held(): ReadonlyArray<string>;
  set(on: boolean): void;
  setHeld(keys: ReadonlyArray<string>): void;
}

export type TestModeState = { readonly on: boolean; readonly held: ReadonlyArray<string> };

export function createTestMode(file: string): TestMode {
  let state = readTestModeFlag(file);
  function persist(): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ on: state.on, held: state.held }), 'utf8');
    renameSync(tmp, file);
  }
  return {
    get: () => state.on,
    held: () => state.held,
    set(next) {
      state = { on: next, held: state.held };
      persist();
    },
    setHeld(keys) {
      state = { on: state.on, held: [...keys] };
      persist();
    },
  };
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 파일이 없거나 깨졌으면 꺼진 것으로 본다 — Test Mode는 예외 모드라 기본은 "입력함"이다. 켜진 상태는 기동 로그·UI 배지·`wallet status`가 알린다 */
export function readTestModeFlag(file: string): TestModeState {
  const parsed = readJson(file);
  if (parsed !== null) {
    const held = parsed['held'];
    return {
      on: parsed['on'] === true,
      held: Array.isArray(held) ? held.filter((k): k is string => typeof k === 'string') : [],
    };
  }
  // 새 파일이 아직 없을 때만 이웃한 옛 파일을 한 번 읽는다 — 배포된 서버가 업그레이드에서 켜둔 상태를 잃지 않게 (FWL-056).
  // 옛 파일은 지우지 않는다; 다음 set이 새 파일을 쓰면 이 경로는 더 이상 타지 않는다
  const legacy = readJson(join(dirname(file), 'dry-run.json'));
  return { on: legacy?.['dryRun'] === true, held: [] };
}

/** 테스트용 — 디스크 없이 */
export function createMemoryTestMode(initial = false, initialHeld: ReadonlyArray<string> = []): TestMode {
  let on = initial;
  let heldKeys: ReadonlyArray<string> = [...initialHeld];
  return {
    get: () => on,
    held: () => heldKeys,
    set: (next) => { on = next; },
    setHeld: (keys) => { heldKeys = [...keys]; },
  };
}
