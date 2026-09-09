/**
 * 스프라이트 키패드 숫자 판독 (FWL-038).
 *
 * 스프라이트 PIN 키패드는 버튼마다 자리 번호만 있고(`data-key=N`), 보이는 숫자는 세션마다 새로 굽는
 * 스프라이트 PNG 한 장의 셀 하나다 — DOM 어디에도 숫자가 없다. 각 셀을 알파 bbox로 잘라내면
 * 열 글리프가 세션이 달라도 바이트 단위로 같으므로(2026-09-06 실측, 스프라이트 두 장 대조) OCR 없이
 * 정확 일치 템플릿 매칭으로 자리 → 숫자를 얻는다.
 *
 * fail-closed: 셀이 10개가 아니거나, 어느 셀이 템플릿 0개·2개 이상과 맞거나, 같은 숫자가 두 번 나오면
 * 판독 없음(KeypadUnresolvedError) — 어댑터는 아무것도 누르지 않는다.
 * 숫자·스프라이트·셀 어느 것도 이 함수 밖(응답·로그)으로 나가지 않는다 (규칙 1).
 */

import { PNG } from 'pngjs';
import { SPRITE_KEYPAD_GLYPHS } from './keypad-glyphs.js';

export type Glyph = { readonly w: number; readonly h: number; readonly rgba: string /* base64 */ };
export type GlyphSet = Readonly<Record<string, Glyph>>; // digit → glyph

/** 스프라이트 안의 셀 하나 — 어댑터가 computed background-position과 박스 크기로 잰다 */
export type SpriteCell = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

export type KeypadResolver = 'sprite-template';

export class KeypadUnresolvedError extends Error {
  constructor(readonly reason: 'cell_count' | 'no_match' | 'ambiguous' | 'duplicate' | 'bad_png') {
    super(`keypad_unresolved: ${reason}`); // 숫자·좌표는 싣지 않는다
  }
}

type Raw = { readonly width: number; readonly height: number; readonly data: Buffer };

export function decodePng(bytes: Uint8Array): Raw {
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: png.data };
  } catch {
    throw new KeypadUnresolvedError('bad_png');
  }
}

/** 셀을 알파 bbox로 잘라낸 RGBA. 글리프가 없으면(전부 투명) null */
export function cropGlyph(png: Raw, cell: SpriteCell): Glyph | null {
  const x0 = Math.max(0, cell.x);
  const y0 = Math.max(0, cell.y);
  const x1 = Math.min(png.width, cell.x + cell.w);
  const y1 = Math.min(png.height, cell.y + cell.h);
  let minX = x1, minY = y1, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((minY + y) * png.width + minX) * 4;
    png.data.copy(out, y * w * 4, src, src + w * 4);
  }
  return { w, h, rgba: out.toString('base64') };
}

const sameGlyph = (a: Glyph, b: Glyph): boolean => a.w === b.w && a.h === b.h && a.rgba === b.rgba;

/**
 * 셀 배열(버튼 순서) → 각 버튼이 보여주는 숫자. 결과 배열의 i번째가 i번째 버튼의 숫자다.
 * 정확 일치만 인정한다 — 근사 매칭은 잘못 누르는 쪽으로 열린다
 */
export function resolveKeypadSprite(spriteBytes: Uint8Array, cells: ReadonlyArray<SpriteCell>, glyphs: GlyphSet = SPRITE_KEYPAD_GLYPHS): string[] {
  const digits = Object.keys(glyphs);
  if (cells.length !== digits.length) throw new KeypadUnresolvedError('cell_count');
  const png = decodePng(spriteBytes);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cell of cells) {
    const g = cropGlyph(png, cell);
    if (g === null) throw new KeypadUnresolvedError('no_match');
    const hits = digits.filter((d) => sameGlyph(glyphs[d] as Glyph, g));
    if (hits.length === 0) throw new KeypadUnresolvedError('no_match');
    if (hits.length > 1) throw new KeypadUnresolvedError('ambiguous');
    const d = hits[0] as string;
    if (seen.has(d)) throw new KeypadUnresolvedError('duplicate');
    seen.add(d);
    out.push(d);
  }
  return out;
}
