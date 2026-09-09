/**
 * egress 2단계(평문 매칭)의 명세. 규칙 3의 회귀 테스트다.
 */

import { describe, expect, it } from 'vitest';
import { scrubDeep, toScrubEntry } from '@wallet/core';

const card = toScrubEntry('card.number', '1111222233334444', 'card');
const phone = toScrubEntry('phone', '01012345678', 'phone');

describe('scrubDeep', () => {
  it('원본·변형을 [REDACTED:key]로 치환하고 키별 히트를 센다', () => {
    const { value, hits } = scrubDeep(
      { text: '카드 1111-2222-3333-4444 로 결제, 연락처 010-1234-5678' },
      [card, phone],
    );
    expect(value.text).toBe('카드 [REDACTED:card.number] 로 결제, 연락처 [REDACTED:phone]');
    expect(hits).toContainEqual({ key: 'card.number', count: 1 });
    expect(hits).toContainEqual({ key: 'phone', count: 1 });
  });

  it('중첩 객체·배열·객체 키까지 훑는다', () => {
    const { value } = scrubDeep(
      {
        rows: [{ note: '주문자 01012345678' }],
        '01012345678': 'ok', // 키에 실린 값도 유출이다
      },
      [phone],
    );
    expect(value.rows[0]?.note).toBe('주문자 [REDACTED:phone]');
    expect(Object.keys(value)).toContain('[REDACTED:phone]');
  });

  it('긴 패턴 우선 — 뒤 4자리가 전체 카드번호 매칭을 가리지 않는다', () => {
    const { value, hits } = scrubDeep({ t: '카드번호 1111222233334444 끝' }, [card]);
    expect(value.t).toBe('카드번호 [REDACTED:card.number] 끝');
    expect(hits).toEqual([{ key: 'card.number', count: 1 }]);
  });

  it('부분 마스킹 표기도 잡는다', () => {
    const { value } = scrubDeep({ t: '등록된 카드: ****-****-****-4444' }, [card]);
    expect(value.t).toBe('등록된 카드: [REDACTED:card.number]');
  });

  it('히트 0이 정상 — 무관한 페이로드는 그대로 통과한다', () => {
    const payload = { ok: true, list: ['안전한 텍스트', 42], nested: { n: null } };
    const { value, hits } = scrubDeep(payload, [card, phone]);
    expect(value).toEqual(payload);
    expect(hits).toEqual([]);
  });

  it('같은 값이 여러 번 나오면 전부 치환하고 횟수를 센다', () => {
    const { value, hits } = scrubDeep({ t: '01012345678 / 010-1234-5678 / 1012345678' }, [phone]);
    expect(value.t).not.toMatch(/\d{7}/);
    expect(hits[0]?.count).toBe(3);
  });

  it('스크럽 후 페이로드 어디에도 원본 숫자열이 남지 않는다', () => {
    const dirty = {
      a: '결제 1111 2222 3333 4444 완료',
      b: ['안내: +82 10-1234-5678', { c: '카드 111122******4444' }],
    };
    const { value } = scrubDeep(dirty, [card, phone]);
    const flat = JSON.stringify(value);
    expect(flat).not.toContain('4444'); // [REDACTED:...] 외 어떤 형태로도 없음
    expect(flat).not.toContain('5678');
    expect(flat).not.toContain('1234');
  });
});
