/**
 * egress 컨텍스트 조립. scrubEntries는 live vault에서 매 요청 새로 만든다 —
 * 잠긴 금고는 빈 목록이고, 그때는 구조적 필터(규칙 1)가 유일한 방어다 (11절).
 */

import type { Audit, ScrubEntry, Vault } from '@wallet/core';
import { toScrubEntry } from '@wallet/core';
import type { EgressContext } from './egress.js';

export function scrubEntriesOf(vault: Vault): ReadonlyArray<ScrubEntry> {
  if (vault.locked) return [];
  return [...vault.live()].map(([key, e]) => toScrubEntry(key, e.value, e.type));
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
