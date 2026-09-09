import { describe, expect, it } from 'vitest';
import { amountWithinExpectation, parseAmount } from '@wallet/core';

describe('금액 파싱 (9.4)', () => {
  it('통화 기호와 콤마를 걷어낸다', () => {
    expect(parseAmount('15,000원')).toBe(15000);
    expect(parseAmount('총 결제금액 152,000 원')).toBe(152000);
    expect(parseAmount('₩15,000')).toBe(15000);
  });

  it('숫자가 없거나 둘 이상이면 null — amount_fallback으로 넘긴다', () => {
    expect(parseAmount('결제금액')).toBeNull();
    expect(parseAmount('15,000원 (배송비 3,000원)')).toBeNull();
  });
});

describe('금액 대조 (9.4)', () => {
  it('상한 이하면 통과한다 — 쿠폰으로 싸지는 건 막지 않는다', () => {
    expect(amountWithinExpectation(12000, 16000, 0)).toBe(true);
  });

  it('tolerance만큼 초과를 흡수한다', () => {
    expect(amountWithinExpectation(16400, 16000, 0.03)).toBe(true);
    expect(amountWithinExpectation(17000, 16000, 0.03)).toBe(false);
  });

  it('선언값을 크게 넘으면 거부한다', () => {
    expect(amountWithinExpectation(152000, 16000, 0.03)).toBe(false);
  });
});

// ── 로더 (fail-closed) ─────────────────────────────────────────

import { checkFill, parsePolicy, policyRequiresGrant, PolicyError, launchProfileFor } from '@wallet/core';

const VALID = `
[defaults]
confirm = "never"

[keys."card.personal.number"]
type = "card"
allow_origins = ["https://pay.example-pg.com"]
require_selector = "input[autocomplete='cc-number']"

[keys."phone"]
type = "phone"
allow_origins = ["https://example-shop.com"]

[approval]
timeout = "5m"
wait_max = "90s"
recheck_before_act = true
amount_fallback = "deny"
amount_tolerance = "3%"
notify = ["page"]

[origins."https://example-shop.com"]
label = "Example Shop"
amount_selector = ".order-total .price"
`;

