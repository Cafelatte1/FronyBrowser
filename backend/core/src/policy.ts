/**
 * 정책. 서버 측에만 존재하며 호출자가 뒤집을 수 없다 (규칙 7).
 *
 * 호출자(에이전트 기기)가 침해됐을 때 피해를 제한하는 것이 이 모듈이므로,
 * 호출자에게 policy.toml 쓰기 권한을 주지 않는다.
 *
 * 해석은 전부 fail-closed다. 알 수 없는 필드나 파싱 실패는 기동 거부다 —
 * 오타 난 필드가 조용히 무시되어 금고가 열리는 일이 없어야 한다.
 */

import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { KeypadResolver } from './keypad-sprite.js';
import type { BrowserProfile, LaunchProfile, TargetKind } from './types.js';
import type { ValueType } from './variants.js';

export type KeyPolicy = {
  readonly type: ValueType;
  /** 정확 일치. 와일드카드 미지원 — 서브도메인 하나만 탈취돼도 전체가 열린다 */
  readonly allowOrigins: ReadonlyArray<string>;
  readonly confirm: 'never' | 'session' | 'always';
  /** 키별 TTL은 없다 — 값의 수명은 금고 unlock TTL(WALLET_UNLOCK_TTL) 하나로 정한다 (2026-09-02 decided) */
  readonly requireSelector?: string;
  /** true면 fill에 grant 발급자의 pay grant가 필요하다 (FWL-022, 규칙 13). 기본 false */
  readonly requireGrant: boolean;
  /**
   * 'text'(기본)는 요소에 값을 직접 채운다. 'keypad'는 보안 키패드 — <input>이 없고
   * 숫자 버튼 클릭이 곧 입력이라, 서버가 자릿수마다 버튼을 눌러 채운다 (FWL-033)
   */
  readonly inputMode: 'text' | 'keypad';
  /** keypad 모드에서 `keypadSprite`가 없으면 필수. `{digit}` 자리에 숫자를 넣어 버튼을 찾는 CSS 셀렉터 */
  readonly keypadDigitSelector?: string;
  /**
   * 숫자가 DOM에 없는 스프라이트 키패드 (FWL-038). 버튼(`keySelector`)마다 그 안의 셀(`cellSelector`)의
   * computed 배경 스프라이트와 위치를 읽어 서버가 자리→숫자를 판독한 뒤 버튼을 누른다
   */
  readonly keypadSprite?: { readonly keySelector: string; readonly cellSelector: string; readonly resolver: KeypadResolver };
};

export type OriginPolicy = {
  readonly label: string;
  readonly amountSelector?: string;
  /** 세션이 붙는 타겟 종류. 기본 'browser' (FWL-037). 등록되지 않은 kind는 createHandlers가 기동을 거부한다 */
  readonly kind: TargetKind;
  /** 이 origin 세션을 띄울 브라우저. 기본 chromium (kind가 browser일 때만 의미 있다) */
  readonly browser: BrowserProfile;
  /** 기본 true. false는 화면이 있는 환경에서만 뜬다 (봇탐지가 센 사이트용) */
  readonly headless: boolean;
};

const BROWSER_PROFILES: ReadonlyArray<BrowserProfile> = ['chromium', 'chrome'];

/** origin에 정책이 없으면 기본 프로필(browser · chromium headless) — 정책 항목은 대조·라벨용이라 필수가 아니다 */
export function launchProfileFor(policy: Policy, origin: string): LaunchProfile {
  const o = policy.origins.get(origin);
  const kind = o?.kind ?? 'browser';
  if (kind !== 'browser') return { kind };
  return { kind, browser: o?.browser ?? 'chromium', headless: o?.headless ?? true };
}

export type ApprovalPolicy = {
  readonly timeoutMs: number;
  readonly waitMaxMs: number;
  readonly recheckBeforeAct: boolean;
  readonly amountFallback: 'deny' | 'confirm';
  readonly amountTolerance: number;
  readonly notify: ReadonlyArray<string>;
};

export type Policy = {
  readonly keys: ReadonlyMap<string, KeyPolicy>;
  readonly origins: ReadonlyMap<string, OriginPolicy>;
  readonly approval: ApprovalPolicy;
};

