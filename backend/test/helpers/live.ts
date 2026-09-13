/**
 * live 테스트 전제 — 실서버(WALLET_SERVER)·기기 키(FRONY_KEY)·열린 금고.
 * 하나라도 없으면 테스트가 "왜 안 도는지" 말하고 실패한다. 조용히 skip하지 않는다 —
 * live는 사람이 일부러 `npm run test:live`로 돌리는 것이라 침묵이 더 해롭다.
 */

import { expect } from 'vitest';
import { connectMcp, type McpSession } from './mcp-client.js';

export type LiveEnv = { readonly server: string; readonly key: string };

export function liveEnv(): LiveEnv {
  const server = process.env['WALLET_SERVER'];
  const key = process.env['FRONY_KEY'];
  if (!server || !key) throw new Error('WALLET_SERVER·FRONY_KEY가 필요하다 (npm run test:live)');
  return { server, key };
}

/** 금고가 열려 있어야 시딩 세션이 주입된다 — 잠겨 있으면 로그인 검증이 의미 없다 */
export async function requireUnlocked(env: LiveEnv): Promise<void> {
  const h = (await (await fetch(`${env.server}/health`)).json()) as { vaultLocked?: boolean; vaultExists?: boolean };
  expect(h.vaultExists, '금고 파일이 없다 — 등록 페이지에서 먼저 저장').toBe(true);
  expect(h.vaultLocked, '금고가 잠겨 있다 — `wallet unlock` 후 다시').toBe(false);
}

export type OriginProbe = {
  readonly origin: string;
  /** 로그인 상태에서만 보이는 텍스트 (하나라도 보이면 로그인) */
  readonly loggedInMarkers: ReadonlyArray<string>;
  /** 검색 페이지 URL과 결과가 있을 때 보이는 텍스트 */
  readonly searchUrl: string;
  readonly searchMarker: string;
};

/**
 * origin 하나에 대한 표준 점검: begin → 홈 로그인 상태 → 검색 결과 → status → end.
 * 스냅샷 본문에 값이 섞여 있는지는 여기서 보지 않는다 — egress 회귀는 integration/mcp.test가 담당한다.
 */
export async function probeOrigin(env: LiveEnv, p: OriginProbe): Promise<void> {
  const s: McpSession = await connectMcp(env.server, env.key);
  try {
    const begun = await s.call<{ ok: boolean; sessionId: string; error?: { code: string } }>('session_begin', { origin: p.origin });
    expect(begun.ok, `session_begin 실패: ${begun.error?.code}`).toBe(true);
    const sid = begun.sessionId;
    try {
      await s.call('navigate', { sessionId: sid, url: `${p.origin}/` });
      await new Promise((r) => setTimeout(r, 4000));
      const home = await s.call<{ snapshot: { tree: string } }>('page_tree', { sessionId: sid });
      expect(home.snapshot.tree).not.toContain('Access Denied');
      expect(
        p.loggedInMarkers.some((m) => home.snapshot.tree.includes(m)),
        `로그인 상태 표식이 없다 — 저장 로그인이 만료됐나? (${p.loggedInMarkers.join('/')})`,
      ).toBe(true);

      const nav = await s.call<{ ok: boolean }>('navigate', { sessionId: sid, url: p.searchUrl });
      expect(nav.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 5000));
      const search = await s.call<{ snapshot: { tree: string } }>('page_tree', { sessionId: sid });
      expect(search.snapshot.tree).not.toContain('Access Denied');
      expect(search.snapshot.tree).toContain(p.searchMarker);

      const st = await s.call<{ origin: string; kind: string; browser: string; headless: boolean }>('session_status', { sessionId: sid });
      expect(st).toMatchObject({ origin: p.origin, kind: 'browser', browser: 'chromium', headless: true });
    } finally {
      await s.call('session_end', { sessionId: sid });
    }
  } finally {
    await s.close();
  }
}