describe('policy 로더', () => {
  it('유효한 정책을 파싱하고 defaults를 병합한다', () => {
    const p = parsePolicy(VALID);
    const card = p.keys.get('card.personal.number')!;
    expect(card.confirm).toBe('never'); // defaults에서 상속
    expect(card.requireSelector).toContain('cc-number');
    expect(() => parsePolicy(`${VALID}
[keys."x"]
type="text"
allow_origins=["https://a.com"]
ttl="3m"
`)).toThrow(PolicyError); // 키별 ttl은 없다 — unlock TTL 하나
    expect(p.approval.amountTolerance).toBeCloseTo(0.03);
    expect(p.origins.get('https://example-shop.com')!.label).toBe('Example Shop');
    expect(p.origins.get('https://example-shop.com')).toMatchObject({ kind: 'browser', browser: 'chromium', headless: true }); // 기본
  });

  it('origins.browser — chromium|chrome만, 그 외는 기동 거부', () => {
    const p = parsePolicy(VALID + '\n[origins."https://bot.example"]\nlabel="b"\nbrowser="chrome"\n');
    expect(p.origins.get('https://bot.example')!.browser).toBe('chrome');
    expect(() => parsePolicy(VALID + '\n[origins."https://bot.example"]\nlabel="b"\nbrowser="firefox"\n'))
      .toThrow(PolicyError);
  });

  it('origins.kind — 기본 browser, 다른 kind에는 browser/headless를 못 쓴다 (FWL-037)', () => {
    const p = parsePolicy(VALID + '\n[origins."https://stub.example"]\nlabel="s"\nkind="stub"\n');
    expect(p.origins.get('https://stub.example')!.kind).toBe('stub');
    expect(launchProfileFor(p, 'https://stub.example')).toEqual({ kind: 'stub' });
    expect(launchProfileFor(p, 'https://nowhere.example')).toEqual({ kind: 'browser', browser: 'chromium', headless: true });
    expect(() => parsePolicy(VALID + '\n[origins."https://stub.example"]\nlabel="s"\nkind="stub"\nheadless=false\n')).toThrow(/kind = "browser"/);
    expect(() => parsePolicy(VALID + '\n[origins."https://stub.example"]\nlabel="s"\nkind="Stub!"\n')).toThrow(/kind/);
  });

  it('origins.headless — boolean만, 그 외는 기동 거부', () => {
    const p = parsePolicy(VALID + '\n[origins."https://bot.example"]\nlabel="b"\nheadless=false\n');
    expect(p.origins.get('https://bot.example')!.headless).toBe(false);
    expect(() => parsePolicy(VALID + '\n[origins."https://bot.example"]\nlabel="b"\nheadless="no"\n'))
      .toThrow(PolicyError);
  });

  it('알 수 없는 필드는 기동 거부 — 오타가 조용히 무시되면 금고가 열린다', () => {
    expect(() => parsePolicy(VALID + '\n[keys."x"]\ntype="text"\nallow_origin=["https://a.com"]\n'))
      .toThrow(PolicyError);
  });

  it('allow_origins가 비면 보관만 — 어느 origin에도 못 넣고, 배열이 아니면 거부 ("전체 허용"은 없다)', () => {
    const p = parsePolicy('[keys."x"]\ntype="text"\nallow_origins=[]\n');
    expect(p.keys.get('x')?.allowOrigins).toEqual([]);
    expect(checkFill(p, 'x', 'https://a.com')).toEqual({ allowed: false, rule: 'origin' });
    expect(() => parsePolicy('[keys."x"]\ntype="text"\n')).toThrow(PolicyError);
    expect(() => parsePolicy('[keys."x"]\ntype="text"\nallow_origins="https://a.com"\n')).toThrow(PolicyError);
  });

  it('와일드카드·경로 붙은 origin은 거부', () => {
    expect(() => parsePolicy('[keys."x"]\ntype="text"\nallow_origins=["https://*.shop.com"]\n'))
      .toThrow(/와일드카드/);
    expect(() => parsePolicy('[keys."x"]\ntype="text"\nallow_origins=["https://a.com/pay"]\n'))
      .toThrow(/정확한 origin/);
  });

  it('require_grant — boolean만, 기본 false (FWL-022)', () => {
    const p = parsePolicy(`${VALID}
[keys."example-shop.payment.pinnumber"]
type="text"
allow_origins=["https://www.example-shop.com"]
require_grant=true
`);
    expect(p.keys.get('example-shop.payment.pinnumber')!.requireGrant).toBe(true);
    expect(p.keys.get('phone')!.requireGrant).toBe(false); // 기본은 grant 없이 채운다
    expect(() => parsePolicy(`${VALID}
[keys."x"]
type="text"
allow_origins=["https://a.com"]
require_grant="yes"
`))
      .toThrow(PolicyError);
  });

  it('policyRequiresGrant — require_grant 키가 하나라도 있으면 true (FRONY_GRANT_KEY 기동 강제)', () => {
    expect(policyRequiresGrant(parsePolicy(VALID))).toBe(false);
    expect(policyRequiresGrant(parsePolicy(`${VALID}
[keys."x"]
type="text"
allow_origins=["https://a.com"]
require_grant=true
`))).toBe(true);
  });

  it('input_mode — keypad는 {digit} 셀렉터와 짝이어야 한다 (FWL-033)', () => {
    const key = (body: string) => `${VALID}
[keys."pin"]
type="text"
allow_origins=["https://a.com"]
${body}
`;
    const p = parsePolicy(key('input_mode="keypad"\nkeypad_digit_selector="img[aria-label=\'{digit}\']"'));
    expect(p.keys.get('pin')).toMatchObject({
      inputMode: 'keypad',
      keypadDigitSelector: "img[aria-label='{digit}']",
    });
    expect(p.keys.get('phone')!.inputMode).toBe('text'); // 기본
    expect(p.keys.get('phone')!.keypadDigitSelector).toBeUndefined();

    expect(() => parsePolicy(key('input_mode="tap"'))).toThrow(PolicyError);
    // 셀렉터 없는 keypad는 채울 방법이 없다 — 결제 단계에서 막히기 전에 기동에서 막는다
    expect(() => parsePolicy(key('input_mode="keypad"'))).toThrow(PolicyError);
    expect(() => parsePolicy(key('input_mode="keypad"\nkeypad_digit_selector="img.kpd"'))).toThrow(/digit/);
    // text 키에 붙은 셀렉터는 오타다 — 조용히 무시하지 않는다
    expect(() => parsePolicy(key('keypad_digit_selector="img[aria-label=\'{digit}\']"'))).toThrow(PolicyError);
  });

  it('keypad_digit_resolver — 스프라이트 키패드는 버튼·셀 셀렉터와 짝이다 (FWL-038)', () => {
    const key = (body: string) => `${VALID}
[keys."pin"]
type="text"
allow_origins=["https://a.com"]
${body}
`;
    const sprite = 'input_mode="keypad"\nkeypad_digit_resolver="sprite-template"\nkeypad_key_selector="a.pad-key"\nkeypad_cell_selector="span[class^=pad-pos-]"';
    expect(parsePolicy(key(sprite)).keys.get('pin')).toMatchObject({
      inputMode: 'keypad',
      keypadSprite: { keySelector: 'a.pad-key', cellSelector: 'span[class^=pad-pos-]', resolver: 'sprite-template' },
    });
    expect(parsePolicy(key(sprite)).keys.get('pin')!.keypadDigitSelector).toBeUndefined();
    // 모르는 판독기·셀렉터 누락·숫자 셀렉터와 혼용·text 모드 — 전부 기동 거부
    expect(() => parsePolicy(key(sprite.replace('sprite-template', 'ocr')))).toThrow(PolicyError);
    expect(() => parsePolicy(key('input_mode="keypad"\nkeypad_digit_resolver="sprite-template"\nkeypad_key_selector="a"'))).toThrow(PolicyError);
    expect(() => parsePolicy(key(`${sprite}\nkeypad_digit_selector="img[aria-label='{digit}']"`))).toThrow(PolicyError);
    expect(() => parsePolicy(key('input_mode="keypad"\nkeypad_digit_selector="i[aria-label=\'{digit}\']"\nkeypad_key_selector="a"'))).toThrow(PolicyError);
    expect(() => parsePolicy(key('keypad_key_selector="a.pad-key"'))).toThrow(PolicyError);
  });

  it('config/policy.example.toml이 파싱된다', async () => {
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(new URL('../../../../config/policy.example.toml', import.meta.url), 'utf8');
    expect(() => parsePolicy(toml)).not.toThrow();
    // 결제 비밀번호 키는 grant 없이 열리지 않는다 (규칙 13)
    for (const key of ['example-shop.payment.pinnumber']) {
      expect(parsePolicy(toml).keys.get(key)?.requireGrant, key).toBe(true);
    }
    // 결제 비밀번호는 보안 키패드다 — 서버가 숫자 버튼을 누른다 (FWL-033)
    expect(parsePolicy(toml).keys.get('example-shop.payment.pinnumber')).toMatchObject({
      inputMode: 'keypad',
      keypadDigitSelector: "img[role='button'][aria-label='{digit}']",
    });
  });
});

describe('checkFill', () => {
  const p = parsePolicy(VALID);

  it('허용 origin이면 통과', () => {
    expect(checkFill(p, 'phone', 'https://example-shop.com').allowed).toBe(true);
  });

  it('없는 키와 허용 안 된 origin을 구분해 돌려준다 (내부 판정용 — 응답에선 구분 금지)', () => {
    expect(checkFill(p, 'nope', 'https://example-shop.com')).toEqual({ allowed: false, rule: 'unknown_key' });
    expect(checkFill(p, 'phone', 'https://evil.com')).toEqual({ allowed: false, rule: 'origin' });
  });

  it('프레임 origin 기준 — 카드 키는 쇼핑몰 origin에서 거부된다', () => {
    expect(checkFill(p, 'card.personal.number', 'https://example-shop.com'))
      .toEqual({ allowed: false, rule: 'origin' });
    expect(checkFill(p, 'card.personal.number', 'https://pay.example-pg.com').allowed).toBe(true);
  });
});
