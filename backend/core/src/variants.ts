/**
 * 값의 표기 변형 생성. 스크러버의 매칭 대상이 된다 (9.3).
 *
 * 페이지는 입력한 값을 원본 그대로 보여주지 않는다. 여기서 놓치는 변형이
 * 곧 유출이므로, 실제 사이트에서 새 표기를 발견할 때마다 케이스를 추가한다.
 * `variants.test.ts`가 이 모듈의 명세다.
 */

export type ValueType = 'card' | 'phone' | 'rrn' | 'email' | 'name' | 'address' | 'text';

/**
 * 4바이트(UTF-8) 미만 변형은 버린다 — 짧은 ASCII 조각은 오탐이 너무 많다.
 * 바이트 기준인 이유: 규칙의 목적이 오탐 방지인데, 한글 3자(`홍길동` = 9바이트)는
 * 특이도가 높아 버리면 안 된다. `*` 마스킹 포함 변형도 같은 이유로 예외다.
 */
export const MIN_VARIANT_BYTES = 4;

/** 4자리씩 구분자로 묶는다 (카드) */
function group4(digits: string, sep: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, `$1${sep}`);
}

/** 휴대폰 자리수별 구분 (11자리 3-4-4, 10자리 3-3-4) */
function phoneGroups(digits: string): [string, string, string] | null {
  if (digits.length === 11) return [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7)];
  if (digits.length === 10) return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  return null;
}

function cardVariants(digits: string, out: Set<string>): void {
  out.add(group4(digits, '-'));
  out.add(group4(digits, ' '));
  if (digits.length >= 10) {
    const last4 = digits.slice(-4);
    out.add(`${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${last4}`);
    out.add(`****-****-****-${last4}`);
    out.add(last4); // 4자 규칙의 명시적 예외 (9.3)
  }
}

function phoneVariants(digits: string, out: Set<string>): void {
  const g = phoneGroups(digits);
  if (g) {
    const [a, b, c] = g;
    out.add(`${a}-${b}-${c}`);
    out.add(`${a} ${b} ${c}`);
    out.add(`${a}****${c}`);
    out.add(`${a}-****-${c}`);
  }
  if (digits.startsWith('0')) {
    const noZero = digits.slice(1); // 1012345678
    out.add(noZero);
    out.add(`+82${noZero}`);
    const ng = phoneGroups(digits);
    if (ng) {
      const [a, b, c] = ng;
      const rest = `${a.slice(1)}-${b}-${c}`; // 10-1234-5678
      out.add(`+82 ${rest}`);
      out.add(`+82-${rest}`);
      out.add(`82-${rest}`);
    }
  }
}

function rrnVariants(digits: string, out: Set<string>): void {
  if (digits.length !== 13) return;
  const front = digits.slice(0, 6);
  const back = digits.slice(6);
  out.add(`${front}-${back}`);
  out.add(`${front}-${back[0]}${'*'.repeat(6)}`);
  out.add(front);
}

function maskedEmail(value: string): string | null {
  const at = value.indexOf('@');
  if (at <= 0) return null;
  const local = value.slice(0, at);
  const keep = Math.min(2, local.length - 1) || 1;
  return `${local.slice(0, keep)}****${value.slice(at)}`;
}

function emailVariants(value: string, out: Set<string>): void {
  for (const form of [value, value.toLowerCase(), value.toUpperCase()]) {
    out.add(form);
    const masked = maskedEmail(form);
    if (masked) out.add(masked);
  }
}

function nameVariants(value: string, out: Set<string>): void {
  const compact = value.replace(/\s+/g, '');
  out.add(compact);
  if (compact.length >= 3) {
    out.add(`${compact[0]}${'*'.repeat(compact.length - 2)}${compact[compact.length - 1]}`);
  }
  if (compact.length >= 2) {
    out.add(`${compact[0]}${'*'.repeat(compact.length - 1)}`); // 성만
  }
}

function addressVariants(value: string, out: Set<string>): void {
  const oneLine = value.replace(/\r?\n/g, ' ');
  const normalized = oneLine.replace(/\s+/g, ' ').trim();
  out.add(oneLine);
  out.add(normalized);
  const half = normalized.slice(0, Math.ceil(normalized.length / 2)).trim();
  out.add(half); // 상세주소 절단 — 페이지가 앞부분만 노출하는 경우
}

function textVariants(value: string, out: Set<string>): void {
  out.add(Buffer.from(value, 'utf8').toString('base64'));
}

/** 비영숫자 전부를 UTF-8 바이트 단위 %XX로 인코딩 */
function strictUrlEncode(s: string): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function variants(value: string, type: ValueType): ReadonlySet<string> {
  const out = new Set<string>([value]);
  const digits = value.replace(/\D/g, ''); // 금고 값에 구분자가 섞여 있어도 동작
  if (digits.length > 0 && (type === 'card' || type === 'phone' || type === 'rrn')) {
    out.add(digits);
  }

  switch (type) {
    case 'card':
      cardVariants(digits, out);
      break;
    case 'phone':
      phoneVariants(digits, out);
      break;
    case 'rrn':
      rrnVariants(digits, out);
      break;
    case 'email':
      emailVariants(value, out);
      break;
    case 'name':
      nameVariants(value, out);
      break;
    case 'address':
      addressVariants(value, out);
      break;
    case 'text':
      textVariants(value, out);
      break;
  }

  // 공통: 모든 변형의 URL 인코딩본. 인코딩이 무의미한(동일한) 것은 Set이 흡수한다.
  // encodeURIComponent는 하이픈을 안 바꾸므로(010-1234... 그대로), 비영숫자 전부를
  // %XX로 바꾸는 strict 본도 함께 넣는다 (`010%2D1234%2D5678` 표기 대응, 7.4)
  for (const v of [...out]) {
    out.add(encodeURIComponent(v));
    out.add(strictUrlEncode(v));
  }

  for (const v of out) {
    if (Buffer.byteLength(v, 'utf8') >= MIN_VARIANT_BYTES) continue;
    if (v.includes('*')) continue;
    out.delete(v);
  }
  return out;
}
