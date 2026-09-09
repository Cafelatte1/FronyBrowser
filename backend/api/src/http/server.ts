/**
 * HTTP 서버. 소비자 입구는 /mcp 하나이고 나머지는 내부 경로다:
 *   POST /mcp            — MCP streamable-http (기기 키 인증)
 *   POST /login          — 등록 페이지 로그인 (FronyAuth /admin/verify 위임 → wsess_ 발급)
 *   POST /vault/unlock·set·rm·list — admin 전용 (wsess_ 또는 admin 기기 키). 값은 응답에 없다
 *   POST /vault/handoff  — admin, 또는 서버 자신의 서비스 키(같은 머신의 배포 스크립트). 인계 파일만 쓴다 (FWL-042)
 *   GET/POST /admin/dry-run — 등록 페이지 세션(wsess_) 전용. 기기 키는 admin이라도 403 (FWL-035)
 *   GET  /health         — 무인증. dry-run 상태는 싣지 않는다 — 에이전트가 읽는다
 *   GET  /.well-known/oauth-protected-resource/mcp — 무인증, publicUrl이 있을 때만 (RFC 9728, claude.ai 커넥터용, FWL-040)
 *   GET  /*              — frontend/dist 정적 서빙 (등록 페이지)
 *
 * `0.0.0.0` 바인딩은 코드에서 거부한다 (규칙 10).
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Audit, DryRun, Result, Vault } from '@wallet/core';
import type { AdminVerifier } from '../auth-admin.js';
import type { Verifier } from '../auth.js';
import type { Caller, Handlers } from '../handlers/impl.js';
import type { VaultAdmin } from '../handlers/vault-admin.js';
import { scrub } from '../egress.js';
import { egressContext } from '../egress-context.js';
import { buildMcpServer } from '../mcp/server.js';
import type { GuiSessions } from './gui-session.js';
import { createGuiSessions } from './gui-session.js';
import { serveStatic } from './static.js';

export type HttpDeps = {
  readonly handlers: Handlers;
  readonly vault: Vault;
  readonly audit: Audit;
  readonly verify: Verifier;
  /** WALLET_LOCAL=1 — 루프백 전용, 인증 없음. 모든 호출자는 'local'이고 admin이다 (FWL-053) */
  readonly local?: boolean;
  /** 기기 키로 vault 라우트를 허용할 클라이언트 (env WALLET_ADMIN_CLIENTS, CLI unlock용) */
  readonly adminClients: ReadonlyArray<string>;
  readonly vaultAdmin: VaultAdmin;
  /** FronyAuth /admin/verify 위임 — 등록 페이지 로그인 */
  readonly verifyAdmin: AdminVerifier;
  /** frontend/dist 경로 */
  readonly staticDir: string;
  /** 금고 파일 경로 — /health의 vaultExists용 (없으면 첫 저장 전이다) */
  readonly vaultFile?: string;
  readonly guiSessions?: GuiSessions;
  /** dry-run 토글 (FWL-035). 없으면 /admin/dry-run은 404 */
  readonly dryRun?: DryRun;
  /**
   * 이 서버 자신의 FronyAuth 서비스 키 (env FRONY_SERVICE_KEY). `/vault/handoff` 하나에서만 호출자로 인정한다 —
   * 같은 머신의 배포 스크립트가 재시작 직전에 부르는 용도다 (FWL-042). 다른 vault 라우트는 여전히 admin 전용이라
   * 이 키로 금고를 열거나 값을 쓸 수 없다. 이 키를 읽을 수 있는 계정은 인계 파일도 읽을 수 있는 위치라 새로 열리는 게 없다
   */
  readonly serviceKey?: string;
  /** Funnel 공개 접두 (env WALLET_PUBLIC_URL, 예 https://host.ts.net/wallet). 있으면 401에 resource_metadata를 싣고 메타데이터 경로를 낸다 (FWL-040) */
  readonly publicUrl?: string;
  /** FronyAuth 퍼블릭 도메인 — 메타데이터의 authorization_servers */
  readonly authIssuer?: string;
};

/** RFC 9728 §3.1: `.well-known`은 호스트 바로 뒤, 서비스 접두는 그 뒤에 — Funnel이 접두를 벗기므로 서버 자신은 항상 이 경로로 본다 */
export const METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

