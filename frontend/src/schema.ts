/**
 * 등록 화면의 스키마 — 섹션·항목·입력 형식. DOM을 모른다 (테스트가 그대로 import한다).
 *
 * 키 이름은 서버 policy.toml의 [keys]와 맞아야 fill이 된다 — frontend/tests/unit/schema.test가 대조한다.
 * backend 코드는 import하지 않는다 (규칙 12).
 */

export type FieldDef = {
  key: string; label: string; type: string;
  /** 입력 형식 안내 — pattern이 있으면 저장 전에 검사한다 */
  hint?: string; pattern?: RegExp; secret?: boolean;
};
export type SectionDef = { title: string; fields: FieldDef[] };
export type KeyInfo = { name: string; type: string; len: number };

export const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/**
 * 키 이름 규칙 (2026-09-06 decided): `범위.항목` (단일값) 또는 `범위.인스턴스.항목` (여러 개 가능).
 * 사이트 키는 범위=사이트, 인스턴스=용도 — example-shop.payment.pinnumber. 기타 등록도 이 두 형태만 받는다
 */
export const EXTRA_KEY = /^[a-z0-9-]+\.[a-z0-9-]+(\.[a-z0-9-]+)?$/;

export const SECTIONS: SectionDef[] = [
  {
    title: '개인정보',
    fields: [
      { key: 'profile.rrn', label: '주민등록번호', type: 'rrn', hint: '000000-0000000', pattern: /^\d{6}-\d{7}$/ },
      { key: 'profile.phone', label: '휴대폰', type: 'phone', hint: '010-0000-0000', pattern: /^01\d-\d{3,4}-\d{4}$/ },
      { key: 'profile.carrier', label: '통신사', type: 'text', hint: 'SKT / KT / LG U+ / 알뜰폰' },
      { key: 'profile.email', label: '이메일', type: 'email', hint: 'name@example.com', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
      { key: 'profile.address', label: '집 주소', type: 'address', hint: '도로명 주소 + 상세' },
    ],
  },
  {
    title: '카드정보',
    fields: [
      { key: 'card.personal.number', label: '카드번호', type: 'card', hint: '0000-0000-0000-0000', pattern: /^\d{4}-\d{4}-\d{4}-\d{4}$/ },
      { key: 'card.personal.expiry', label: '유효기간', type: 'text', hint: 'MM/YY', pattern: /^(0[1-9]|1[0-2])\/\d{2}$/ },
      { key: 'card.personal.cvv', label: 'CVV', type: 'text', hint: '숫자 3자리', pattern: /^\d{3}$/, secret: true },
      { key: 'card.personal.password2', label: '카드 비밀번호 앞 2자리', type: 'text', hint: '숫자 2자리', pattern: /^\d{2}$/, secret: true },
    ],
  },
  {
    title: '여권정보',
    fields: [
      { key: 'passport.number', label: '여권번호', type: 'text', hint: 'M12345678 / M123A4567', pattern: /^[A-Z]\d{3}[A-Z0-9]\d{4}$/ },
      { key: 'passport.surname', label: '영문 성', type: 'name', hint: 'HONG (여권 표기 그대로)', pattern: /^[A-Z]+$/ },
      { key: 'passport.givenname', label: '영문 이름', type: 'name', hint: 'GILDONG (여권 표기 그대로)', pattern: /^[A-Z]+( [A-Z]+)*$/ },
      { key: 'passport.issue', label: '발급일', type: 'text', hint: 'YYYY-MM-DD', pattern: DATE },
      { key: 'passport.expiry', label: '만료일', type: 'text', hint: 'YYYY-MM-DD', pattern: DATE },
    ],
  },
];

export const SCHEMA_KEYS = new Set(SECTIONS.flatMap((s) => s.fields.map((f) => f.key)));

/** 형식이 틀린 항목의 안내 문구 목록. 비어 있으면 전부 통과 */
export function checkFields(items: ReadonlyArray<{ field: FieldDef; value: string }>): string[] {
  return items
    .filter(({ field, value }) => field.pattern && !field.pattern.test(value))
    .map(({ field }) => `${field.label} (${field.hint})`);
}
