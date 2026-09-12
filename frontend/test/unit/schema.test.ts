/**
 * 프론트 스키마 자체의 규칙 — 키 이름·타입·마스킹과 입력 형식 검사.
 *
 * backend 코드는 import하지 않는다 (규칙 12).
 */

import { describe, expect, it } from 'vitest';
import { CUSTOM_BLURB, EXTRA_KEY, SECTIONS, checkFields, groupOf, isSecretKey, type FieldDef } from '../../src/schema.js';
import { fmtRemain } from '../../src/format.js';

const VALUE_TYPES = new Set(['card', 'phone', 'rrn', 'email', 'name', 'address', 'text']);

describe('스키마 자체', () => {
  it('섹션 키는 중복 없고 타입은 서버 화이트리스트 안이다', () => {
    const all = SECTIONS.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(all).size).toBe(all.length);
    for (const f of SECTIONS.flatMap((s) => s.fields)) expect(VALUE_TYPES.has(f.type), f.key).toBe(true);
  });

  it('마스킹은 CVV·카드 비밀번호뿐이다', () => {
    const secret = SECTIONS.flatMap((s) => s.fields).filter((f) => f.secret).map((f) => f.key).sort();
    expect(secret).toEqual(['card.personal.cvv', 'card.personal.password2']);
  });

  it('설명 문구는 2026-09-11 디자인 문구다 — 서버 정책이 출처를 고른다는 말은 없다', () => {
    const blurb = (id: string): string => SECTIONS.find((s) => s.id === id)!.blurb;
    expect(blurb('card')).toBe("These go into the payment gateway's own frame, never the shop's page. CVV and the card password stay masked as you type.");
    expect(blurb('personal')).toBe('Values leave this page only as a write. What comes back is a name, a type and a length — never the value, not to this page and not to an agent.');
    expect(CUSTOM_BLURB).toBe('Keys you added yourself. A key marked grant is filled only when the calling service hands over a pay grant for the session.');
    for (const text of [...SECTIONS.map((s) => s.blurb), CUSTOM_BLURB]) expect(text).not.toContain('policy');
  });

  it('기타 키 규칙은 범위.항목 / 범위.인스턴스.항목 두 형태만 통과시킨다', () => {
    expect(EXTRA_KEY.test('example-shop.payment.pinnumber')).toBe(true);
    expect(EXTRA_KEY.test('profile.address')).toBe(true);
    for (const bad of ['memo', 'a.b.c.d', 'A.B.C', 'a..c', 'a.b.c ', 'a.']) expect(EXTRA_KEY.test(bad), bad).toBe(false);
  });
});

// ── 입력 형식 검사 — 각 항목의 hint가 약속한 형식을 실제로 강제하는지.
// 형식이 흐트러지면 서버 스크러버가 만드는 변형과 안 맞아 값이 새어 나갈 수 있다.

const field = (key: string): FieldDef => {
  const f = SECTIONS.flatMap((s) => s.fields).find((x) => x.key === key);
  if (!f) throw new Error(`no field ${key}`);
  return f;
};
const ok = (key: string, value: string) => expect(checkFields([{ field: field(key), value }]), `${key}=${value}`).toEqual([]);
const bad = (key: string, value: string) => expect(checkFields([{ field: field(key), value }]).length, `${key}=${value}`).toBe(1);

describe('형식 검사', () => {
  it('날짜는 YYYY-MM-DD, 달·일 범위 안', () => {
    for (const k of ['passport.issue', 'passport.expiry']) {
      ok(k, '1990-01-31'); bad(k, '19900131'); bad(k, '1990-13-01'); bad(k, '1990-01-32');
    }
  });

  it('주민등록번호는 6-7 하이픈 포함', () => {
    ok('profile.rrn', '900101-1234567'); bad('profile.rrn', '9001011234567'); bad('profile.rrn', '900101-123456');
  });

  it('휴대폰은 010-0000-0000 형태 (3자리 국번도 허용)', () => {
    ok('profile.phone', '010-1234-5678'); ok('profile.phone', '011-123-4567');
    bad('profile.phone', '01012345678'); bad('profile.phone', '+82 10-1234-5678');
  });

  it('이메일은 @와 도메인', () => {
    ok('profile.email', 'a@b.co'); bad('profile.email', 'a@b'); bad('profile.email', 'ab.co');
  });

  it('카드번호는 4-4-4-4, 유효기간 MM/YY, CVV 3자리, 비번 2자리', () => {
    ok('card.personal.number', '1234-5678-9012-3456'); bad('card.personal.number', '1234567890123456');
    ok('card.personal.expiry', '12/27'); bad('card.personal.expiry', '13/27'); bad('card.personal.expiry', '1227');
    ok('card.personal.cvv', '123'); bad('card.personal.cvv', '12');
    ok('card.personal.password2', '12'); bad('card.personal.password2', '123');
  });

  it('여권번호는 구형·신형 둘 다, 영문 이름은 대문자 단어', () => {
    ok('passport.number', 'M12345678'); ok('passport.number', 'M123A4567'); bad('passport.number', 'm12345678');
    ok('passport.surname', 'HONG'); bad('passport.surname', 'Hong'); bad('passport.surname', 'HONG GIL');
    ok('passport.givenname', 'GILDONG'); ok('passport.givenname', 'GIL DONG'); bad('passport.givenname', 'Gildong'); bad('passport.givenname', 'GIL  DONG');
  });

  it('여러 항목 중 틀린 것만 안내 문구로 모은다', () => {
    const r = checkFields([
      { field: field('profile.phone'), value: '010-1234-5678' },
      { field: field('profile.email'), value: 'nope' },
      { field: field('profile.carrier'), value: 'SKT' }, // pattern 없음 — 항상 통과
    ]);
    expect(r).toEqual(['Email (name@example.com)']);
  });
});

describe('기타 키 그룹', () => {
  it('첫 세그먼트가 그룹, 마지막 세그먼트가 password·pin이면 마스킹', () => {
    expect(groupOf('example-shop.login.id')).toBe('example-shop');
    expect(isSecretKey('example-shop.login.password')).toBe(true);
    expect(isSecretKey('example-shop.payment.pinnumber')).toBe(true);
    expect(isSecretKey('example-shop.login.id')).toBe(false);
  });
});

describe('fmtRemain — 남은 unlock 시간 표시', () => {
  it('일·시간·분 단위로 줄여 보인다', () => {
    expect(fmtRemain(4316 * 60_000)).toBe('2d 23h');
    expect(fmtRemain(2 * 1440 * 60_000)).toBe('2d');
    expect(fmtRemain(185 * 60_000)).toBe('3h 5m');
    expect(fmtRemain(12 * 60_000)).toBe('12m');
    expect(fmtRemain(0)).toBe('0m');
  });
});
