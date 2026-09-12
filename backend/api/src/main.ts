/**
 * 서버 엔트리. GPU 홈서버에서 상시 구동한다 (13절).
 *
 * 환경변수 (런처 스크립트에만 기록):
 *   WALLET_BIND           바인딩 주소. 기본: `tailscale ip -4` → 실패 시 127.0.0.1
 *   WALLET_PORT           기본 9420
 *   WALLET_DATA_DIR       기본 %LOCALAPPDATA%\Frony\FronyBrowser\data (홈서버 관행)
 *   FRONY_AUTH_URL        필수 — FronyAuth introspect URL (예 http://<fronyauth-host>:8640/introspect)
 *   FRONY_SERVICE_KEY     필수 — 없으면 기동 거부 (fauth keygen FronyBrowser)
 *   FRONY_GRANT_KEY       grant 발급자와 공유하는 pay grant HMAC 키. 없으면 grant 플래그 키는
 *                         채울 수 없다 (계약: docs/pay-grant.md)
 *   WALLET_ADMIN_CLIENTS  vault_unlock 허용 클라이언트 id, 콤마 구분
 *   WALLET_UNLOCK_TTL     unlock 유지 시간 (기본 15m). 단일 사용자 홈서버는 72h 권장 —
 *                         재시작 때만 다시 열면 되고 keepalive도 무인으로 돈다
 *   WALLET_PUBLIC_URL     Tailscale Funnel 공개 접두 (예 https://<host>.ts.net/wallet). 있으면
 *                         /mcp의 401에 OAuth 메타데이터 헤더를 싣고 루프백에도 리슨한다 — Funnel 백엔드는 루프백이어야 한다 (FWL-040)
 *   FRONY_AUTH_ISSUER     필수 — FronyAuth 퍼블릭 origin. OAuth 메타데이터의 authorization_servers (FWL-040)
 *   WALLET_LOCAL          "1"이면 로컬 모드 — FronyAuth 없이 루프백 전용, 인증 없음. 위 FRONY_* 셋은 불필요 (FWL-053)
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaywrightTarget, createBrowserPool, hasStorageState, mergeStorageStates, persistStorageStates } from '@wallet/app';
import { VaultLockedError, consumeUnlockHandoff, createAudit, createSessionStore, createTestMode, createVault, defaultDataDir } from '@wallet/core';
import { parseDuration } from '@wallet/core';
import { createAdminVerifier } from './auth-admin.js';
import { createIntrospectionVerifier } from './auth.js';
import { startKeepalive } from './keepalive.js';
import { createHandlers } from './handlers/impl.js';
import { createVaultAdmin } from './handlers/vault-admin.js';
import { createGuiSessions } from './http/gui-session.js';
import { assertBindable, createHttpServer } from './http/server.js';

function tailscaleIp(): string | null {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5_000 });
    const ip = out.trim().split('\n')[0]?.trim();
    return ip && /^100\./.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** FronyAuth 연동에 필요한 셋 — 로컬 모드가 아니면 하나라도 없을 때 기동을 거부한다 */
function requireAuthEnv(): { serviceKey: string; authUrl: string; authIssuer: string } {
  const serviceKey = process.env['FRONY_SERVICE_KEY'];
  if (!serviceKey) {
    console.error('FRONY_SERVICE_KEY가 없습니다 — 기동 거부 (fauth keygen FronyBrowser로 발급)');
    process.exit(1);
  }
  const authUrl = process.env['FRONY_AUTH_URL'];
  if (!authUrl) {
    console.error('FRONY_AUTH_URL is required (FronyAuth introspection URL)');
    process.exit(1);
  }
  const authIssuer = process.env['FRONY_AUTH_ISSUER'];
  if (!authIssuer) {
    console.error('FRONY_AUTH_ISSUER is required (FronyAuth public origin)');
    process.exit(1);
  }
  return { serviceKey, authUrl, authIssuer };
}