export class PolicyError extends Error {
  constructor(message: string) {
    super(`policy: ${message}`);
  }
}

// ── 파서 유틸 (전부 fail-closed) ─────────────────────────────

const VALUE_TYPES: ReadonlySet<string> = new Set([
  'card', 'phone', 'rrn', 'email', 'name', 'address', 'text',
]);
const CONFIRM = new Set(['never', 'session', 'always']);
const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

export function parseDuration(raw: unknown, field: string): number {
  if (typeof raw !== 'string') throw new PolicyError(`${field}: duration 문자열이어야 함`);
  const m = raw.match(DURATION);
  if (!m) throw new PolicyError(`${field}: "10m"/"90s" 형식이어야 함 (받음: "${raw}")`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

export function parsePercent(raw: unknown, field: string): number {
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?%$/.test(raw)) {
    throw new PolicyError(`${field}: "3%" 형식이어야 함`);
  }
  return Number(raw.slice(0, -1)) / 100;
}

function assertOrigin(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new PolicyError(`${field}: 문자열이어야 함`);
  if (raw.includes('*')) throw new PolicyError(`${field}: 와일드카드 미지원 ("${raw}")`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PolicyError(`${field}: origin이 아님 ("${raw}")`);
  }
  if (url.origin !== raw) {
    throw new PolicyError(`${field}: 경로 없는 정확한 origin이어야 함 ("${raw}" ≠ "${url.origin}")`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PolicyError(`${field}: http(s)만 허용 ("${raw}")`);
  }
  return raw;
}

function record(raw: unknown, field: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyError(`${field}: 테이블이어야 함`);
  }
  return raw as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: ReadonlyArray<string>, where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new PolicyError(`${where}: 알 수 없는 필드 "${k}" — 기동 거부`);
  }
}

// ── 로더 ─────────────────────────────────────────────────────

