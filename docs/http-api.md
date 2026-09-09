# HTTP API

**When to read**: when adding or changing a route, or a client sees an unexpected status code
**Code**: `backend/api/src/http/server.ts`, `backend/api/src/http/gui-session.ts`, `backend/api/src/http/static.ts`
**Related**: [auth](auth.md), [tool-surface](tool-surface.md)

---

## Authentication

See [auth](auth.md) for the full model. Summary per route family:

| Route family | Accepts |
|---|---|
| `/mcp` | device Bearer key, verified via FronyAuth introspection |
| `/login` | username/password body, forwarded to FronyAuth `/admin/verify` |
| `/vault/*` | GUI session token (`wsess_...`) **or** a device Bearer key listed in `WALLET_ADMIN_CLIENTS` |
| `/admin/dry-run` | GUI session token (`wsess_...`) **only** — device keys get `403` even when listed in `WALLET_ADMIN_CLIENTS`, so an agent-side credential can never flip the switch |
| `/health` | none |
| `GET /*` (static) | none — serves `frontend/dist`, no route requires auth to read the registration page shell |

## Routes

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/health` | none | `{ ok, vaultLocked, vaultExists, vaultTtlMs, local }` — `local` — `true` in local mode, see [operations](operations.md#local-mode) |
| POST | `/mcp` | device key | MCP streamable-HTTP transport (stateless: `sessionIdGenerator: undefined` — wallet sessions are managed by the `session_begin` tool, not the MCP transport) |
| POST | `/login` | none (rate-limited by FronyAuth) | `{ ok, token }` on success (`token` is a `wsess_...` GUI session token); `401`/`429`/`503` on failure |
| POST | `/vault/unlock` | admin | `{ ok, ttlMs }` |
| POST | `/vault/handoff` | admin, **or** the server's own `FRONY_SERVICE_KEY` | `{ ok, remainingMs }` — no passphrase body; writes the unlock handoff file for the next process ([operations](operations.md#deploy)); `403 vault_locked` when locked. The service key is accepted on this route only (audited as `service:self`) so the local deploy script needs no separate device key; it still cannot unlock, read or write the vault |
| POST | `/vault/list` | admin | `{ ok, keys: [{ name, type, len }] }` |
| POST | `/vault/set` | admin | `{ ok, key, type, len }`; with `entries: [{ key, type, value }]` instead of `key/type/value` it writes them all in one decrypt/encrypt and returns `{ ok, keys: [{ key, type, len }] }` (all-or-nothing) |
| POST | `/vault/rm` | admin | `{ ok, key }` |
| GET | `/admin/dry-run` | wsess only | `{ ok, on }` — current dry-run state ([pay-grant](pay-grant.md#dry-run)) |
| POST | `/admin/dry-run` | wsess only | body `{ on: boolean }` (else `400`); persists the flag, audits `dry_run_set`, returns `{ ok, on }` |
| GET | `/*` | none | static file from `frontend/dist`, or 404 |

All `/vault/*` bodies require a `passphrase` field (the vault passphrase, not the FronyAuth password); `/vault/set` additionally requires `key`, `type`, `value`; `/vault/rm` requires `key`.

`/health` deliberately does not report the dry-run state: it is unauthenticated, and an agent must not be able to learn that a payment step is being skipped.

Every response — including these internal routes — passes through `egress.scrub()` (`backend/api/src/http/server.ts:jsonScrubbed`) before being sent; see [architecture](architecture.md#absolute-rules) rule 3.

`0.0.0.0` is refused at bind time by `assertBindable` (Tailscale `100.64.0.0/10` or loopback only); see [operations](operations.md).

## Error shape

```json
{ "ok": false, "error": { "code": "origin_not_permitted", "message": "not permitted", "retriable": false } }
```

`message` never contains a value (rule 5). Status codes: `401` unauthorized/invalid token, `403` admin-only or policy-denied, `404` not found / unknown key on admin routes, `429` GUI login rate-limited (from FronyAuth), `503` FronyAuth unreachable and no valid cache entry (fail-closed — see [auth](auth.md#failure-handling)), `500` uncaught internal error (details suppressed).

`origin_not_permitted` is returned for both an unknown key and a key whose `allow_origins` does not include the frame origin — the two are indistinguishable to the caller so vault contents cannot be probed (see [data-model](data-model.md#invariants-and-validation)).