export function resourceMetadataUrl(publicUrl: string): string {
  const u = new URL(publicUrl);
  const path = u.pathname.replace(/\/$/, '');
  return `${u.origin}/.well-known/oauth-protected-resource${path}/mcp`;
}

export function protectedResourceMetadata(publicUrl: string, authIssuer: string): Record<string, unknown> {
  return {
    resource: `${publicUrl.replace(/\/$/, '')}/mcp`,
    authorization_servers: [authIssuer],
    bearer_methods_supported: ['header'],
    resource_name: 'FronyBrowser',
  };
}

/** claude.ai 웹앱은 브라우저에서 커넥터를 검사한다 — preflight는 자격 없이 통과하고 401의 WWW-Authenticate가 스크립트에 읽혀야 한다 */
function cors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-expose-headers', 'Mcp-Session-Id, WWW-Authenticate');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 내부 경로(admin·login) 응답도 egress를 통과한다 (규칙 3) — 값이 없어야 정상이지만 출구는 하나다 */
function jsonScrubbed<T>(deps: HttpDeps, handler: string, res: ServerResponse, status: number, body: Result<T>): void {
  json(res, status, scrub(body, egressContext(deps.vault, deps.audit, handler, null)));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolvePromise(undefined);
      try {
        resolvePromise(JSON.parse(raw));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

async function authenticate(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<Caller | null> {
  if (deps.local) return { client: 'local' };
  const bearer = bearerOf(req);
  if (!bearer) {
    deps.audit.append({ evt: 'auth_failed', sid: null, client: null, traceId: null, origin: null, reason: 'missing' });
    json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'bearer required', retriable: false } });
    return null;
  }
  const decision = await deps.verify(bearer);
  if (!decision.ok) {
    if (decision.status === 401) {
      deps.audit.append({ evt: 'auth_failed', sid: null, client: null, traceId: null, origin: null, reason: 'inactive' });
      json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'invalid token', retriable: false } });
    } else {
      // FronyAuth 불통 + 캐시 없음 — 401을 주면 "키가 틀렸다"는 오판을 만든다
      json(res, 503, { ok: false, error: { code: 'unauthorized', message: 'auth backend unavailable', retriable: true } });
    }
    return null;
  }
  return { client: decision.client };
}

export function createHttpServer(deps: HttpDeps): Server {
  const gui = deps.guiSessions ?? createGuiSessions();
  return createServer((req, res) => {
    void route(deps, gui, req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: { code: 'timeout', message: 'internal (details suppressed)', retriable: true } });
    });
  });
}

