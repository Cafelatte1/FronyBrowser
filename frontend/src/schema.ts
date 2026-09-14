/**
 * 등록 화면의 스키마 — 그룹·항목·입력 형식. DOM을 모른다 (테스트가 그대로 import한다).
 *
 * 키 이름은 호출 서비스의 플레이북이 참조하는 이름과 맞아야 한다 — 서버 정책은 없다 (FWL-055).
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
export type KeyInfo = { name: string; type: string; len: number; grant: boolean; label: string };

/** 스키마 밖 그룹(사용자가 만든 그룹)의 설명 — 패널 머리에 그대로 쓴다 */
export const CUSTOM_BLURB =
  'Keys you added yourself. A key marked grant is filled only when the calling service hands over a pay grant for the session.';

export const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/**
 * 키 이름 규칙 (2026-09-12 decided): `그룹.대상.항목` 세 조각 고정. 그룹은 콘솔 레일의 한 줄,
 * 대상은 그 그룹 안에서 어느 것인지 (card.personal / kurly.login), 항목이 값이다.
 * 조각 수가 화면의 구조와 같아야 키 하나가 곧 한 행이다.
 */
export const EXTRA_KEY = /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/;

export const SECTIONS: SectionDef[] = [
  {
    id: 'personal',
    title: 'Personal',
    blurb: 'Values leave this page only as a write. What comes back is a name, a type and a length — never the value, not to this page and not to an agent.',
    fields: [
      { key: 'profile.personal.rrn', label: 'Resident reg. no.', type: 'rrn', hint: '000000-0000000', pattern: /^\d{6}-\d{7}$/ },
      { key: 'profile.personal.phone', label: 'Mobile', type: 'phone', hint: '010-0000-0000', pattern: /^01\d-\d{3,4}-\d{4}$/ },
      { key: 'profile.personal.carrier', label: 'Carrier', type: 'text', hint: 'SKT / KT / LG U+' },
      { key: 'profile.personal.email', label: 'Email', type: 'email', hint: 'name@example.com', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
      { key: 'profile.personal.address', label: 'Home address', type: 'address', hint: 'Street + unit' },
    ],
  },
  {
    id: 'card',
    title: 'Card',
    blurb: "These go into the payment gateway's own frame, never the shop's page. CVV and the card password stay masked as you type.",
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
      { key: 'passport.personal.number', label: 'Passport number', type: 'text', hint: 'M12345678', pattern: /^[A-Z]\d{3}[A-Z0-9]\d{4}$/ },
      { key: 'passport.personal.surname', label: 'Surname (Latin)', type: 'name', hint: 'HONG', pattern: /^[A-Z]+$/ },
      { key: 'passport.personal.givenname', label: 'Given names (Latin)', type: 'name', hint: 'GILDONG', pattern: /^[A-Z]+( [A-Z]+)*$/ },
      { key: 'passport.personal.issue', label: 'Date of issue', type: 'text', hint: 'YYYY-MM-DD', pattern: DATE },
      { key: 'passport.personal.expiry', label: 'Date of expiry', type: 'text', hint: 'YYYY-MM-DD', pattern: DATE },
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
