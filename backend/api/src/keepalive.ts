/**
 * 세션 keepalive — 시딩된 origin을 주기 방문해 로그인 세션을 무인 연장한다.
 *
 * 로그인 세션은 방문 시 사이트가 연장해 주는 경우가 대부분이라, 열었다
 * 닫기만 해도 사람 개입 없이 세션이 유지된다. 재로그인 시도는 하지 않는다 —
 * CAPTCHA·봇탐지를 건드릴 수 있는 흐름은 만들지 않는다.
 *
 * 기존 handlers 경로를 내부 클라이언트로 그대로 탄다: begin에서 리스 획득(사용자
 * 세션과 충돌하면 스킵), 감사 기록, 종료 시 갱신 쿠키 재저장(FWL-013)이
 * 전부 같은 규칙으로 적용된다.
 */

import { existsSync, readdirSync } from 'node:fs';
import type { Audit, Vault } from '@wallet/core';
import type { Caller, Handlers } from './handlers/impl.js';

const KEEPALIVE_CALLER: Caller = { client: 'keepalive' };

/** 시딩 파일명(host 슬러그) → 방문 URL. `127.0.0.1_8080` 같은 포트 슬러그 복원 */
export function seededHosts(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.dpapi'))
    .map((f) => f.slice(0, -'.dpapi'.length).replace(/_(\d+)$/, ':$1'));
}

export type KeepaliveDeps = {
  readonly handlers: Handlers;
  readonly vault: Vault;
  readonly audit: Audit;
  readonly sessionsDir: string;
  /** 테스트용 — 기본 https */
  readonly originFor?: (host: string) => string;
};

export async function runKeepaliveOnce(deps: KeepaliveDeps): Promise<void> {
  if (deps.vault.locked) return; // 패스프레이즈 없이는 storageState를 못 푼다 — 조용히 스킵

  const originFor = deps.originFor ?? ((host: string) => `https://${host}`);
  for (const host of seededHosts(deps.sessionsDir)) {
    const origin = originFor(host);
    // 세션 = origin 하나 — 리스 충돌은 여기서 lease_conflict로 끝난다
    const begun = await deps.handlers.session_begin(KEEPALIVE_CALLER, { origin });
    if (!begun.ok) {
      deps.audit.append({
        evt: 'keepalive', sid: null, client: 'keepalive', traceId: null, origin, ok: false,
        code: begun.error.code,
      });
      continue;
    }
    const nav = await deps.handlers.navigate(KEEPALIVE_CALLER, begun.sessionId, `${origin}/`);
    deps.audit.append({
      evt: 'keepalive', sid: begun.sessionId, client: 'keepalive', traceId: null, origin,
      ok: nav.ok, ...(nav.ok ? {} : { code: nav.error.code }),
    });
    // 홈 진입이 성공했을 때만 갱신 쿠키를 재저장한다 (FWL-026). 축소는 persist 가드가 한 번 더 막는다 (FWL-025)
    await deps.handlers.session_end(KEEPALIVE_CALLER, begun.sessionId, nav.ok);
  }
}

/** 주기 실행 시작. 반환값을 호출하면 멈춘다 */
export function startKeepalive(deps: KeepaliveDeps, intervalMs: number): () => void {
  const timer = setInterval(() => {
    runKeepaliveOnce(deps).catch(() => {
      // 개별 origin 실패는 안에서 감사로 남는다 — 루프 자체는 죽지 않는다
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
