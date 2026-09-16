# Operations

**When to read**: when deploying, restarting or diagnosing the running instance
**Code**: `backend/api/src/main.ts`, `scripts/deploy.ps1`, `scripts/register-task.ps1`
**Related**: [pay-grant](pay-grant.md)

---

## Host

Home server reachable over Tailscale, single port `9420` for everything (MCP, internal routes, static GUI, health). FronyAuth (introspection dependency) is a separate service reached through `FRONY_AUTH_URL`; a server without one runs on a static key list instead (`WALLET_KEYS`, see "Static keys" below). The browser profile is chosen per session by the caller: patchright Chromium headless by default, system Chrome headful for a site whose bot manager blocks headless and automation fingerprints.

## Launcher and environment

Process manager: Windows Task Scheduler task **"FronyBrowser Server"**, registered by `scripts/register-task.ps1`. It starts **at boot** as the service account with `-LogonType S4U`, and retries 999 times a minute apart. The task must run as that same Windows account, because DPAPI is per-account (see below) — but it does not need an interactive logon to do so. It was `AtLogon` + `Interactive` until 2026-09-16 on two beliefs that were never measured and are both wrong: that S4U cannot reach the user DPAPI master key, and that headful Chrome cannot be launched from session 0. Measured that day, an S4U task decrypted a CurrentUser blob written by another session, the server picked its vault unlock back up from the handoff file across a restart, and a `browser = chrome`, `headless = false` session rendered a full page tree and a 988x653 screenshot from session 0. Meanwhile the old setting cost the thing it was protecting: after the Windows updates rebooted the machine twice on 2026-09-16, nothing logged on to a headless server, so the process never came back. The aggressive retry is for a different race — the launcher binds the Tailscale address (`WALLET_BIND`) and the boot trigger fires before Tailscale has one, so the first attempts die with `EADDRNOTAVAIL`; the sibling Frony services hit the same wall and settled on the same numbers. A reboot still leaves the vault locked, so someone runs `wallet unlock` afterwards — but now there is a process listening to run it against.

Launcher file `C:\Users\<account>\wallet-server.cmd` (outside the repo; start from `scripts/wallet-server.cmd.example`, `*.cmd` is git-ignored) sets the environment and starts the process; do not print its contents. Env vars it holds, all read in `backend/api/src/main.ts`:

