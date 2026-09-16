/**
 * egress 컨텍스트 조립. scrubEntries는 live vault에서 매 요청 새로 만든다 —
 * 잠긴 금고는 빈 목록이고, 그때는 구조적 필터(규칙 1)가 유일한 방어다 (11절).
 */

import type { Audit, ScrubEntry, Vault } from '@wallet/core';
import { toScrubEntry } from '@wallet/core';
import type { EgressContext } from './egress.js';

export function scrubEntriesOf(vault: Vault): ReadonlyArray<ScrubEntry> {
  if (vault.locked) return [];
  // public 항목은 매칭하지 않는다 (FWL-080). 빼는 게 아니라 넣으면 안 되는 쪽이다 — 스크러버는 평문
  // 부분 문자열을 통째로 치환하므로, `card.personal.issuer = 카카오뱅크`를 대상에 넣는 순간
  // 드롭다운의 "카카오뱅크카드"가 "[REDACTED:...]카드"가 된다. 에이전트더러 고르라고 알려준 바로 그 항목이다
  return [...vault.live()]
    .filter(([, e]) => !e.public)
    .map(([key, e]) => toScrubEntry(key, e.value, e.type));
}

export function egressContext(
  vault: Vault,
  audit: Audit,
  handler: string,
  url: string | null,
): EgressContext {
  return {
    handler,
    url,
    scrubEntries: scrubEntriesOf(vault),
    onScrubHit(hit) {
      // 히트는 규칙 1이 못 막은 경로가 있다는 설계 결함 알람이다 (12절)
      audit.append({
        evt: 'scrub_hit',
        sid: null,
        client: null,
        traceId: null,
        origin: null,
        handler: hit.handler,
        key: hit.key,
        count: hit.count,
        url: hit.url,
      });
    },
  };
}