async function route(deps: HttpDeps, gui: GuiSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  cors(res);

  // DNS 리바인딩 방어 — 인증이 없으니 Host로 막는다 (FWL-053)
  if (deps.local) {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
      json(res, 403, { ok: false, error: { code: 'unauthorized', message: 'local mode accepts loopback hosts only', retriable: false } });
      return;
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === METADATA_PATH && deps.publicUrl && deps.authIssuer) {
    json(res, 200, protectedResourceMetadata(deps.publicUrl, deps.authIssuer));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      vaultLocked: deps.vault.locked,
      vaultExists: deps.vaultFile === undefined ? true : existsSync(deps.vaultFile),
      vaultTtlMs: deps.vault.remainingMs(),
      local: deps.local === true,
    });
    return;
  }

  if (url.pathname === '/mcp') {
    // 커넥터는 이 헤더로 인가 서버(FronyAuth)를 찾는다 — 401일 때만 의미가 있지만 미리 달아 두어도 무해하다
    if (deps.publicUrl) res.setHeader('www-authenticate', `Bearer resource_metadata="${resourceMetadataUrl(deps.publicUrl)}"`);
    const caller = await authenticate(deps, req, res);
    if (!caller) return;
    // stateless 모드 — wallet 세션은 MCP 전송 세션이 아니라 session_begin 도구가 관리한다
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer({ handlers: deps.handlers, vault: deps.vault, audit: deps.audit }, caller);
    await server.connect(transport);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
    return;
  }

  // 등록 페이지 로그인 — 비밀번호는 FronyAuth로 전달만 하고 저장·기록하지 않는다
  if (req.method === 'POST' && url.pathname === '/login') {
    // 로컬 모드는 확인할 계정이 없다 — 페이지를 여는 것이 곧 자격이다 (FWL-053)
    if (deps.local) {
      const addr = req.socket.remoteAddress ?? 'unknown';
      deps.audit.append({
        evt: 'gui_login', sid: null, client: null, traceId: null, origin: null,
        username: 'local', addr, ok: true,
      });
      jsonScrubbed(deps, 'login', res, 200, { ok: true, token: gui.issue('local') });
      return;
    }
    const body = (await readBody(req)) as { username?: string; password?: string } | undefined;
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      json(res, 400, { ok: false, error: { code: 'bad_request', message: 'username/password required', retriable: false } });
      return;
    }
    const addr = req.socket.remoteAddress ?? 'unknown';
    const verdict = await deps.verifyAdmin(body.username, body.password, addr);
    if (!verdict.ok) {
      deps.audit.append({
        evt: 'gui_login', sid: null, client: null, traceId: null, origin: null,
        username: body.username, addr, ok: false, status: verdict.status,
      });
      if (verdict.status === 429) {
        json(res, 429, { ok: false, retryAfterSeconds: verdict.retryAfterSeconds ?? null });
      } else if (verdict.status === 503) {
        json(res, 503, { ok: false, error: { code: 'unauthorized', message: 'auth backend unavailable', retriable: true } });
      } else {
        json(res, 401, { ok: false, attemptsLeft: verdict.attemptsLeft ?? null });
      }
      return;
    }
    deps.audit.append({
      evt: 'gui_login', sid: null, client: null, traceId: null, origin: null,
      username: verdict.username, addr, ok: true,
    });
    jsonScrubbed(deps, 'login', res, 200, { ok: true, token: gui.issue(verdict.username) });
    return;
  }

  // dry-run 토글 — 사람이 관리 UI에서만 켜고 끈다. 기기 키(admin 포함)는 거부: 에이전트 경로에서
  // 결제를 조용히 빼는 스위치를 만질 수 없어야 한다. /health에도 싣지 않는다 (FWL-035)
  if (url.pathname === '/admin/dry-run' && deps.dryRun !== undefined) {
    const bearer = bearerOf(req);
    const username = bearer?.startsWith('wsess_') ? gui.check(bearer) : null;
    if (!username) {
      json(res, bearer?.startsWith('wsess_') || !bearer ? 401 : 403, {
        ok: false, error: { code: 'unauthorized', message: 'admin session only', retriable: false },
      });
      return;
    }
    if (req.method === 'GET') {
      json(res, 200, { ok: true, on: deps.dryRun.get() });
      return;
    }
    if (req.method === 'POST') {
      const body = (await readBody(req)) as { on?: unknown } | undefined;
      if (typeof body?.on !== 'boolean') {
        json(res, 400, { ok: false, error: { code: 'bad_request', message: 'on: boolean required', retriable: false } });
        return;
      }
      deps.dryRun.set(body.on);
      deps.audit.append({ evt: 'dry_run_set', sid: null, client: `admin:${username}`, traceId: null, origin: null, on: body.on });
      json(res, 200, { ok: true, on: body.on });
      return;
    }
  }

  // unlock 인계 — 패스프레이즈 본문 없음. 배포 스크립트가 재시작 직전에 부른다 (FWL-042).
  // admin 외에 서버 자신의 서비스 키도 인정한다 — 그 키는 이미 이 머신의 런처에 있고, 새 기기 키를 만들 이유가 없다
  if (req.method === 'POST' && url.pathname === '/vault/handoff') {
    const caller = isSelfServiceKey(deps, req) ? { client: 'service:self' } : await requireAdmin(deps, gui, req, res);
    if (!caller) return;
    const result = await deps.handlers.vault_handoff(caller);
    jsonScrubbed(deps, 'vault_handoff', res, result.ok ? 200 : 403, result);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/vault/')) {
    const caller = await requireAdmin(deps, gui, req, res);
    if (!caller) return;
    const body = (await readBody(req)) as
      | { passphrase?: string; key?: string; type?: string; value?: string }
      | undefined;
    if (typeof body?.passphrase !== 'string') {
      json(res, 400, { ok: false, error: { code: 'bad_request', message: 'passphrase required', retriable: false } });
      return;
    }

    if (url.pathname === '/vault/unlock') {
      const result = await deps.handlers.vault_unlock(caller, body.passphrase);
      jsonScrubbed(deps, 'vault_unlock', res, result.ok ? 200 : 403, result);
      return;
    }
    if (url.pathname === '/vault/list') {
      const result = await deps.vaultAdmin.overview(caller, body.passphrase);
      jsonScrubbed(deps, 'vault_list', res, adminStatus(result), result);
      return;
    }
    if (url.pathname === '/vault/set') {
      // entries[]가 있으면 일괄 저장 (복호화·재암호화 한 번) — GUI의 "입력한 항목 저장"
      const entries = (body as { entries?: unknown }).entries;
      if (Array.isArray(entries)) {
        const okShape = entries.every((e) => e && typeof e === 'object' && typeof (e as { key?: unknown }).key === 'string' && typeof (e as { type?: unknown }).type === 'string' && typeof (e as { value?: unknown }).value === 'string');
        if (!okShape) {
          json(res, 400, { ok: false, error: { code: 'bad_request', message: 'entries: [{ key, type, value }]', retriable: false } });
          return;
        }
        const result = await deps.vaultAdmin.setMany(caller, body.passphrase, entries as Array<{ key: string; type: string; value: string }>);
        jsonScrubbed(deps, 'vault_set', res, adminStatus(result), result);
        return;
      }
      if (typeof body.key !== 'string' || typeof body.type !== 'string' || typeof body.value !== 'string') {
        json(res, 400, { ok: false, error: { code: 'bad_request', message: 'key/type/value required', retriable: false } });
        return;
      }
      const result = await deps.vaultAdmin.set(caller, body.passphrase, body.key, body.type, body.value);
      jsonScrubbed(deps, 'vault_set', res, adminStatus(result), result);
      return;
    }
    if (url.pathname === '/vault/rm') {
      if (typeof body.key !== 'string') {
        json(res, 400, { ok: false, error: { code: 'bad_request', message: 'key required', retriable: false } });
        return;
      }
      const result = await deps.vaultAdmin.rm(caller, body.passphrase, body.key);
      jsonScrubbed(deps, 'vault_rm', res, adminStatus(result), result);
      return;
    }
  }

  // 나머지 GET은 등록 페이지 정적 파일 — 비밀은 없고, 조작 API가 인증을 요구한다
  if (req.method === 'GET' && serveStatic(deps.staticDir, url.pathname, res)) return;

  json(res, 404, { ok: false, error: { code: 'timeout', message: 'not found', retriable: false } });
}

