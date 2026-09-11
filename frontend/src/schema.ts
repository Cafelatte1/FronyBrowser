/**
 * 등록 화면의 스키마 — 그룹·항목·입력 형식. DOM을 모른다 (테스트가 그대로 import한다).
 *
 * 키 이름은 서버 policy.toml의 [keys]와 맞아야 fill이 된다 — frontend/test/unit/schema.test가 대조한다.
 * backend 코드는 import하지 않는다 (규칙 12).
 */

export type FieldDef = {
  key: string; label: string; type: string;
  /** 입력 형식 안내 — pattern이 있으면 저장 전에 검사한다 */
  hint?: string; pattern?: RegExp; secret?: boolean;
  /** pay grant가 있어야만 입력되는 키 — 금고 항목에 그대로 저장된다 */
  grant?: boolean;
};
export type SectionDef = { id: string; title: string; blurb: string; fields: FieldDef[] };
export type KeyInfo = { name: string; type: string; len: number; grant: boolean };

export const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/**
 * 키 이름 규칙 (2026-09-06 decided): `범위.항목` (단일값) 또는 `범위.인스턴스.항목` (여러 개 가능).
 * 사이트 키는 범위=사이트, 인스턴스=용도 — example-shop.payment.pinnumber. 기타 등록도 이 두 형태만 받는다
 */
export const EXTRA_KEY = /^[a-z0-9-]+\.[a-z0-9-]+(\.[a-z0-9-]+)?$/;

export const SECTIONS: SectionDef[] = [
  {
    id: 'personal',
    title: 'Personal',
    blurb: 'Values leave this page only as a write. What comes back is a name, a type and a length — never the value, not to this page and not to an agent. Leave anything you would rather not provide empty.',
    fields: [
      { key: 'profile.rrn', label: 'Resident reg. no.', type: 'rrn', hint: '000000-0000000', pattern: /^\d{6}-\d{7}$/ },
      { key: 'profile.phone', label: 'Mobile', type: 'phone', hint: '010-0000-0000', pattern: /^01\d-\d{3,4}-\d{4}$/ },
      { key: 'profile.carrier', label: 'Carrier', type: 'text', hint: 'SKT / KT / LG U+' },
      { key: 'profile.email', label: 'Email', type: 'email', hint: 'name@example.com', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
      { key: 'profile.address', label: 'Home address', type: 'address', hint: 'Street + unit' },
    ],
  },
  {
    id: 'card',
    title: 'Card',
    blurb: "These four go into the payment gateway's own frame, not the shop's page. CVV and the card password are masked as you type; the rest stay plain so you can proofread them.",
    fields: [
      { key: 'card.personal.number', label: 'Card number', type: 'card', hint: '0000-0000-0000-0000', pattern: /^\d{4}-\d{4}-\d{4}-\d{4}$/ },
      { key: 'card.personal.expiry', label: 'Expiry', type: 'text', hint: 'MM/YY', pattern: /^(0[1-9]|1[0-2])\/\d{2}$/ },
      { key: 'card.personal.cvv', label: 'CVV', type: 'text', hint: '3 digits', pattern: /^\d{3}$/, secret: true },
      { key: 'card.personal.password2', label: 'Card password', type: 'text', hint: '2 digits', pattern: /^\d{2}$/, secret: true, grant: true },
    ],
  },
  {
    id: 'passport',
    title: 'Passport',
    blurb: "Latin fields must match the passport's printed spelling exactly — an airline form will reject a mismatch long after the agent has left the page.",
    fields: [
      { key: 'passport.number', label: 'Passport number', type: 'text', hint: 'M12345678', pattern: /^[A-Z]\d{3}[A-Z0-9]\d{4}$/ },
      { key: 'passport.surname', label: 'Surname (Latin)', type: 'name', hint: 'HONG', pattern: /^[A-Z]+$/ },
      { key: 'passport.givenname', label: 'Given names (Latin)', type: 'name', hint: 'GILDONG', pattern: /^[A-Z]+( [A-Z]+)*$/ },
      { key: 'passport.issue', label: 'Date of issue', type: 'text', hint: 'YYYY-MM-DD', pattern: DATE },
      { key: 'passport.expiry', label: 'Date of expiry', type: 'text', hint: 'YYYY-MM-DD', pattern: DATE },
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

/** 기타 키의 그룹 = 이름의 첫 세그먼트 (example-shop.login.id → example-shop) */
export function groupOf(name: string): string {
  return name.split('.')[0]!;
}

/** 기타 키 중 마지막 세그먼트가 비밀번호·PIN이면 입력을 마스킹한다 */
export function isSecretKey(name: string): boolean {
  return /(password|pin|pw)/.test(name.split('.').at(-1) ?? '');
}
