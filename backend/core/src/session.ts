/**
 * 세션 발급·리스·TTL. 브라우저는 모른다.
 *
 * 세션 id는 서버가 발급한다 (규칙 8) — 호출자가 정하면 다른 호출자가
 * 추측·재사용해 남의 브라우저 세션에 올라탈 수 있다.
 *
 * 세션 = 타겟 origin 하나 (FWL-017). 리스는 begin에서 잡고 end/TTL에서 풀린다.
 * 같은 origin에 두 세션이 동시에 들어가지 않는다 (5절). 다른 클라이언트가 점유 중이면 즉시
 * lease_conflict — 대기열은 두지 않는다 (8.5). 같은 클라이언트의 세션이 쥐고 있으면 그 세션을
 * 끝내고 이어받는다 (FWL-036) — 에이전트가 죽어 sessionId를 잃은 세션이 TTL까지 origin을 막지 않게
 */

import { randomBytes } from 'node:crypto';
import type { SessionBeginRequest } from './contract.js';
import type { LaunchProfile, SessionId, TargetKind } from './types.js';

export type Session = {
  readonly id: SessionId;
  readonly client: string;
  readonly request: SessionBeginRequest;
  readonly createdAt: number;
  /** begin에서 확정된 타겟 origin. 이 세션이 배타 리스를 쥔 유일한 origin이다 */
  readonly origin: string;
  /** 세션이 붙은 타겟 종류 = profile.kind. 핸들러가 이걸로 ActionTarget을 고른다 (FWL-037) */
  readonly kind: TargetKind;
  /** begin에서 정책이 고른 기동 프로필. 브라우저 전용 필드는 이 안에만 있다 */
  readonly profile: LaunchProfile;
  /** 이 시각이 지나면 만료. touch로 연장된다 */
  readonly expiresAt: number;
};

export type SessionEndReason = 'normal' | 'ttl' | 'error' | 'replaced';

export type BeginResult =
  /** replaced: 같은 클라이언트가 쥐고 있던 이 origin의 이전 세션 — 스토어에서는 이미 빠졌고 호출자가 타겟을 닫는다 */
  | { readonly ok: true; readonly session: Session; readonly replaced?: Session }
  | { readonly ok: false; readonly code: 'session_limit' | 'lease_conflict' };

export interface SessionStore {
  /** req.origin의 리스를 여기서 잡는다. 다른 클라이언트가 점유 중이면 lease_conflict — 브라우저를 띄우기 전에 안다 */
  begin(client: string, req: SessionBeginRequest, profile: LaunchProfile): BeginResult;
  /** TTL이 지난 세션은 지워지고 undefined가 돌아온다 */
  get(id: SessionId): Session | undefined;
  /** 해당 클라이언트의 살아 있는 세션만 — 세션 경계는 여기서도 유지된다 */
  listByClient(client: string): ReadonlyArray<Session>;
  end(id: SessionId, reason: SessionEndReason): Session | undefined;
  /** 세션이 살아 움직인다는 신호 — TTL을 연장한다 (승인 대기 중 죽으면 안 된다) */
  touch(id: SessionId): void;
  /** 만료 스윕 — 닫힌 세션 정리 콜백(브라우저 컨텍스트 등)에 쓴다 */
  sweepExpired(): ReadonlyArray<Session>;
}

export type SessionStoreOptions = {
  readonly ttlMs: number;
  readonly maxConcurrent: number;
  readonly now?: () => number;
};

type MutableSession = Omit<Session, 'expiresAt'> & { expiresAt: number };

export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, MutableSession>();
  /** origin → 점유 중인 세션 id */
  const leases = new Map<string, string>();

  function drop(s: MutableSession): void {
    if (leases.get(s.origin) === s.id) leases.delete(s.origin);
    sessions.delete(s.id);
  }

  function alive(id: string): MutableSession | undefined {
    const s = sessions.get(id);
    if (!s) return undefined;
    if (now() >= s.expiresAt) {
      drop(s);
      return undefined;
    }
    return s;
  }

  return {
    begin(client, req, profile) {
      // 카운트 전에 만료분을 걷어낸다 — 죽은 세션이 자리를 차지하면 안 된다
      for (const s of [...sessions.values()]) void alive(s.id);
      const holder = leases.get(req.origin);
      const held = holder !== undefined ? alive(holder) : undefined;
      let replaced: Session | undefined;
      if (held) {
        if (held.client !== client) return { ok: false, code: 'lease_conflict' };
        drop(held); // 같은 클라이언트 — 이전 세션을 끝내고 이어받는다. 자리도 비워진 뒤 센다
        replaced = held;
      }
      if (sessions.size >= opts.maxConcurrent) return { ok: false, code: 'session_limit' };

      const id = `s_${randomBytes(16).toString('hex')}` as SessionId;
      const session: MutableSession = {
        id,
        client,
        request: req,
        createdAt: now(),
        origin: req.origin,
        kind: profile.kind,
        profile,
        expiresAt: now() + opts.ttlMs,
      };
      sessions.set(id, session);
      leases.set(req.origin, id);
      return replaced ? { ok: true, session, replaced } : { ok: true, session };
    },

    get(id) {
      return alive(id);
    },

    listByClient(client) {
      const out: Session[] = [];
      for (const s of [...sessions.values()]) {
        if (alive(s.id) && s.client === client) out.push(s);
      }
      return out;
    },

    end(id, _reason) {
      const s = sessions.get(id);
      if (!s) return undefined;
      drop(s);
      return s;
    },

    touch(id) {
      const s = alive(id);
      if (s) s.expiresAt = now() + opts.ttlMs;
    },

    sweepExpired() {
      const expired: Session[] = [];
      for (const s of [...sessions.values()]) {
        if (now() >= s.expiresAt) {
          expired.push(s);
          drop(s);
        }
      }
      return expired;
    },
  };
}