/** vault 라우트 인증: 등록 페이지 세션(wsess_) 우선, 아니면 admin 기기 키 */
/** 요청의 bearer가 이 서버 자신의 서비스 키인가 (FWL-042). 길이 비교 후 상수시간 비교 */
function isSelfServiceKey(deps: HttpDeps, req: IncomingMessage): boolean {
  const bearer = bearerOf(req);
  if (!bearer || !deps.serviceKey) return false;
  const a = Buffer.from(bearer, 'utf8');
  const b = Buffer.from(deps.serviceKey, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function requireAdmin(
  deps: HttpDeps,
  gui: GuiSessions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Caller | null> {
  const bearer = bearerOf(req);
  if (bearer?.startsWith('wsess_')) {
    const username = gui.check(bearer);
    if (username) return { client: `admin:${username}` };
    json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'session expired', retriable: false } });
    return null;
  }
  const caller = await authenticate(deps, req, res);
  if (!caller) return null;
  if (!deps.adminClients.includes(caller.client)) {
    // 일반 기기 키로는 금고를 만질 수 없다 — 에이전트 기기가 침해돼도 (8.4)
    deps.audit.append({ evt: 'auth_failed', sid: null, client: caller.client, traceId: null, origin: null, reason: 'not_admin' });
    json(res, 403, { ok: false, error: { code: 'unauthorized', message: 'admin only', retriable: false } });
    return null;
  }
  return caller;
}

function adminStatus(result: { ok: boolean; error?: { code: string } }): number {
  if (result.ok) return 200;
  if (result.error?.code === 'bad_request') return 400;
  if (result.error?.code === 'key_not_found') return 404;
  return 403;
}

/**
 * 화이트리스트 바인딩 (규칙 10) — Tailscale IP(100.64.0.0/10) 또는 루프백만.
 * 거부 목록 방식은 `0`·`::0` 같은 표기가 전체 인터페이스로 풀려 새기 때문에 허용 목록으로 검사한다
 */
export function assertBindable(host: string): void {
  if (host === '127.0.0.1' || host === '::1') return;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return;
  throw new Error(`refusing to bind to "${host}" — rule 10 (tailscale 100.64.0.0/10 or loopback only)`);
}
