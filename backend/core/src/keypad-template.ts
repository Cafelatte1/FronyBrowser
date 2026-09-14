/**
 * 스프라이트 키패드 글리프 템플릿의 외부화 (FWL-073).
 *
 * 내장 템플릿(keypad-glyphs.ts)은 실측한 한 키패드의 글꼴이다. 다른 사이트의 스프라이트 키패드는 글꼴이 다르므로
 * 운영자가 그 사이트의 스프라이트 한 장으로 템플릿을 만들어 데이터 디렉터리의 `keypads/<name>.json`에 두고,
 * 호출자가 `keypad.template`으로 이름을 댄다 — 코드 수정·재배포 없이 사이트가 늘어난다.
 * 템플릿은 글꼴의 모양이지 값이 아니다: 금고와 무관하고 평문 JSON이어도 된다.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Glyph, GlyphSet, SpriteCell } from './keypad-sprite.js';
import { KeypadUnresolvedError, cropGlyph, decodePng } from './keypad-sprite.js';

/** 템플릿 이름 — 파일 이름이 되므로 경로 문자를 허용하지 않는다 */
export const TEMPLATE_NAME = /^[a-z0-9-]+$/;

const DIGITS = '0123456789';

/**
 * 스프라이트 한 장과 셀 격자, 각 셀이 보여주는 숫자(order, 셀 순서대로)로 템플릿을 만든다.
 * 열 자리가 모두 있어야 하고 중복이 없어야 한다 — 빠진 숫자는 그 숫자를 영원히 못 누르게 한다.
 * 두 셀이 같은 글리프를 내면 격자가 틀린 것이다(ambiguous): 그 템플릿은 어느 세션에서도 그 두 숫자를 못 가른다
 */
export function buildGlyphSet(spriteBytes: Uint8Array, cells: ReadonlyArray<SpriteCell>, order: string): GlyphSet {
  if (cells.length !== DIGITS.length || order.length !== DIGITS.length) throw new KeypadUnresolvedError('cell_count');
  if ([...order].some((d) => !DIGITS.includes(d)) || new Set(order).size !== DIGITS.length) throw new KeypadUnresolvedError('duplicate');
  const png = decodePng(spriteBytes);
  const out: Record<string, Glyph> = {};
  cells.forEach((cell, i) => {
    const g = cropGlyph(png, cell);
    if (g === null) throw new KeypadUnresolvedError('no_match');
    if (Object.values(out).some((o) => o.w === g.w && o.h === g.h && o.rgba === g.rgba)) throw new KeypadUnresolvedError('ambiguous');
    out[order[i] as string] = g;
  });
  return out;
}

/** JSON이 템플릿 형식인가 — 열 자리 각각 w·h·rgba(base64, w*h*4 바이트). 아니면 null */
export function parseGlyphSet(json: unknown): GlyphSet | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length !== DIGITS.length || keys.some((k) => k.length !== 1 || !DIGITS.includes(k))) return null;
  const out: Record<string, Glyph> = {};
  for (const k of keys) {
    const g = rec[k];
    if (typeof g !== 'object' || g === null) return null;
    const { w, h, rgba } = g as Record<string, unknown>;
    if (!Number.isInteger(w) || !Number.isInteger(h) || (w as number) <= 0 || (h as number) <= 0 || typeof rgba !== 'string') return null;
    if (Buffer.from(rgba, 'base64').length !== (w as number) * (h as number) * 4) return null;
    out[k] = { w: w as number, h: h as number, rgba };
  }
  return out;
}

/** `keypads/<name>.json` 템플릿 파일. 없거나 형식이 아니면 undefined — 핸들러는 bad_request로 답한다 */
export function readGlyphTemplate(file: string): GlyphSet | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parseGlyphSet(JSON.parse(readFileSync(file, 'utf8'))) ?? undefined;
  } catch {
    return undefined;
  }
}