function main(): void {
  // 로컬 모드 (FWL-053): 한 사람이 한 머신에서 쓴다 — FronyAuth 없이 루프백에만 리슨한다
  const local = process.env['WALLET_LOCAL'] === '1';
  const auth = local ? null : requireAuthEnv();

  const dataDir = defaultDataDir();
  const bind = local ? process.env['WALLET_BIND'] ?? '127.0.0.1' : process.env['WALLET_BIND'] ?? tailscaleIp() ?? '127.0.0.1';
  const port = Number(process.env['WALLET_PORT'] ?? 9420);
  if (local) {
    // 인증이 없으므로 테일넷 IP조차 붙이지 않는다 — 모순된 설정은 기동을 거부한다
    if (bind !== '127.0.0.1' && bind !== '::1') {
      console.error(`WALLET_LOCAL=1 binds to loopback only (WALLET_BIND=${bind})`);
      process.exit(1);
    }
    if (process.env['WALLET_PUBLIC_URL']) {
      console.error('WALLET_LOCAL=1 and WALLET_PUBLIC_URL are mutually exclusive');
      process.exit(1);
    }
  }
  assertBindable(bind);

  const grantKey = process.env['FRONY_GRANT_KEY'] ?? null;
  if (!grantKey) console.warn('FRONY_GRANT_KEY 없음 — grant 플래그가 켜진 키의 fill은 전부 grant_invalid로 거부된다');
  const vaultFile = join(dataDir, 'vault.dpapi');
  const unlockTtlMs = parseDuration(process.env['WALLET_UNLOCK_TTL'] ?? '15m', 'WALLET_UNLOCK_TTL');
  const vault = createVault(vaultFile, { ttlMs: unlockTtlMs });
  const audit = createAudit(join(dataDir, 'audit.jsonl'));
  // unlock 인계 (FWL-042): 직전 프로세스가 남긴 파일이 있으면 같은 만료 시각으로 이어받는다. 파일은 읽는 즉시 지워진다
  const handoffFile = join(dataDir, 'unlock-handoff.dpapi');
  const handoff = consumeUnlockHandoff(handoffFile);
  if (handoff) {
    vault.unlock(handoff.passphrase, { until: handoff.unlockedUntil }).then(
      () => {
        audit.append({ evt: 'vault_unlock', sid: null, client: 'handoff', traceId: null, origin: null, ok: true, source: 'handoff' });
        console.log(`금고 unlock 인계받음 — ${Math.round(vault.remainingMs() / 60_000)}분 남음`);
      },
      () => {
        audit.append({ evt: 'vault_unlock', sid: null, client: 'handoff', traceId: null, origin: null, ok: false, source: 'handoff' });
        console.warn('금고 unlock 인계 실패 — wallet unlock이 필요하다');
      },
    );
  }
  // Test Mode 토글 — 관리 UI가 켜고 끈다. 켜진 채 실주행하면 결제가 조용히 빠지므로 기동 때마다 크게 알린다 (FWL-035)
  const testMode = createTestMode(join(dataDir, 'test-mode.json'));
  if (testMode.get()) console.warn('★ TEST MODE 켜짐 — grant 플래그 키는 grant 검증·소모만 하고 입력하지 않는다. 관리 UI에서 끈다');
  // 세션 수명 (FWL-036): 배포별로 조정한다. 스윕 주기는 TTL에서 끌어내 짧은 TTL도 지켜지게
  const sessionTtlMs = parseDuration(process.env['WALLET_SESSION_TTL'] ?? '15m', 'WALLET_SESSION_TTL');
  const maxSessions = Number(process.env['WALLET_MAX_SESSIONS'] ?? 4);
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    console.error('WALLET_MAX_SESSIONS는 1 이상의 정수여야 합니다');
    process.exit(1);
  }
  const browserIdleMs = parseDuration(process.env['WALLET_BROWSER_IDLE'] ?? '5m', 'WALLET_BROWSER_IDLE');
  const sessions = createSessionStore({ ttlMs: sessionTtlMs, maxConcurrent: maxSessions });
  const pool = createBrowserPool({ idleMs: browserIdleMs });
  const sessionsDir = join(dataDir, 'sessions');
  const target = createPlaywrightTarget(pool, {
    // 시딩된 로그인 세션 주입. 시딩된 origin인데 금고가 잠겨 있으면 로그인 없이 열지 않는다 (FWL-023) —
    // 시딩 파일이 없는 origin(원래 로그인 없이 쓰는 곳)만 그냥 연다
    storageStateFor: (origin) => {
      const pp = vault.currentPassphrase();
      if (!pp) {
        if (hasStorageState(sessionsDir, origin)) throw new VaultLockedError();
        return undefined;
      }
      try {
        return mergeStorageStates(sessionsDir, pp, origin);
      } catch {
        console.warn('storageState 복호화 실패 — 로그인 없이 세션을 연다 (패스프레이즈·계정 확인)');
        return undefined;
      }
    },
    // 종료 시 사이트가 연장해 준 쿠키를 재저장 — 세션이 계속 굴러가게 한다.
    // 저장된 로그인이 없던 origin은 여기서 처음 만들어진다 (FWL-045) — 시딩은 선택이다
    persistStorageState: (state, origin) => {
      const pp = vault.currentPassphrase();
      if (!pp) return;
      // 시딩본보다 빈약해진 쿠키로는 덮어쓰지 않는다 (FWL-025) — 건너뛴 host는 감사에 남긴다
      persistStorageStates(sessionsDir, pp, state, undefined, (host, reason) => {
        audit.append({ evt: 'storage_persist_skipped', sid: null, client: null, traceId: null, origin: null, host, reason });
      }, origin);
    },
  });
  const handlers = createHandlers({ vault, sessions, targets: new Map([['browser', target]]), audit, grantKey, testMode, handoffFile });

  // 로컬 모드에선 authenticate와 /login이 먼저 끊어 이 자리에 닿지 않는다 (FWL-053)
  const notUsedInLocalMode = (): never => {
    throw new Error('not used in local mode');
  };
  const verify = auth ? createIntrospectionVerifier({ url: auth.authUrl, serviceKey: auth.serviceKey }) : notUsedInLocalMode;
  const verifyAdmin = auth ? createAdminVerifier({ url: new URL('/admin/verify', auth.authUrl).toString(), serviceKey: auth.serviceKey }) : notUsedInLocalMode;

  const adminClients = local
    ? ['local']
    : (process.env['WALLET_ADMIN_CLIENTS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const vaultAdmin = createVaultAdmin({ vaultFile, sessionsDir, vault, audit });
  const staticDir = fileURLToPath(new URL('../../../frontend/dist', import.meta.url));

  console.log(`vault unlock TTL: ${Math.round(unlockTtlMs / 60_000)}m`);
  console.log(`session TTL: ${Math.round(sessionTtlMs / 1000)}s, max sessions: ${maxSessions}, browser idle: ${Math.round(browserIdleMs / 1000)}s`);
  if (local) console.log('local mode: no auth, loopback only (WALLET_LOCAL=1)');
  const publicUrl = process.env['WALLET_PUBLIC_URL']?.replace(/\/$/, '') || undefined;
  const deps = {
    handlers, vault, audit, verify, local, adminClients, vaultAdmin, verifyAdmin, staticDir, vaultFile, testMode, unlockTtlMs,
    serviceKey: auth?.serviceKey, publicUrl, authIssuer: auth?.authIssuer, guiSessions: createGuiSessions(),
  };
  const server = createHttpServer(deps);
  // Funnel은 루프백 백엔드만 받는다 (테일넷 IP는 tailscaled 안에서 타임아웃) — 공개 접두가 있고 바인딩이 루프백이 아니면 하나 더 연다
  const loopback = publicUrl && bind !== '127.0.0.1' ? createHttpServer(deps) : null;

  // 세션 keepalive — 기본 주 1회, WALLET_KEEPALIVE=off로 끈다 (금고 잠김이면 스킵)
  const keepaliveRaw = process.env['WALLET_KEEPALIVE'] ?? '168h';
  if (keepaliveRaw !== 'off') {
    startKeepalive({ handlers, vault, audit, sessionsDir }, parseDuration(keepaliveRaw, 'WALLET_KEEPALIVE'));
  }
  // TTL 만료 세션의 브라우저 컨텍스트 정리 — 스토어에서만 빠지면 컨텍스트가 샌다
  const sweeper = setInterval(() => void handlers.sweep_expired(), Math.min(60_000, Math.max(1000, sessionTtlMs / 5)));
  sweeper.unref();
  server.listen(port, bind, () => {
    console.log(`FronyBrowser listening on http://${bind}:${port} (mcp: /mcp) — vault locked: ${vault.locked}${publicUrl ? `, public: ${publicUrl}` : ''}`);
  });
  loopback?.listen(port, '127.0.0.1', () => console.log(`FronyBrowser also listening on http://127.0.0.1:${port} for Funnel`));

  const shutdown = (): void => {
    server.close();
    loopback?.close();
    void pool.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
