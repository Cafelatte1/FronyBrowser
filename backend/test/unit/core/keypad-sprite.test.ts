/**
 * 스프라이트 키패드 판독 (FWL-038) — 실측 스프라이트 두 장으로 교차 검증한다.
 * sprite-1이 템플릿의 출처이고, sprite-2는 다른 세션에서 잡은 배치라 "템플릿이 세션을 넘어 맞는가"를 본다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { SPRITE_KEYPAD_GLYPHS, KeypadUnresolvedError, cropGlyph, decodePng, resolveKeypadSprite } from '@wallet/core';
import type { SpriteCell } from '@wallet/core';

const fixture = (name: string) => readFileSync(resolve(__dirname, '../../fixtures', name));
const SPRITE_1 = fixture('sprite-keypad-1.png');
const SPRITE_2 = fixture('sprite-keypad-2.png');

/** 실측 격자: 4×3, 셀 25×26, 자리 0–3 첫 줄 · 4–7 둘째 줄 · 8–9 셋째 줄 */
const GRID: SpriteCell[] = Array.from({ length: 10 }, (_, i) => ({ x: (i % 4) * 25, y: Math.floor(i / 4) * 26, w: 25, h: 26 }));

describe('resolveKeypadSprite — 스프라이트 글리프 템플릿', () => {
  it('sprite-1(템플릿 출처)은 8 0 3 5 / 7 4 2 6 / 1 9', () => {
    expect(resolveKeypadSprite(SPRITE_1, GRID).join('')).toBe('8035742619');
  });

  it('sprite-2(다른 세션)는 7 3 0 8 / 4 9 6 2 / 5 1 — 템플릿이 세션을 넘어 바이트 단위로 맞는다', () => {
    expect(resolveKeypadSprite(SPRITE_2, GRID).join('')).toBe('7308496251');
  });

  it('템플릿 파일은 sprite-1에서 잘라낸 것과 같다 — 생성 파일이 손으로 바뀌면 여기서 걸린다', () => {
    const png = decodePng(SPRITE_1);
    const order = '8035742619';
    for (let i = 0; i < 10; i++) {
      expect(cropGlyph(png, GRID[i] as SpriteCell)).toEqual(SPRITE_KEYPAD_GLYPHS[order[i] as string]);
    }
  });

  it('셀 박스가 실제보다 커도(여백 포함) bbox crop이 같은 글리프를 낸다', () => {
    const loose = GRID.map((c) => ({ x: c.x - 1, y: c.y - 1, w: c.w + 2, h: c.h + 2 }));
    // 이웃 셀 글리프가 번지지 않는 한도에서 — 실측 스프라이트는 셀 사이에 투명 여백이 있다
    expect(resolveKeypadSprite(SPRITE_2, loose).join('')).toBe('7308496251');
  });
});

describe('resolveKeypadSprite — fail-closed', () => {
  const tamper = (px: [number, number]): Buffer => {
    const png = PNG.sync.read(SPRITE_2);
    const i = (px[1] * png.width + px[0]) * 4;
    png.data[i] = 0; // 글리프 안 픽셀 하나의 R을 바꾼다 — 근사 매칭이었다면 통과했을 차이
    return PNG.sync.write(png);
  };

  it('글리프 한 픽셀만 달라도 no_match — 어떤 숫자도 추정하지 않는다', () => {
    // sprite-2 첫 셀(숫자 7)의 글리프 안쪽 픽셀을 찾아 건드린다
    const png = decodePng(SPRITE_2);
    let hit: [number, number] | null = null;
    for (let y = 0; y < 26 && !hit; y++) for (let x = 0; x < 25 && !hit; x++) if (png.data[(y * png.width + x) * 4 + 3] === 255) hit = [x, y];
    if (!hit) throw new Error('glyph pixel not found');
    expect(() => resolveKeypadSprite(tamper(hit), GRID)).toThrow(KeypadUnresolvedError);
    expect(() => resolveKeypadSprite(tamper(hit), GRID)).toThrow(/no_match/);
  });

  it('같은 숫자가 두 번 나오면 duplicate', () => {
    const dup = [...GRID.slice(0, 9), GRID[0] as SpriteCell];
    expect(() => resolveKeypadSprite(SPRITE_2, dup)).toThrow(/duplicate/);
  });

  it('셀이 10개가 아니면 cell_count, 빈 셀은 no_match, PNG가 아니면 bad_png', () => {
    expect(() => resolveKeypadSprite(SPRITE_2, GRID.slice(0, 9))).toThrow(/cell_count/);
    const blank = [...GRID.slice(0, 9), { x: 50, y: 52, w: 25, h: 26 }]; // 셋째 줄 셋째 칸은 비어 있다
    expect(() => resolveKeypadSprite(SPRITE_2, blank)).toThrow(/no_match/);
    expect(() => resolveKeypadSprite(Buffer.from('nope'), GRID)).toThrow(/bad_png/);
  });
});
