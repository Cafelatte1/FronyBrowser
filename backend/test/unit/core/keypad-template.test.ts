/** 스프라이트 키패드 글리프 템플릿의 생성·파일 왕복 (FWL-073) — 내장 템플릿과 같은 것을 운영자가 만들 수 있어야 한다 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SpriteCell } from '@wallet/core';
import { KeypadUnresolvedError, SPRITE_KEYPAD_GLYPHS, buildGlyphSet, parseGlyphSet, readGlyphTemplate, resolveKeypadSprite } from '@wallet/core';

const fixture = (name: string) => readFileSync(resolve(__dirname, '../../fixtures', name));
const SPRITE_1 = fixture('sprite-keypad-1.png');
const SPRITE_2 = fixture('sprite-keypad-2.png');
const GRID: SpriteCell[] = Array.from({ length: 10 }, (_, i) => ({ x: (i % 4) * 25, y: Math.floor(i / 4) * 26, w: 25, h: 26 }));
const ORDER = '8035742619';

const dir = mkdtempSync(join(tmpdir(), 'wallet-keypad-template-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('keypad template', () => {
  it('buildGlyphSet은 sprite-1에서 내장 템플릿과 같은 것을 만든다 — 생성기가 곧 내장 템플릿의 출처다', () => {
    expect(buildGlyphSet(SPRITE_1, GRID, ORDER)).toEqual(SPRITE_KEYPAD_GLYPHS);
  });

  it('JSON 파일로 나갔다 들어와도 다른 세션의 스프라이트를 읽는다', () => {
    const file = join(dir, 'roundtrip.json');
    writeFileSync(file, JSON.stringify(buildGlyphSet(SPRITE_1, GRID, ORDER)), 'utf8');
    const t = readGlyphTemplate(file);
    if (!t) throw new Error('template');
    expect(resolveKeypadSprite(SPRITE_2, GRID, t).join('')).toBe('7308496251');
  });

  it('격자·순서가 틀리면 만들지 않는다 — 셀 수, 중복 숫자, 빈 셀, 같은 글리프 두 번', () => {
    expect(() => buildGlyphSet(SPRITE_1, GRID.slice(0, 9), ORDER)).toThrow(KeypadUnresolvedError);
    expect(() => buildGlyphSet(SPRITE_1, GRID, '8035742611')).toThrow(KeypadUnresolvedError);
    expect(() => buildGlyphSet(SPRITE_1, GRID.map((c) => ({ ...c, x: c.x + 500 })), ORDER)).toThrow(KeypadUnresolvedError);
    expect(() => buildGlyphSet(SPRITE_1, [GRID[0] as SpriteCell, GRID[0] as SpriteCell, ...GRID.slice(2)], ORDER)).toThrow(KeypadUnresolvedError);
  });

  it('없는 파일·JSON이 아닌 파일·형식이 아닌 JSON은 undefined — 핸들러가 bad_request로 답할 수 있게', () => {
    expect(readGlyphTemplate(join(dir, 'nope.json'))).toBeUndefined();
    writeFileSync(join(dir, 'text.json'), 'not json', 'utf8');
    expect(readGlyphTemplate(join(dir, 'text.json'))).toBeUndefined();
    writeFileSync(join(dir, 'partial.json'), JSON.stringify({ '0': SPRITE_KEYPAD_GLYPHS['0'] }), 'utf8');
    expect(readGlyphTemplate(join(dir, 'partial.json'))).toBeUndefined();
  });

  it('parseGlyphSet은 rgba 길이가 w*h*4가 아니거나 숫자가 아닌 키가 있으면 거부한다', () => {
    const good = buildGlyphSet(SPRITE_1, GRID, ORDER);
    expect(parseGlyphSet(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseGlyphSet({ ...good, '0': { ...good['0'], w: 99 } })).toBeNull();
    const { '9': nine, ...rest } = good;
    expect(parseGlyphSet({ ...rest, a: nine })).toBeNull();
    expect(parseGlyphSet([])).toBeNull();
  });
});