| Var | Default | Notes |
|---|---|---|
| `FRONY_SERVICE_KEY` | — (required with FronyAuth) | no fallback — start-up exits if missing, unless `WALLET_KEYS` or `WALLET_LOCAL` is set |
| `FRONY_GRANT_KEY` | — | required to fill any key registered with the vault's `grant` flag; must match the issuing service's copy — see [pay-grant](pay-grant.md) |
| `WALLET_BIND` | `tailscale ip -4`, else `127.0.0.1` | rejected at start-up unless loopback or `100.64.0.0/10` |
| `WALLET_PORT` | `9420` | |
| `WALLET_DATA_DIR` | `%LOCALAPPDATA%\Frony\FronyBrowser\data` | holds `vault.dpapi`, `sessions/*.dpapi`, `audit.jsonl`, `test-mode.json` |
| `FRONY_AUTH_URL` | — (required with FronyAuth) | FronyAuth introspection endpoint. Mutually exclusive with `WALLET_KEYS` |
| `FRONY_AUTH_ISSUER` | — (required with FronyAuth) | FronyAuth public origin, published as `authorization_servers` in the OAuth metadata (FWL-040) |
| `WALLET_KEYS` | — | `name:token,name:token` — static bearer list for a server with no FronyAuth (FWL-074). Each token resolves to the caller `key:<name>`, the same string FronyAuth would produce, so `WALLET_ADMIN_CLIENTS` and the audit log read the same. Cannot be combined with `FRONY_AUTH_URL` or `WALLET_PUBLIC_URL` |
| `WALLET_ADMIN_CLIENTS` | (empty) | comma-separated caller ids allowed on `/vault/*` via device key, and under `WALLET_KEYS` also the only names the console login accepts. FronyAuth resolves a bearer to `key:<device>` or `oauth:<app>:<subject>`, and that resolved string is what this list matches — so a connector user can never be admin, only a device key can. Keep the agents' own device keys **out** of it — a key that reaches `/mcp` and `/vault/grant` alike lets an agent clear its own grant requirement. This server holds `key:gpu-wallet-deploy` only (2026-09-12); the console's own login session is the normal admin path and is unaffected |
| `WALLET_SESSION_TTL` | `15m` | browser session idle TTL; every action extends it. The expiry sweep runs every `min(60s, TTL/5)` (FWL-036). The GPU server runs `30m` (2026-09-08 decided, was `40m` for a day): the same length as the consumer's 30-minute transaction, so an idle session and its transaction expire together |
| `WALLET_MAX_SESSIONS` | `4` | concurrent sessions across all clients; beyond it `session_begin` returns `session_limit` |
| `WALLET_BROWSER_IDLE` | `5m` | a launched browser (headful Chrome window included) is closed this long after its last session context closes; the next session relaunches it |
| `WALLET_UNLOCK_TTL` | `15m` | code comment recommends `72h` for a single-user home server, so a restart is the only time it needs re-unlocking |
| `WALLET_KEEPALIVE` | `168h` | interval between login-session keepalive visits; `off` disables it |
| `WALLET_PUBLIC_URL` | — | Tailscale Funnel prefix (`https://<tailnet host>.ts.net/wallet`). Set → `/mcp` 401s carry the OAuth metadata header, the metadata path is served, and the server also listens on `127.0.0.1` (Funnel's backend must be loopback). Unset → tailnet-only (FWL-040) |
| `WALLET_LOCAL` | — | `1` = local mode: loopback only, no FronyAuth, no login — see "Local mode" below. Mutually exclusive with `WALLET_PUBLIC_URL`; the three `FRONY_*` auth vars are not needed |

## Local mode

`WALLET_LOCAL=1` (FWL-053) is the exception to every authentication rule: the server binds to `127.0.0.1` only (a `WALLET_BIND` naming another interface refuses start-up), FronyAuth is never contacted, no bearer is checked, and every caller is `local` with admin rights. The vault page opens without a login form (`/login` hands out a session for any body) and requests whose `Host` is not loopback get `403` (DNS-rebinding guard). CORS headers are set only on `/mcp` and its metadata path (2026-09-12), so a page open in the same browser cannot read a reply from `/login` or `/vault/*`; the Host guard alone never stopped that, since `127.0.0.1` is exactly the Host a browser sends. It exists for one person on one machine: `WALLET_LOCAL=1 npm run -w backend/api dev`, then open `http://127.0.0.1:9420/`. The moment another device should reach the server, run the normal mode with FronyAuth.

## Static keys

`WALLET_KEYS` (FWL-074) runs the normal mode — Tailscale or loopback binding, bearer on every call, admin gate on
`/vault/*` — without FronyAuth. The launcher holds the list itself, `name:token,name:token`; the server compares in
constant time and never writes a token anywhere. Issuing or revoking a key is editing the launcher and restarting.
The console login takes a key **name** as the username and its **token** as the password, and only a name listed
in `WALLET_ADMIN_CLIENTS` (as `key:<name>`) gets in; five failures from one address lock that address out for
15 minutes, which is what FronyAuth's `/admin/verify` did. `wallet unlock` and the deploy handoff use an admin key as
`FRONY_KEY`. What this mode does not give: expiry, OAuth, revocation without a restart, or a Funnel connector —
those are FronyAuth's, and `WALLET_PUBLIC_URL` refuses to start alongside `WALLET_KEYS`.

## Deploy

Release tags only (`vX.Y.Z`); pushing to `main` deploys nothing by itself.

```
git tag vX.Y.Z && git push --tags
# on the server:
scripts\deploy.ps1 -Tag vX.Y.Z
```

`deploy.ps1` first asks the running server for an unlock handoff (`POST /vault/handoff` with `FRONY_KEY`; `WALLET_SERVER` defaults to the Tailscale IP on 9420). On the server that variable holds the server's **own** `FRONY_SERVICE_KEY` value, set as a user-level env var of the service account — that route accepts the service key (2026-09-06 decided, FWL-042), so no extra device key exists to issue, rotate or lose, and the key stays powerless on every other vault route. The handoff brings the vault back unlocked with the same deadline; it is skipped with a message when the key is missing or the vault is locked. It then stops the task, checks out the tag, runs `npm ci`, `npx patchright install chromium`, `npm run build`, then restarts the task and prints its status. Running it with no `-Tag` just restarts whatever is currently checked out. Verify with `GET /health` and confirm with `netstat` that nothing is listening on `0.0.0.0`.

## Restart and health

Restart: `scripts\deploy.ps1` (no `-Tag`), or `schtasks /End` + `schtasks /Run` on **"FronyBrowser Server"** directly. Health: `GET /health` → `{ ok, vaultLocked, vaultExists, vaultTtlMs }` (no auth required). A deploy restart comes back unlocked through the handoff below; a crash or reboot does not, and needs `wallet unlock` (`WALLET_SERVER`, `FRONY_KEY`, and admin membership).

Test Mode: `wallet status` (run on the server machine) prints the flag from `<data root>/test-mode.json` and adds the vault state from `/health` when `WALLET_SERVER` is set; `main.ts` also warns at start-up and the console shows a badge. `/health` deliberately does not carry it — agents read that route. Do not leave it on after a rehearsal: every grant-gated fill is silently skipped while it is on, and the response looks exactly like a real one, so a live purchase run would submit an empty PIN field.

Four things to keep in mind operationally:

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

Since FWL-055 there is nothing per-origin to register on this server. A site the server has never seen works as
soon as its values are in the vault; the origin, the browser profile, the keypad selectors and the amount check all
arrive per call from the calling service. Steps, on the server machine:

1. **Sign up as a human** on the site. No seeding is required (FWL-045): the agent logs in itself with the vault
   login keys the first time, and `session_end(loggedIn=true)` creates `sessions/<slug>.dpapi` for the origin, which
   every later `session_begin` injects and every later `loggedIn=true` end refreshes.
2. **Register the values** the site needs — for a form login `<site>.login.id` / `<site>.login.password`, and a
   payment PIN key if it has one. Console, or `wallet set <key> --type <type>` on the server under the service
   account. Every key is `group.subject.field` (FWL-057).
3. **Tick `grant` on the payment keys** in the console. That is the only per-key rule left, and it is what stops a
   payment PIN being filled outside a checkout the calling service vouched for.
4. **Only if the site's PIN keypad is a sprite** (the digits are cells of one background image, so nothing in the
   DOM says which key is which) and the built-in glyph template does not read it (`keypad_unresolved` on every
   attempt): make a template for that site (FWL-073). Save the keypad's sprite PNG from the browser's devtools, note
   the cell size and the digit each cell shows, row by row, and on the server run
   `wallet keypad-template <sprite.png> --cells 25x26 --order 8035/7426/19 --out <site>`. It writes
   `<data root>/keypads/<site>.json`, which the server reads on every fill — no restart. The caller's playbook then
   adds `template: "<site>"` to the sprite keypad spec. The file holds glyph shapes, not values, so it needs no vault.
5. Then the FronyShopping side: `platform add`, the playbook, and a scrubbed capture under its `docs/sites/<id>/`
   (project-shop `docs/operations.md`, "Onboarding a platform"). The browser profile and the keypad selectors for
   this site live there, not here.

## Backup

Not automated in code. The files that matter are `vault.dpapi` and `sessions/*.dpapi` under the data root. A copy of the data root is only usable if restored under the same Windows account and DPAPI is per-account, so a raw file backup does not survive an account or machine change without re-registering the vault.
