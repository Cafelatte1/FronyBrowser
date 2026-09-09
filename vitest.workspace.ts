/**
 * 테스트 3계층 (FWL-019):
 *   unit         브라우저·디스크·네트워크 없음. 초 단위. 대부분의 회귀는 여기 산다
 *   integration  실브라우저·실DPAPI·로컬 http. 분 단위. snapshot.test(규칙 1)는 절대 skip 금지
 *   live         실서버·운영자 사이트 (리포에 없음). WALLET_LIVE=1 + WALLET_SERVER + FRONY_KEY + 금고 열림
 *   frontend     jsdom. backend 코드를 import하지 않는다 (규칙 12)
 */
import { defineWorkspace } from 'vitest/config';

const live = process.env['WALLET_LIVE'] === '1';

export default defineWorkspace([
  { test: { name: 'unit', include: ['backend/test/unit/**/*.test.ts'], environment: 'node' } },
  { test: { name: 'integration', include: ['backend/test/integration/**/*.test.ts'], environment: 'node' } },
  ...(live
    ? [{ test: { name: 'live', include: ['backend/test/live/**/*.test.ts'], environment: 'node', testTimeout: 120_000 } }]
    : []),
  { test: { name: 'frontend', include: ['frontend/test/**/*.test.ts'], environment: 'jsdom' } },
]);
