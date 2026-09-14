/**
 * 정적 키 인증 (FWL-074) — FronyAuth 없이 돌리는 서버용.
 *
 * `WALLET_KEYS="<name>:<token>,<name>:<token>"`를 그대로 검증한다. 호출자 표기는 introspection과 같은 `key:<name>`이라
 * WALLET_ADMIN_CLIENTS와 감사 로그가 두 방식에서 같은 문자열을 본다. 발급·회수는 env를 고쳐 재시작하는 것이다 —
 * 그 이상(만료, OAuth, 원격 회수)이 필요하면 FronyAuth 모드다.
 * 등록 페이지 로그인도 같은 목록을 쓴다: username=이름, password=토큰, 그리고 그 `key:<name>`이 admin이어야 한다 —
 * 아무 키나 콘솔에 들어오면 에이전트 키가 제 grant 플래그를 지운다. 락아웃(5회/15분, 주소 단위)은 FronyAuth가 하던 것을
 * 여기서 한다: 콘솔 로그인이 토큰 추측 창구가 되면 안 된다.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Verifier } from './auth.js';
import type { AdminVerifier } from './auth-admin.js';

export type StaticKey = { readonly name: string; readonly token: string };

const KEY_NAME = /^[A-Za-z0-9_-]+$/;

/** `name:token,name:token`. 이름은 영숫자·하이픈·밑줄, 토큰은 비어 있지 않고 쉼표가 없다. 틀리면 이유를 담은 Error */
export function parseStaticKeys(raw: string): StaticKey[] {
  const out: StaticKey[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
    const i = entry.indexOf(':');
    const name = i >= 0 ? entry.slice(0, i).trim() : '';
    const token = i >= 0 ? entry.slice(i + 1).trim() : '';
    if (!KEY_NAME.test(name) || token.length === 0) throw new Error('WALLET_KEYS entries must be <name>:<token>, name of letters, digits, - or _');
    if (out.some((k) => k.name === name)) throw new Error(`WALLET_KEYS has the name twice: ${name}`);
    out.push({ name, token });
  }
  if (out.length === 0) throw new Error('WALLET_KEYS is set but holds no key');
  return out;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createStaticVerifier(keys: ReadonlyArray<StaticKey>): Verifier {
  return async (bearer) => {
    const k = keys.find((x) => same(x.token, bearer));
    return k ? { ok: true, client: `key:${k.name}` } : { ok: false, status: 401 };
  };
}

export type StaticAdminOptions = {
  readonly maxAttempts?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
};

export function createStaticAdminVerifier(keys: ReadonlyArray<StaticKey>, adminClients: ReadonlyArray<string>, opts: StaticAdminOptions = {}): AdminVerifier {
  const max = opts.maxAttempts ?? 5;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>(); // addr → 창 안의 실패 시각

  return async (username, password, clientAddr) => {
    const t = now();
    const recent = (failures.get(clientAddr) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= max) {
      failures.set(clientAddr, recent);
      return { ok: false, status: 429, retryAfterSeconds: Math.ceil(((recent[0] as number) + windowMs - t) / 1000) };
    }
    const k = keys.find((x) => x.name === username);
    // 이름이 없어도 토큰 비교는 한다 — 응답 시간으로 이름의 존재를 알리지 않는다
    const tokenOk = same(k?.token ?? '', password) && k !== undefined;
    if (!tokenOk || !adminClients.includes(`key:${k.name}`)) {
      recent.push(t);
      failures.set(clientAddr, recent);
      return { ok: false, status: 401, attemptsLeft: max - recent.length };
    }
    failures.delete(clientAddr);
    return { ok: true, username: k.name };
  };
}
