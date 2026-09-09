/**
 * FronyAuth `POST /admin/verify` 위임 — 등록 페이지의 관리자 로그인.
 *
 * admin 자격과 로그인 락아웃(5회/15분, 주소 단위)은 FronyAuth가 소유한다.
 * 이 서버는 비밀번호를 저장·검증하지 않고 전달만 한다 (introspection.md).
 */

export type AdminVerdict =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly status: 401 | 429 | 503; readonly attemptsLeft?: number; readonly retryAfterSeconds?: number };

export type AdminVerifier = (username: string, password: string, clientAddr: string) => Promise<AdminVerdict>;

export type AdminVerifierOptions = {
  /** 예: http://<fronyauth-host>:8640/admin/verify */
  readonly url: string;
  /** FronyBrowser 자신의 서비스 키 — FronyAuth 호출 인증 (introspect와 동일) */
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
};

export function createAdminVerifier(opts: AdminVerifierOptions): AdminVerifier {
  const doFetch = opts.fetchImpl ?? fetch;

  return async (username, password, clientAddr) => {
    let res: Response;
    try {
      res = await doFetch(opts.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, client_addr: clientAddr }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      return { ok: false, status: 503 };
    }

    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after_seconds?: number };
      return {
        ok: false,
        status: 429,
        ...(typeof body.retry_after_seconds === 'number' ? { retryAfterSeconds: body.retry_after_seconds } : {}),
      };
    }
    if (!res.ok) return { ok: false, status: 503 };

    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; username?: string; attempts_left?: number }
      | null;
    if (body?.ok === true && typeof body.username === 'string') {
      return { ok: true, username: body.username };
    }
    return {
      ok: false,
      status: 401,
      ...(typeof body?.attempts_left === 'number' ? { attemptsLeft: body.attempts_left } : {}),
    };
  };
}
