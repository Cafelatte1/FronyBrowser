/**
 * ref 발급과 해석 (8.1).
 *
 * 새 스냅샷을 뜨면 이전 세대는 폐기하고 stale_ref로 실패시킨다 —
 * 조용히 재해석하지 않는다. 페이지가 바뀐 뒤 옛 ref를 대충 매칭하면
 * 결제 페이지에서 엉뚱한 버튼을 누른다.
 */

import type { Ref } from '@wallet/core';
import { formatRef, parseRef } from '@wallet/core';

export type Disposable = { dispose(): Promise<void> };

export type RefEntry = {
  /** Playwright ElementHandle. 세대 교체 시 반드시 dispose() 한다 */
  readonly handle: Disposable;
  readonly role: string;
  readonly name: string;
};

export type RefLookup =
  | { readonly ok: true; readonly entry: RefEntry }
  | { readonly ok: false; readonly code: 'stale_ref' | 'ref_not_found' };

export interface RefTable {
  readonly gen: number;
  /** 이전 세대 핸들을 전부 dispose 하고 세대를 올린다 */
  newGeneration(): number;
  put(entry: RefEntry): Ref;
  get(ref: string): RefLookup;
  /** 항목을 표에서 빼내되 dispose 하지 않는다 — 다음 세대를 열어도 살아남아야 하는 핸들(슬라이스 루트)용. 호출자가 dispose 한다 */
  detach(ref: string): RefLookup;
  /** 세션 종료 시 호출 — 현재 세대 핸들까지 정리한다 */
  disposeAll(): void;
}

export function createRefTable(): RefTable {
  let gen = 0;
  let nextIndex = 1;
  let entries = new Map<number, RefEntry>();

  function disposeEntries(old: Map<number, RefEntry>): void {
    for (const e of old.values()) {
      // 핸들 누수 방지가 목적이라 실패는 무시한다 (페이지가 이미 닫혔을 수 있다)
      void e.handle.dispose().catch(() => {});
    }
  }

  return {
    get gen() {
      return gen;
    },
    newGeneration() {
      disposeEntries(entries);
      entries = new Map();
      nextIndex = 1;
      gen += 1;
      return gen;
    },
    put(entry) {
      const index = nextIndex++;
      entries.set(index, entry);
      return formatRef(gen, index);
    },
    get(ref) {
      const parsed = parseRef(ref);
      if (!parsed || parsed.gen !== gen) return { ok: false, code: 'stale_ref' };
      const entry = entries.get(parsed.index);
      return entry ? { ok: true, entry } : { ok: false, code: 'ref_not_found' };
    },
    detach(ref) {
      const parsed = parseRef(ref);
      if (!parsed || parsed.gen !== gen) return { ok: false, code: 'stale_ref' };
      const entry = entries.get(parsed.index);
      if (!entry) return { ok: false, code: 'ref_not_found' };
      entries.delete(parsed.index);
      return { ok: true, entry };
    },
    disposeAll() {
      disposeEntries(entries);
      entries = new Map();
    },
  };
}
