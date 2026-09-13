/**
 * 나가는 모든 데이터에서 금고 값을 가린다 (규칙 3).
 *
 * 평문 일치로 동작한다 — 인코딩된 값은 통과하므로 임의 JS 실행 기능을
 * 노출하면 이 방어 전체가 무력화된다 (규칙 2).
 *
 * 순수 함수다. 무엇을 가릴지(`ScrubEntry[]`)는 호출자(egress)가 live vault에서
 * 만들어 넘긴다 — 이 모듈은 금고를 모른다.
 */

import type { ValueType } from './variants.js';
import { variants } from './variants.js';

/** 키 하나가 가려야 할 패턴 집합. `variants()` 결과다 */
export type ScrubEntry = {
  readonly key: string;
  readonly patterns: ReadonlySet<string>;
};

export function toScrubEntry(key: string, value: string, type: ValueType): ScrubEntry {
  return { key, patterns: variants(value, type) };
}

export type ScrubHit = { readonly key: string; readonly count: number };

export type ScrubResult<T> = {
  readonly value: T;
  /** 히트는 정상이다 — 사이트가 화면에 그린 사용자 정보를 이 단계가 상시로 잡는다 (egress.ts 주석) */
  readonly hits: ReadonlyArray<ScrubHit>;
};

type Pattern = { readonly key: string; readonly text: string };

/**
 * 긴 패턴부터 치환한다. 짧은 부분 변형(카드 뒤 4자리 등)이 먼저 치환되면
 * 전체 번호가 `1234-5678-****...` 꼴로 쪼개져 전체 매칭을 놓친다.
 */
function sortedPatterns(entries: ReadonlyArray<ScrubEntry>): Pattern[] {
  const flat: Pattern[] = [];
  for (const e of entries) {
    for (const text of e.patterns) flat.push({ key: e.key, text });
  }
  return flat.sort((a, b) => b.text.length - a.text.length);
}

function scrubString(s: string, patterns: Pattern[], hits: Map<string, number>): string {
  let out = s;
  for (const p of patterns) {
    if (!out.includes(p.text)) continue;
    const pieces = out.split(p.text);
    hits.set(p.key, (hits.get(p.key) ?? 0) + pieces.length - 1);
    out = pieces.join(`[REDACTED:${p.key}]`);
  }
  return out;
}

function walk(node: unknown, patterns: Pattern[], hits: Map<string, number>): unknown {
  if (typeof node === 'string') return scrubString(node, patterns, hits);
  if (Array.isArray(node)) return node.map((item) => walk(item, patterns, hits));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      // 키에 값이 실려 있어도 유출이다 — 키도 치환한다
      out[scrubString(k, patterns, hits)] = walk(v, patterns, hits);
    }
    return out;
  }
  return node; // number·boolean·null 등은 평문 매칭 대상이 아니다 (구조적 필터가 1차 방어)
}

export function scrubDeep<T>(payload: T, entries: ReadonlyArray<ScrubEntry>): ScrubResult<T> {
  const hits = new Map<string, number>();
  const value = walk(payload, sortedPatterns(entries), hits) as T;
  return {
    value,
    hits: [...hits.entries()].map(([key, count]) => ({ key, count })),
  };
}