export function parsePolicy(toml: string): Policy {
  const root = record(parseToml(toml), '(root)');
  rejectUnknown(root, ['defaults', 'keys', 'origins', 'approval'], '(root)');

  const defaults = record(root['defaults'] ?? {}, 'defaults');
  rejectUnknown(defaults, ['confirm'], 'defaults');
  const defaultConfirm = (defaults['confirm'] ?? 'never') as string;
  if (!CONFIRM.has(defaultConfirm)) throw new PolicyError('defaults.confirm: never|session|always');

  const keys = new Map<string, KeyPolicy>();
  for (const [name, rawKey] of Object.entries(record(root['keys'] ?? {}, 'keys'))) {
    const k = record(rawKey, `keys.${name}`);
    rejectUnknown(
      k,
      ['type', 'allow_origins', 'confirm', 'require_selector', 'require_grant', 'input_mode', 'keypad_digit_selector', 'keypad_digit_resolver', 'keypad_key_selector', 'keypad_cell_selector'],
      `keys.${name}`,
    );

    const type = k['type'];
    if (typeof type !== 'string' || !VALUE_TYPES.has(type)) {
      throw new PolicyError(`keys.${name}.type: 필수, ${[...VALUE_TYPES].join('|')}`);
    }
    // 빈 배열은 "보관만" — 금고에 등록하고 목록에 보이지만 어느 origin에도 넣지 못한다 (2026-09-06 decided:
    // 아직 넣을 사이트가 없는 값도 정책이 단일 기준이 되게 한다). "전체 허용"은 여전히 없다
    const origins = k['allow_origins'];
    if (!Array.isArray(origins)) {
      throw new PolicyError(`keys.${name}.allow_origins: 배열 필수 — 빈 배열은 보관만, "전체 허용"은 없다`);
    }
    const confirm = (k['confirm'] ?? defaultConfirm) as string;
    if (!CONFIRM.has(confirm)) throw new PolicyError(`keys.${name}.confirm: never|session|always`);
    const requireSelector = k['require_selector'];
    if (requireSelector !== undefined && typeof requireSelector !== 'string') {
      throw new PolicyError(`keys.${name}.require_selector: 문자열이어야 함`);
    }
    const requireGrant = k['require_grant'] ?? false;
    if (typeof requireGrant !== 'boolean') throw new PolicyError(`keys.${name}.require_grant: boolean`);

    // 보안 키패드 키는 셀렉터가 있어야만 채울 수 있다 — 없는 채로 기동하면 결제 단계에서 막힌다
    const inputMode = k['input_mode'] ?? 'text';
    if (inputMode !== 'text' && inputMode !== 'keypad') {
      throw new PolicyError(`keys.${name}.input_mode: text|keypad`);
    }
    const keypadDigitSelector = k['keypad_digit_selector'];
    const resolver = k['keypad_digit_resolver'];
    const keySelector = k['keypad_key_selector'];
    const cellSelector = k['keypad_cell_selector'];
    let keypadSprite: KeyPolicy['keypadSprite'];
    if (inputMode === 'keypad') {
      if (resolver !== undefined) {
        // 스프라이트 키패드 — 숫자 셀렉터 대신 버튼·셀 셀렉터와 판독기 (FWL-038)
        if (resolver !== 'sprite-template') throw new PolicyError(`keys.${name}.keypad_digit_resolver: "sprite-template"만 지원`);
        if (typeof keySelector !== 'string' || typeof cellSelector !== 'string') {
          throw new PolicyError(`keys.${name}: keypad_digit_resolver에는 keypad_key_selector·keypad_cell_selector 문자열이 필요`);
        }
        if (keypadDigitSelector !== undefined) {
          throw new PolicyError(`keys.${name}.keypad_digit_selector: keypad_digit_resolver와 같이 쓸 수 없다`);
        }
        keypadSprite = { keySelector, cellSelector, resolver };
      } else {
        if (typeof keypadDigitSelector !== 'string') {
          throw new PolicyError(`keys.${name}.keypad_digit_selector: input_mode="keypad"면 필수 문자열 (또는 keypad_digit_resolver)`);
        }
        if (!keypadDigitSelector.includes('{digit}')) {
          throw new PolicyError(`keys.${name}.keypad_digit_selector: "{digit}" 자리표시자가 있어야 함`);
        }
        if (keySelector !== undefined || cellSelector !== undefined) {
          throw new PolicyError(`keys.${name}: keypad_key_selector·keypad_cell_selector는 keypad_digit_resolver와 함께 쓴다`);
        }
      }
    } else if (keypadDigitSelector !== undefined || resolver !== undefined || keySelector !== undefined || cellSelector !== undefined) {
      throw new PolicyError(`keys.${name}: keypad_* 설정은 input_mode="keypad"에서만 쓴다`);
    }

    keys.set(name, {
      type: type as ValueType,
      allowOrigins: origins.map((o, i) => assertOrigin(o, `keys.${name}.allow_origins[${i}]`)),
      confirm: confirm as KeyPolicy['confirm'],
      requireGrant,
      inputMode,
      ...(typeof requireSelector === 'string' ? { requireSelector } : {}),
      ...(typeof keypadDigitSelector === 'string' ? { keypadDigitSelector } : {}),
      ...(keypadSprite !== undefined ? { keypadSprite } : {}),
    });
  }

  const origins = new Map<string, OriginPolicy>();
  for (const [origin, rawOrigin] of Object.entries(record(root['origins'] ?? {}, 'origins'))) {
    assertOrigin(origin, `origins."${origin}"`);
    const o = record(rawOrigin, `origins."${origin}"`);
    rejectUnknown(o, ['label', 'amount_selector', 'kind', 'browser', 'headless'], `origins."${origin}"`);
    const label = o['label'];
    if (typeof label !== 'string') throw new PolicyError(`origins."${origin}".label: 필수 문자열`);
    const amountSelector = o['amount_selector'];
    if (amountSelector !== undefined && typeof amountSelector !== 'string') {
      throw new PolicyError(`origins."${origin}".amount_selector: 문자열이어야 함`);
    }
    const kind = o['kind'] ?? 'browser';
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(kind)) {
      throw new PolicyError(`origins."${origin}".kind: 소문자 식별자여야 함`);
    }
    if (kind !== 'browser' && (o['browser'] !== undefined || o['headless'] !== undefined)) {
      throw new PolicyError(`origins."${origin}": browser/headless는 kind = "browser"에서만 쓴다`);
    }
    const browser = o['browser'] ?? 'chromium';
    if (!(BROWSER_PROFILES as readonly unknown[]).includes(browser)) {
      throw new PolicyError(`origins."${origin}".browser: ${BROWSER_PROFILES.join('|')}`);
    }
    const headless = o['headless'] ?? true;
    if (typeof headless !== 'boolean') throw new PolicyError(`origins."${origin}".headless: boolean`);
    origins.set(origin, {
      label,
      kind,
      browser: browser as BrowserProfile,
      headless,
      ...(typeof amountSelector === 'string' ? { amountSelector } : {}),
    });
  }

  const a = record(root['approval'] ?? {}, 'approval');
  rejectUnknown(
    a,
    ['timeout', 'wait_max', 'recheck_before_act', 'amount_fallback', 'amount_tolerance', 'notify'],
    'approval',
  );
  const amountFallback = (a['amount_fallback'] ?? 'deny') as string;
  if (amountFallback !== 'deny' && amountFallback !== 'confirm') {
    throw new PolicyError('approval.amount_fallback: deny|confirm');
  }
  const recheck = a['recheck_before_act'] ?? true;
  if (typeof recheck !== 'boolean') throw new PolicyError('approval.recheck_before_act: boolean');
  const notify = a['notify'] ?? ['page'];
  if (!Array.isArray(notify) || notify.some((n) => typeof n !== 'string')) {
    throw new PolicyError('approval.notify: 문자열 배열');
  }

  return {
    keys,
    origins,
    approval: {
      timeoutMs: a['timeout'] !== undefined ? parseDuration(a['timeout'], 'approval.timeout') : 5 * 60_000,
      waitMaxMs: a['wait_max'] !== undefined ? parseDuration(a['wait_max'], 'approval.wait_max') : 90_000,
      recheckBeforeAct: recheck,
      amountFallback,
      amountTolerance:
        a['amount_tolerance'] !== undefined ? parsePercent(a['amount_tolerance'], 'approval.amount_tolerance') : 0.03,
      notify: notify as string[],
    },
  };
}

