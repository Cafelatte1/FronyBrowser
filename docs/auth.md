# Authentication

**When to read**: when changing how a request is authenticated or which channel serves it
**Code**: `backend/api/src/auth.ts`, `backend/api/src/auth-admin.ts`, `backend/api/src/http/gui-session.ts`
**Related**: [operations](operations.md)

---

## Credentials

| Credential | Held by | Issued/revoked by | May do |
|---|---|---|---|
| Device Bearer key (`frony_...`) | each agent machine / this service itself | FronyAuth (`fauth keygen FronyBrowser` issues this service's own key for calling FronyAuth) | `POST /mcp`; also `/vault/*` if the resolved caller id is in `WALLET_ADMIN_CLIENTS` |
| OAuth access token (`fbat_...`) | a hosted connector (claude.ai app), reaching `/mcp` through Tailscale Funnel | FronyAuth's OAuth flow — the connector finds it through the RFC 9728 metadata below (FWL-040); revoked by deleting the grant in FronyAuth or disconnecting the connector | `POST /mcp` only: the same introspection answers `oauth:<app>:<user>`, which is never in `WALLET_ADMIN_CLIENTS` |
| GUI session token (`wsess_...`) | a browser that completed `/login` | `backend/api/src/http/gui-session.ts:createGuiSessions` — server-issued, in-memory, 30 minute TTL, lost on restart | `/vault/*` |
| FronyAuth admin username/password | the human operator | FronyAuth owns credential storage and lockout (5 attempts / 15 minutes by address) | one-time exchange for a `wsess_` token via `/login` → FronyAuth `/admin/verify` |

This service holds no token file of its own; every device key is verified remotely on each first use (then cached).

## Channels

| Channel | Credential |
|---|---|
| MCP (`POST /mcp`) | device Bearer key |
| Internal admin HTTP (`/vault/*`) | `wsess_` token, or a device Bearer key listed in `WALLET_ADMIN_CLIENTS` |
| Registration login (`/login`) | username + password, forwarded to FronyAuth, never stored |
| Static GUI files (`GET /*`) and `/health` | none |

## Verification flow

Device key (`backend/api/src/auth.ts:createIntrospectionVerifier`):

1. `authenticate()` (`backend/api/src/http/server.ts`) reads the `Authorization: Bearer` header.
2. The verifier hashes the token (`sha256`) and checks an in-memory cache keyed by that hash.
3. On a miss, it calls `POST <FRONY_AUTH_URL>` (the full introspection URL; required, the launcher sets it, there is no default) with this service's own `FRONY_SERVICE_KEY` as its own Bearer, body `{ token: bearer }`, 2s timeout, one retry.
4. A response `{ active: true, caller: "<id>" }` becomes `{ ok: true, client: caller }`; the `client` string (`key:<device>` / `oauth:<app>:<subject>` per the FronyAuth contract) is what `WALLET_ADMIN_CLIENTS` and audit logs match against.
5. The decision is cached: 60s for a positive result (or less, if FronyAuth's `expires_at` is sooner), 5s for a negative one.

Admin login (`backend/api/src/auth-admin.ts:createAdminVerifier`): forwards `{ username, password, client_addr }` to `POST <FRONY_AUTH_URL's base>/admin/verify` with the same service key; FronyAuth owns the lockout counter and returns `429` with `retry_after_seconds` when tripped.

## RFC 9728 metadata and CORS (Funnel connectors, FWL-040)

When `WALLET_PUBLIC_URL` is set (`HttpDeps.publicUrl`), the 401 on `/mcp` carries
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource<prefix>/mcp"`
(`http/server.ts:resourceMetadataUrl`) and the server answers `GET /.well-known/oauth-protected-resource/mcp` itself
(`protectedResourceMetadata`) with `{resource: "<WALLET_PUBLIC_URL>/mcp", authorization_servers: ["<FRONY_AUTH_ISSUER>"]}`.
RFC 9728 §3.1 puts `.well-known` right after the host, so the public metadata URL is
`/.well-known/oauth-protected-resource/wallet/mcp`; Funnel strips the mount prefix and the server always sees
`METADATA_PATH`. Without `publicUrl` neither the header nor the path exists.

Every response carries `Access-Control-Allow-Origin: *`, exposes `Mcp-Session-Id` / `WWW-Authenticate`, and `OPTIONS`
answers 204 without credentials — the claude.ai web app inspects a connector from the browser. CORS grants nothing;
every other request is still judged by FronyAuth, and `/vault/*`, `/admin/*` and `/login` have no
Funnel mount at all ([operations](operations.md#funnel)).

## Failure handling

| Condition | Result |
|---|---|
| No `Authorization` header | `401 unauthorized`, audited as `auth_failed` (`reason: "missing"`) |
| FronyAuth says the token is inactive | `401 unauthorized`, audited as `auth_failed` (`reason: "inactive"`) |
| FronyAuth unreachable, no valid cache entry | `503`, `retriable: true` — a `401` is deliberately not returned here, since that would read as "the key is wrong" |
| FronyAuth unreachable, cache entry still valid | cached decision is used (up to the TTL above) |
| Valid device key, but not in `WALLET_ADMIN_CLIENTS`, used on an admin route | `403`, audited as `auth_failed` (`reason: "not_admin"`) |
| `wsess_` token expired or unknown | `401 unauthorized` |

This is fail-closed on FronyAuth outages beyond the cache window: no request is accepted purely because verification could not be attempted.

## Local mode (`WALLET_LOCAL=1`)

`WALLET_LOCAL=1` (FWL-053) is the exception to everything above: the server binds to `127.0.0.1` only (a `WALLET_BIND` naming another interface refuses start-up), FronyAuth is never contacted, no bearer is checked, and every caller is `local` with admin rights. The vault page opens without a login form (`/login` hands out a session for any body) and requests whose `Host` is not loopback get `403` (DNS-rebinding guard). It exists for one person on one machine: `WALLET_LOCAL=1 npm run -w backend/api dev`, then open `http://127.0.0.1:9420/`. The moment another device should reach the server, run the normal mode with FronyAuth.
