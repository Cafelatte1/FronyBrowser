# Operations

**When to read**: when deploying, restarting or diagnosing the running instance
**Code**: `backend/api/src/main.ts`, `scripts/deploy.ps1`, `scripts/register-task.ps1`
**Related**: [auth](auth.md), [logging](logging.md), [data-model](data-model.md)

---

## Host

Home server reachable over Tailscale, single port `9420` for everything (MCP, internal routes, static GUI, health). FronyAuth (introspection dependency) is a separate service reached through `FRONY_AUTH_URL`. Browser profile per origin (the policy file): the default is patchright Chromium headless; an origin behind a bot manager runs system Chrome headful (headless/automation fingerprints are blocked there, see [architecture](architecture.md#decisions)).

## Launcher and environment

Process manager: Windows Task Scheduler task **"FronyBrowser Server"**, registered by `scripts/register-task.ps1`. It is **interactive-logon only** (`-LogonType Interactive`), not S4U — a headful Chrome window (an origin with `headless = false`) cannot be created from session 0, so after a reboot the server only starts once the service account logs on (the lock screen is fine after that). The task must run as the same Windows account that encrypted the vault — DPAPI is per-account (see below).

Launcher file `C:\Users\<account>\wallet-server.cmd` (outside the repo; start from `scripts/wallet-server.cmd.example`, `*.cmd` is git-ignored) sets the environment and starts the process; do not print its contents. Env vars it holds, all read in `backend/api/src/main.ts`:

| Var | Default | Notes |
|---|---|---|
| `FRONY_SERVICE_KEY` | — (required) | no fallback — start-up exits if missing |
| `FRONY_GRANT_KEY` | — | required only if the policy has a `require_grant` key; must match FronyShopping's copy — see [pay-grant](pay-grant.md) |
| `WALLET_BIND` | `tailscale ip -4`, else `127.0.0.1` | rejected at start-up unless loopback or `100.64.0.0/10` |
| `WALLET_PORT` | `9420` | |
| `WALLET_DATA_DIR` | `%LOCALAPPDATA%\Frony\FronyBrowser\data` | see [data-model](data-model.md) |
| `WALLET_POLICY` | `<WALLET_DATA_DIR>\policy.toml` | copy `config/policy.example.toml` there on first install; the file is not in the repo |
| `FRONY_AUTH_URL` | — (required) | FronyAuth introspection endpoint |
| `FRONY_AUTH_ISSUER` | — (required) | FronyAuth public origin, published as `authorization_servers` in the OAuth metadata (FWL-040) |
| `WALLET_ADMIN_CLIENTS` | (empty) | comma-separated caller ids allowed on `/vault/*` via device key |
| `WALLET_SESSION_TTL` | `15m` | browser session idle TTL; every action extends it. The expiry sweep runs every `min(60s, TTL/5)` (FWL-036). The GPU server runs `30m` (2026-09-08 decided, was `40m` for a day): the same length as the consumer's 30-minute transaction, so an idle session and its transaction expire together |
| `WALLET_MAX_SESSIONS` | `4` | concurrent sessions across all clients; beyond it `session_begin` returns `session_limit` |
| `WALLET_BROWSER_IDLE` | `5m` | a launched browser (headful Chrome window included) is closed this long after its last session context closes; the next session relaunches it |
| `WALLET_UNLOCK_TTL` | `15m` | code comment recommends `72h` for a single-user home server, so a restart is the only time it needs re-unlocking |
| `WALLET_KEEPALIVE` | `168h` | interval between login-session keepalive visits; `off` disables it |
| `WALLET_PUBLIC_URL` | — | Tailscale Funnel prefix (`https://<tailnet host>.ts.net/wallet`). Set → `/mcp` 401s carry the OAuth metadata header, the metadata path is served, and the server also listens on `127.0.0.1` (Funnel's backend must be loopback). Unset → tailnet-only (FWL-040) |
| `WALLET_LOCAL` | — | `1` = local mode: loopback only, no FronyAuth, no login — see "Local mode" below. Mutually exclusive with `WALLET_PUBLIC_URL`; the three `FRONY_*` auth vars are not needed |

## Local mode

`WALLET_LOCAL=1` (FWL-053) is the exception to everything under [authentication](auth.md): the server binds to `127.0.0.1` only (a `WALLET_BIND` naming another interface refuses start-up), FronyAuth is never contacted, no bearer is checked, and every caller is `local` with admin rights. The vault page opens without a login form (`/login` hands out a session for any body) and requests whose `Host` is not loopback get `403` (DNS-rebinding guard). It exists for one person on one machine: `WALLET_LOCAL=1 npm run -w backend/api dev`, then open `http://127.0.0.1:9420/`. The moment another device should reach the server, run the normal mode with FronyAuth.

## Deploy

Release tags only (`vX.Y.Z`); pushing to `main` deploys nothing by itself.

```
git tag vX.Y.Z && git push --tags
# on the server:
scripts\deploy.ps1 -Tag vX.Y.Z
```

`deploy.ps1` first asks the running server for an unlock handoff (`POST /vault/handoff` with `FRONY_KEY`; `WALLET_SERVER` defaults to the Tailscale IP on 9420). On the server that variable holds the server's **own** `FRONY_SERVICE_KEY` value, set as a user-level env var of the service account — that route accepts the service key (2026-09-06 decided, FWL-042), so no extra device key exists to issue, rotate or lose, and the key stays powerless on every other vault route. The handoff brings the vault back unlocked with the same deadline; it is skipped with a message when the key is missing or the vault is locked. It then stops the task, checks out the tag, runs `npm ci`, `npx patchright install chromium`, `npm run build`, then restarts the task and prints its status. Running it with no `-Tag` just restarts whatever is currently checked out. Verify with `GET /health` and confirm with `netstat` that nothing is listening on `0.0.0.0`.

## Restart and health

Restart: `scripts\deploy.ps1` (no `-Tag`), or `schtasks /End` + `schtasks /Run` on **"FronyBrowser Server"** directly. Health: `GET /health` → `{ ok, vaultLocked, vaultExists, vaultTtlMs }` (no auth required). The vault is always locked immediately after a restart; unlock with `wallet unlock` (needs `WALLET_SERVER`, `FRONY_KEY`, and admin membership).

Dry run: `wallet status` (run on the server machine) prints `dry-run: off` or a warning when `<data root>/dry-run.json` says on, and adds the vault state from `/health` when `WALLET_SERVER` is set; `main.ts` also logs a `★ DRY RUN` warning at start-up. Do not leave it on after a rehearsal — every grant-gated fill is silently skipped while it is on ([pay-grant](pay-grant.md#dry-run)).

Four things to keep in mind operationally (all from [architecture](architecture.md#decisions) and the code):

- **DPAPI is per-account.** The account that ran `wallet set` and the account the service runs as must be the same Windows account, or decryption silently fails. Do not run this service as `SYSTEM`.
- **Two-layer protection.** DPAPI guards data at rest; the unlock passphrase (TTL `WALLET_UNLOCK_TTL`) guards it in memory. A long TTL trades that second layer for less manual intervention. The deploy handoff (FWL-042) is the one exception: for the restart window only, the passphrase sits in `unlock-handoff.dpapi` under DPAPI alone; the file is deleted on the next start-up and ignored after 10 minutes. A crash or reboot writes no handoff, so those still need `wallet unlock`.
- **No "type it yourself" safety valve.** CVV and payment passwords live in the vault for unattended operation; the only mitigations are the approval channel (v2) and a short-enough TTL.
- **Stored login sessions expire.** Nothing to do: the next `session_begin` reports `storedLogin: true` but the page shows the login form, the agent logs in with the vault login keys, and `session_end(loggedIn=true)` stores the fresh session.

## Funnel

Public URL for the claude.ai connector (FWL-040). Hosted apps connect from the vendor's servers, so they cannot reach
the tailnet or attach a device key; Tailscale Funnel exposes only `/mcp` and its OAuth metadata, and FronyAuth still
judges every bearer. One-time, on the server:

```powershell
tailscale funnel --bg --set-path /wallet/mcp                                  http://127.0.0.1:9420/mcp
tailscale funnel --bg --set-path /.well-known/oauth-protected-resource/wallet http://127.0.0.1:9420/.well-known/oauth-protected-resource
tailscale funnel status
```

- The backend must be `127.0.0.1`: with `WALLET_PUBLIC_URL` set the server opens a second listener there (`main.ts`).
- In the claude.ai app: add `https://<tailnet host>.ts.net/wallet/mcp` as a custom connector → one
  FronyAuth login. FronyShopping is the other connector (`/shop/mcp`); both are needed to order.
- Check from outside: `curl.exe -si https://<tailnet host>.ts.net/wallet/mcp -X POST` → `401` +
  `WWW-Authenticate: Bearer resource_metadata=…`. `/vault/*`, `/admin/*`, `/login` and the UI have no mount.
- `netstat` will now show `127.0.0.1:9420` next to the tailnet listener; `0.0.0.0` must still be absent.

## Onboarding a platform

Decided 2026-09-06 (FWL-041): any origin can be opened and read, but a vault value leaves this server only for an
origin listed under that key's `allow_origins`, and only platforms the operator has onboarded have such entries.
Customers fill vault values; platform facts (origins, login marker, browser profile, PG origins, playbook) are the
operator's work and there is no UI for them. Steps, on the server machine:

1. **Sign up as a human** on the site. No seeding is required (FWL-045, 2026-09-07 decided): the agent logs in itself
   with the vault login keys the first time, and `session_end(loggedIn=true)` creates `sessions/<slug>.dpapi` for the
   origin, which every later `session_begin` injects and every later `loggedIn=true` end refreshes.
2. **Origin block** in the policy file: `[origins."https://<host>"]` with `label`, and `browser` / `headless` if the
   site blocks the default profile (a site behind a bot manager: system Chrome, headful). No login marker is configured here: `session_begin`
   reports `storedLogin` (whether a stored context was injected) and the agent judges the actual login state from the page.
3. **Keys**: add the origin to `allow_origins` of `profile.email`, `profile.phone`, `profile.address` and, for a form login, create
   `<site>.login.id` / `<site>.login.password` (password bound to `input[type='password']`). Vault values:
   `wallet set <key> --type <type>` on the server, under the service account.
4. **PG origins** for the card keys (`card.personal.number|expiry|cvv|password2`) and a payment PIN key are never
   guessed: run the payment-method registration or the first purchase, read the `policy_denied {key, origin}` line in the
   audit log, add exactly that origin, restart. A PIN key gets `require_grant = true`.
5. Restart the task, then the FronyShopping side: `platform add`, the playbook, and a scrubbed capture under its
   `docs/sites/<id>/` (project-shop `docs/operations.md`, "Onboarding a platform").

## Backup

Not automated in code. The files that matter are `vault.dpapi` and `sessions/*.dpapi` under the data root; `policy.toml` under the data root holds no secrets but is not in the repo either — back it up with the data root. A copy of the data root is only usable if restored under the same Windows account and DPAPI is per-account, so a raw file backup does not survive an account or machine change without re-registering the vault.