export function loadPolicy(tomlPath: string): Policy {
  return parsePolicy(readFileSync(tomlPath, 'utf8'));
}

/** require_grant 키가 하나라도 있으면 서버는 FRONY_GRANT_KEY 없이 기동하지 않는다 (규칙 13) */
export function policyRequiresGrant(policy: Policy): boolean {
  for (const k of policy.keys.values()) if (k.requireGrant) return true;
  return false;
}

// ── 판정 ─────────────────────────────────────────────────────

export type FillCheck =
  | { readonly allowed: true; readonly policy: KeyPolicy }
  | { readonly allowed: false; readonly rule: 'unknown_key' | 'origin' | 'selector' };

/**
 * `frameOrigin`은 **fill 대상 요소가 속한 프레임의** origin이다 (규칙 4).
 * 호출자 인자가 아니라 브라우저 상태에서 읽은 값이어야 한다.
 *
 * selector 검사는 대상 요소 정보가 필요해 app 계층에서 수행한다 —
 * 여기서는 requireSelector 존재만 policy로 전달한다.
 */
export function checkFill(policy: Policy, key: string, frameOrigin: string): FillCheck {
  const k = policy.keys.get(key);
  if (!k) return { allowed: false, rule: 'unknown_key' };
  if (!k.allowOrigins.includes(frameOrigin)) return { allowed: false, rule: 'origin' };
  return { allowed: true, policy: k };
}

/**
 * 금액 파싱. KRW 가정 (9.4). 숫자가 없거나 둘 이상이면 null.
 *
 * 콤마는 자릿수 구분자이므로 제거한다 — 공백으로 바꾸면 하나의 금액이
 * 여러 숫자로 갈라져 멀쩡한 페이지가 amount_unavailable이 된다.
 */
export function parseAmount(text: string): number | null {
  const groups = text.replace(/,/g, '').match(/\d+/g);
  if (groups?.length !== 1) return null;
  const n = Number(groups[0]);
  return Number.isFinite(n) ? n : null;
}

/** `≤` 비교다. maxAmount는 상한이지 정확값이 아니다 */
export function amountWithinExpectation(
  observed: number,
  maxAmount: number,
  tolerance: number,
): boolean {
  return observed <= maxAmount * (1 + tolerance);
}
