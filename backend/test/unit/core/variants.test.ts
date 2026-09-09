/**
 * initial-plan §9.3 표가 이 파일의 명세다.
 *
 * 실제 사이트에서 새 표기 변형을 발견하면 여기에 케이스를 추가한다 —
 * 그것이 이 프로젝트의 주된 유지보수 활동이다.
 */

import { describe, expect, it } from 'vitest';
import { variants } from '@wallet/core';

describe('variants: card', () => {
  const v = variants('1111222233334444', 'card');

  it('원본·하이픈·공백', () => {
    expect(v).toContain('1111222233334444');
    expect(v).toContain('1111-2222-3333-4444');
    expect(v).toContain('1111 2222 3333 4444');
  });

  it('부분 노출·마스킹', () => {
    expect(v).toContain('111122******4444'); // 앞 6 + 뒤 4
    expect(v).toContain('****-****-****-4444');
  });

  it('뒤 4자리', () => {
    expect(v).toContain('4444');
  });

  it('구분자가 섞여 등록돼도 동일하게 동작', () => {
    expect(variants('1111-2222-3333-4444', 'card')).toContain('1111 2222 3333 4444');
  });
});

describe('variants: phone', () => {
  const v = variants('01012345678', 'phone');

  it('하이픈·공백', () => {
    expect(v).toContain('010-1234-5678');
    expect(v).toContain('010 1234 5678');
  });

  it('국가코드', () => {
    expect(v).toContain('+82 10-1234-5678');
    expect(v).toContain('+821012345678');
    expect(v).toContain('82-10-1234-5678');
  });

  it('앞 0 제거·부분 마스킹', () => {
    expect(v).toContain('1012345678');
    expect(v).toContain('010****5678');
    expect(v).toContain('010-****-5678');
  });

  it('URL 인코딩 — 하이픈까지 (%2D)', () => {
    expect(v).toContain('010%2D1234%2D5678');
    expect(v).toContain('%2B82%2010-1234-5678'); // encodeURIComponent 본
  });

  it('10자리(지역번호 없는 구형)도 3-3-4로 묶인다', () => {
    expect(variants('0111234567', 'phone')).toContain('011-123-4567');
  });
});

describe('variants: rrn', () => {
  const v = variants('8801011234567', 'rrn');

  it('하이픈·뒷자리 마스킹·앞 6자리', () => {
    expect(v).toContain('880101-1234567');
    expect(v).toContain('880101-1******');
    expect(v).toContain('880101');
  });
});

describe('variants: email', () => {
  const v = variants('Hong.Gil@Gmail.com', 'email');

  it('대소문자', () => {
    expect(v).toContain('hong.gil@gmail.com');
    expect(v).toContain('HONG.GIL@GMAIL.COM');
  });

  it('URL 인코딩 (%40)', () => {
    expect(v).toContain('Hong.Gil%40Gmail.com');
  });

  it('로컬파트 마스킹 — 원본·소문자 양쪽', () => {
    expect(v).toContain('Ho****@Gmail.com');
    expect(v).toContain('ho****@gmail.com');
  });
});

describe('variants: name', () => {
  const v = variants('홍길동', 'name');

  it('가운데 마스킹·성만 — 3자여도 * 포함이라 유지된다', () => {
    expect(v).toContain('홍*동');
    expect(v).toContain('홍**');
  });

  it('공백 제거', () => {
    expect(variants('홍 길동', 'name')).toContain('홍길동');
  });

  it('4자 이름', () => {
    const four = variants('남궁길동', 'name');
    expect(four).toContain('남**동');
    expect(four).toContain('남***');
  });
});

describe('variants: address', () => {
  it('줄바꿈→공백, 공백 정규화', () => {
    const v = variants('서울시 강남구\n테헤란로  123', 'address');
    expect(v).toContain('서울시 강남구 테헤란로  123');
    expect(v).toContain('서울시 강남구 테헤란로 123');
  });

  it('앞 절반 절단', () => {
    const v = variants('서울시 강남구 테헤란로 123', 'address');
    expect(v).toContain('서울시 강남구');
  });
});

describe('variants: text', () => {
  const v = variants('secret-value', 'text');

  it('base64 — btoa 우회 대응', () => {
    expect(v).toContain(Buffer.from('secret-value', 'utf8').toString('base64'));
  });

  it('URL 인코딩', () => {
    expect(v).toContain('secret%2Dvalue');
  });
});

describe('4바이트 미만 폐기 규칙', () => {
  it('짧은 ASCII 변형은 버린다', () => {
    for (const variant of variants('abc', 'text')) {
      expect(variant.includes('*') || Buffer.byteLength(variant, 'utf8') >= 4).toBe(true);
    }
  });

  it('한글 3자는 바이트 기준으로 살아남는다', () => {
    expect(variants('홍 길동', 'name')).toContain('홍길동');
  });
});
