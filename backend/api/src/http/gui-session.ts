/**
 * 등록 페이지 로그인 세션 (wsess_). 서버 발급·in-memory·단기 TTL.
 *
 * 기기 API 키를 브라우저에 입력하지 않기 위한 장치다 — FronyAuth admin
 * 로그인을 통과한 브라우저에만 짧은 토큰을 준다. 재시작하면 전부 소멸한다.
 */

import { randomBytes } from 'node:crypto';

export type GuiSessions = {
  issue(username: string): string;
  /** 유효하면 username, 아니면 null. 사용 시 TTL을 연장하지 않는다 */
  check(token: string): string | null;
};

export function createGuiSessions(opts: { ttlMs?: number; now?: () => number } = {}): GuiSessions {
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, { username: string; expiresAt: number }>();

  return {
    issue(username) {
      // 만료분 정리 — 방치된 브라우저 토큰이 무한히 쌓이지 않게
      for (const [t, s] of sessions) if (now() >= s.expiresAt) sessions.delete(t);
      const token = `wsess_${randomBytes(24).toString('hex')}`;
      sessions.set(token, { username, expiresAt: now() + ttlMs });
      return token;
    },
    check(token) {
      const s = sessions.get(token);
      if (!s) return null;
      if (now() >= s.expiresAt) {
        sessions.delete(token);
        return null;
      }
      return s.username;
    },
  };
}
