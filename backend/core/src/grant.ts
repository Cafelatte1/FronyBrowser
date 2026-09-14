/**
 * pay grant 검증 (FWL-022).
 *
 * 볼트에서 grant 플래그가 켜진 키(결제 비밀번호처럼 되돌릴 수 없는 행위의 열쇠)는 이 토큰 없이 채우지 않는다.
 * 발급자는 호출 서비스(구매 판단을 가진 쪽), 검증자는 wallet의 fill이다. 두 서버는 대칭키
 * (`FRONY_GRANT_KEY`)만 공유하고 서로를 호출하지 않는다.
 *
 * 토큰 형식 (계약: docs/pay-grant.md — 발급자와 글자 단위로 같아야 한다):
 *   pg1.<payloadSeg>.<sigSeg>
 *   payloadSeg = base64url(패딩 없음) of UTF-8 JSON PayGrantPayload
 *   sigSeg     = base64url(패딩 없음) of HMAC-SHA256(key = 비밀 문자열 UTF-8, msg = payloadSeg ASCII)
 *
 * 방어는 세 겹이다 — 서명(위조), exp 5분(재사용 창), 세션 바인딩 + used(1회용).
 * 판정은 전부 fail-closed다. 토큰 자체는 감사 로그에 남기지 않는다 (규칙 5).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type PayGrantPayload = {
  v: 1;
  /** 발급자의 상관 id — 감사 대조용. 의미는 발급자가 정한다 */
  txn_id: string;
  /** wallet이 발급한 sessionId. 다른 세션에서 재생하면 거부된다 */
  session_id: string;
  iat: number;
  /** iat + 300 */
  exp: number;
};

export type GrantRejection = 'malformed' | 'bad_signature' | 'expired' | 'session_mismatch' | 'reused';

export type GrantVerdict =
  | { readonly ok: true; readonly payload: PayGrantPayload }
  | { readonly ok: false; readonly reason: GrantRejection };

export type GrantContext = {
  readonly sessionId: string;
  readonly nowMs: number;
  /**
   * 이미 쓴 토큰. 검증은 여기에 추가하지 않는다 — 호출자가 **행위가 성공한 뒤에**
   * `markGrantUsed`로 표시한다. 검증 시점에 태우면 실패한 fill 하나가 grant를 태워버린다 (FWL-033)
   */
  readonly used: Set<string>;
};

/** 행위가 성공한 뒤에만 부른다. 이 시점부터 같은 토큰은 reused다 */
export function markGrantUsed(used: Set<string>, token: string): void {
  used.add(token);
}

function parsePayload(payloadSeg: string): PayGrantPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p['v'] !== 1) return null;
  if (typeof p['txn_id'] !== 'string' || typeof p['session_id'] !== 'string') return null;
  for (const f of ['iat', 'exp']) {
    if (!Number.isInteger(p[f])) return null;
  }
  // 모르는 필드는 무시한다 (FWL-072) — 발급자가 자기 감사용으로 실어 보내는 값(예: 금액 상한)은 서명 안에 있으니
  // 위조는 못 하고, wallet은 FWL-055 이후 금액을 판단하지 않으므로 읽을 이유도 없다. 발급자를 상거래에 묶지 않는다
  return {
    v: 1,
    txn_id: p['txn_id'],
    session_id: p['session_id'],
    iat: p['iat'] as number,
    exp: p['exp'] as number,
  };
}

export function verifyPayGrant(token: string, key: string, ctx: GrantContext): GrantVerdict {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [prefix, payloadSeg, sigSeg] = parts as [string, string, string];
  if (prefix !== 'pg1') return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', key).update(payloadSeg, 'ascii').digest();
  const actual = Buffer.from(sigSeg, 'base64url');
  // 길이가 다르면 timingSafeEqual이 던진다 — 길이 불일치도 서명 실패로 본다
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const payload = parsePayload(payloadSeg);
  if (!payload) return { ok: false, reason: 'malformed' };
  if (payload.exp * 1000 <= ctx.nowMs) return { ok: false, reason: 'expired' };
  if (payload.session_id !== ctx.sessionId) return { ok: false, reason: 'session_mismatch' };
  if (ctx.used.has(token)) return { ok: false, reason: 'reused' };

  return { ok: true, payload };
}
