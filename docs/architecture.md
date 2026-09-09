# Architecture

**When to read**: when adding a component, changing how data flows between them, or checking a rule before writing a new feature or adapter
**Code**: `backend/core/src`, `backend/app/src`, `backend/api/src`
**Related**: [data-model](data-model.md), [tool-surface](tool-surface.md), [http-api](http-api.md), [pay-grant](pay-grant.md), [operations](operations.md)

---

## What it is

FronyBrowser is a security-focused browser-automation MCP server. When a browser task needs personal data (card number, phone, address, login or payment password), the caller sends only a key name (`{{vault:card.personal.number}}`); the real value is substituted inside this process and driven into the page over CDP. No value is designed to reach the caller, a log, or a response body. It runs as a single always-on process on the home GPU server; agents on other machines reach it over Tailscale via MCP.

## Components

| Component | Path | Owns |
|---|---|---|
| core | `backend/core/src/` | Pure logic: vault, DPAPI wrapper, policy, scrubber/variants, session store, pay-grant verification, audit, branded types, the `ActionTarget` port. Knows neither Playwright nor a wire protocol. |
| app | `backend/app/src/` | The only code that knows patchright (Playwright fork): browser pool, per-origin `storageState`, a11y snapshot serialization, frame-origin lookup, the `ActionTarget` implementation (`target.ts`) that performs fill/click/select/navigate/wait/keypad. |
| api | `backend/api/src/` | The process entry point: `egress.ts` (single exit for every response), `handlers/impl.ts` (the feature whitelist logic), `mcp/server.ts` (the only consumer entry), `http/server.ts` (internal routes), `auth.ts`/`auth-admin.ts` (FronyAuth delegation), `keepalive.ts`. |
| cli | `backend/cli/src/` | `wallet` command: vault set/rm/list, unlock, handoff, status. |
| frontend | `frontend/src/` | Vault registration GUI (Vite + vanilla TS), served as static files by `api`. |

Dependency direction is `api → app → core`, never the reverse. `core` defines `ActionTarget` (`backend/core/src/ports.ts`) and never imports `app`. A session carries a target `kind` (FWL-037, 2026-09-07 decided): `policy.toml` `origins.kind` picks it (default `browser`), `createHandlers` takes a `kind → ActionTarget` map and refuses to start when the policy names an unregistered kind, and every handler dispatches on the session's kind. Browser launch options (`browser`, `headless`) live in the browser profile only; a second kind adds its own profile shape and adapter without touching the handlers.

## Request / data flow

MCP call (the only consumer path):

1. Agent calls a tool over `POST /mcp` with `Authorization: Bearer <device key>`.
2. `backend/api/src/http/server.ts` authenticates the bearer via `backend/api/src/auth.ts` (FronyAuth introspection, cached).
3. `buildMcpServer` (`backend/api/src/mcp/server.ts`) routes the call to the matching function in `handlers` (`backend/api/src/handlers/impl.ts`).
4. The handler resolves `{{vault:key}}` placeholders (`backend/core/src/resolve.ts`) against the in-memory vault, checks policy (`backend/core/src/policy.ts`) against the **frame origin** read live from the browser (`backend/app/src/frames.ts`), and calls `ActionTarget` (`backend/app/src/target.ts`) to act on the page via patchright.
5. The handler appends a metadata-only audit record (`backend/core/src/audit.ts`).
6. The plain result passes through `scrub()` (`backend/api/src/egress.ts`), which matches live vault values and their variants (`backend/core/src/variants.ts`) and redacts them, before being serialized as the tool's JSON text response.

Every response — MCP or the internal HTTP routes — goes through the same `scrub()` call (`backend/api/src/egress-context.ts` builds the scrub entries from the live vault on every request).

A `fill` call additionally: resolves the vault key(s) in the value template, checks `require_selector`/`require_grant` from policy, verifies a pay grant if required (`backend/core/src/grant.ts`, see [pay-grant](pay-grant.md)), and dispatches either a normal `fill` intent or, for `input_mode = "keypad"` keys, a `keypad` intent where the server itself clicks digit buttons (`backend/app/src/target.ts`, case `'keypad'`).

## Absolute rules

The project exists to stop PII leaks; each rule closes one leak path.

| # | Rule | Why | Where enforced |
|---|---|---|---|
| 1 | Never serialize `input`/`textarea` values, on any page, vault-filled or not | the caller has no reason to read back what it typed | `backend/app/src/snapshot.ts` (DOM collection never reads `.value`); `SafeSnapshot` brand (`backend/core/src/types.ts`) that only `snapshot.ts:serialize` can produce |
| 2 | Feature whitelist = `backend/api/src/handlers/` | the scrubber matches plain text; one `evaluate`/`btoa(value)` path would defeat it entirely | `backend/api/src/handlers/index.ts` (`HANDLERS` list); no `evaluate`, HTML dump, console or network handler exists |
| 3 | Every response passes `egress.ts`, including responses to program callers | a single exit point; the server cannot know if a caller feeds the response to an LLM | `backend/api/src/egress.ts:scrub`; both `mcp/server.ts` and `http/server.ts` call it; `ScrubbedResponse` is a branded type only `scrub()` can produce |
| 4 | `origin` is read from the browser, per the frame the target element belongs to — never taken as a caller argument | card fields usually sit in a cross-origin PG iframe; a top-level check would block real payments or let an injected iframe receive a value | `backend/app/src/frames.ts:originOfHandle`; `checkFill` in `backend/core/src/policy.ts` takes `frameOrigin`, not a request field |
| 5 | Audit log holds metadata only — never values, never raw exception objects | Playwright error messages sometimes contain the value that was being typed | `backend/core/src/audit.ts` type; `failFromUnknown` in `backend/core/src/types.ts` drops the original error message |
| 6 | No Playwright trace / video / HAR | worst-case: leaks the whole browsing context to disk | `backend/app/src/context.ts` — `newContext` never sets `recordVideo`/`recordHar` |
| 7 | Policy lives server-side only (`policy.toml` on the server); callers cannot pass or override it | limits damage when the agent machine is compromised | `launchProfileFor`/`checkFill` in `backend/core/src/policy.ts` take no caller input; the file is only read by `main.ts`/CLI |
| 8 | Session ids are server-issued | a caller-chosen id could be guessed and hijacked by another caller | `backend/core/src/session.ts:begin` generates `s_<32 hex>` |
| 9 | Approval never falls back automatically | if nobody clicks, the flow expires or fails | see Approval model below |
| 10 | Never bind `0.0.0.0`; Tailscale IP or loopback only, Bearer auth on top | network trust alone must not be the only guard | `backend/api/src/http/server.ts:assertBindable` (allow-list: `127.0.0.1`, `::1`, `100.64.0.0/10`) |
| 11 | `storageState` (login sessions) is never plaintext at rest | session cookies are password-equivalent | `backend/app/src/storage.ts` — DPAPI + passphrase-derived entropy, same scheme as the vault |
| 12 | `frontend/` never imports backend code | prevents vault code from ending up in a client bundle | `frontend/src/main.ts` talks only to HTTP routes; `backend/api/src/http/static.ts` is the only serving point |
| 13 | `require_grant` keys are never filled without a pay grant | protects irreversible actions (payment passwords) | `backend/core/src/grant.ts`, enforced in `backend/api/src/handlers/impl.ts:fill`; see [pay-grant](pay-grant.md) |

New features and adapters are checked against every rule above; the test is "does this create a new path for a value to leave the process."

## Approval model

Approval is an exception path — routine fill and expected-amount payment go through unapproved; anything else stops and needs a human.

| Situation | Handling |
|---|---|
| fill (name, address, phone, card number) | no approval — frame origin on the key's allow-list is enough |
| final payment click, amount matches `expect` | no approval — the caller declared `expect` and the server compared it against the page |
| amount does not match `expect` | a human is called in |
| origin not on the allow-list | denied + audited (`policy_denied`) |

`session_begin`'s `expect.maxAmount` is compared against a page-extracted amount before a `click` (see `backend/api/src/handlers/impl.ts:click`), using the origin's `amount_selector` from policy. No MCP elicitation is used — the moment approval is needed is the moment the model is untrusted, and elicitation would route the confirmation through that same model. Instead the server owns its own approval channel (a static page served by `api`, plus a server-issued token).

Actions never block on approval; they return a token immediately and the caller long-polls:

```
click(sid, ref)             → {status:"pending_approval", token}   returns immediately
approval_wait(token, 90s)   → result or {status:"still_pending"}   caller retries
```

`approval_wait` is idempotent so a caller that restarts can resume with the token. As of this codebase, `approval_wait` always returns `approval_expired` (`backend/api/src/handlers/impl.ts`) — the approval channel itself is v2 and not implemented yet; the request/response shapes already exist in `backend/core/src/contract.ts` so no consumer breaks when it lands. Unattended batch sessions are expected to set `onApproval: "fail_fast"` in `session_begin` rather than wait.

## Where things live

Data root (outside the repo): `WALLET_DATA_DIR`, default `%LOCALAPPDATA%\Frony\FronyBrowser\data` (`backend/core/src/paths.ts:defaultDataDir`). See [data-model](data-model.md) for the full layout, and [http-api](http-api.md) / [tool-surface](tool-surface.md) for the routes and MCP tools that read/write it. Config: `policy.toml` on the server (not committed, no secrets — see [data-model](data-model.md#schemas)); `config/policy.example.toml` is the template. Env vars: see `backend/api/src/main.ts` header, summarized in [operations](operations.md).

## Decisions

- **Vault and browser driver run in one process.** The agent only ever sees `{{vault:key}}`; the value travels memory → CDP. This removes the deterministic leak path (value returned to the model) rather than filtering it.
- **The default snapshot is lean** (FWL-044, 2026-09-07 decided): decorative images, footer regions and non-price body text are dropped and unnamed runs folded, because a mid-tier agent does not opt into slimmer output by itself; `raw: true` is the escape hatch and refs never change between modes.
- **Input values are never serialized**, on any page, vault-filled or not. The a11y snapshot omits `input`/`textarea` values and contenteditable text; the `SafeSnapshot` branded type makes any new adapter inherit this.
- **Feature whitelist = the handlers folder.** No `evaluate`, HTML dump, console or network tools: the scrubber matches plain text, so one `btoa(value)` would defeat it.
- **One egress point for every response** (`backend/api/src/egress.ts`), including responses to program callers — the server cannot know whether the caller feeds them to an LLM.
- **Origin comes from the browser, per frame.** Card fields live in PG cross-origin iframes; checking the top-level URL would either block real payments or let an injected iframe receive the card number.
- **Audit log holds metadata only**: key names, origins, lengths, session and policy decisions. Never values, never raw exception objects, never grant tokens.
- **No Playwright trace / video / HAR.** Disk leak of the whole context.
- **Policy lives server-side only** (`policy.toml` on the server); callers cannot pass or override it. Policy limits damage when the agent machine is compromised.
- **Session ids are server-issued.** Caller-chosen ids could be guessed and hijacked.
- **Approval never falls back automatically** and never uses MCP elicitation: the moment approval is needed is the moment the model is untrusted, and elicitation routes the confirmation through that model. The server owns its own approval channel (static page + server token); the agent long-polls `approval_wait` with an idempotent token instead of blocking.
- **Bind to the Tailscale IP or loopback only; never `0.0.0.0`; never Funnel.** Bearer auth on top, via FronyAuth introspection — network trust alone does not guard the vault.
- **Login sessions (`storageState`) are DPAPI-encrypted at rest.** Cookies are password-equivalent.
- **`frontend/` never imports backend code.** HTTP only, so vault code cannot end up in a client bundle.
- **`require_grant` keys are filled only with a pay grant** issued by the trusted grant issuer (currently FronyShopping `begin_checkout`) (HMAC, `FRONY_GRANT_KEY` shared, 5 minutes, single use, session-bound; verified in `backend/core/src/grant.ts`). Start-up is refused when the policy has such a key and the env var is missing (FWL-022, FWL-033).
- **Session = one target origin, with an exclusive lease** (FWL-017). Two sessions on the same origin would destroy each other's checkout page; purchase flows serialize correctly. A lease held by the **same client** is taken over instead (FWL-036, 2026-09-07 decided): the old session is closed with `session_end reason: replaced`, so an agent that lost its `sessionId` does not wait out the TTL. Other clients still get `lease_conflict`.
- **The current page follows new tabs** (FWL-043, 2026-09-07 decided). A click that opens a new tab or popup makes that page the session's current page; the previous page's refs go stale and `pages` keeps counting the open ones. Auto-follow is the main path so an agent does not carry tab state; `session_status.pages` lists the open pages and `page_switch` is the single escape hatch back to one of them (no tab-close tool). Whether to restrict auto-follow to the session origin is deferred to the PG-window design.
- **`navigate` stays inside the target origin.** Page-initiated redirects (PG, social login, card auth) flow freely; whether a fill is allowed in such a frame is decided per key by `allow_origins`.
- **Cookies are re-persisted only on `session_end(loggedIn=true)`** (FWL-026), and skipped when the new state is smaller than the stored one (FWL-025; the vendor-specific cookie-name check was dropped in FWL-048 — the guard now protects against a wrong loggedIn=true, not a particular bot manager). No periodic re-seeding (2026-09-02 decided).
- **Seeding is optional; a logged-out session is not an error** (FWL-045, 2026-09-07 decided). `session_begin` injects the stored login if one exists and reports `storedLogin`; the agent logs in with the vault login keys when needed, and the first `session_end(loggedIn=true)` for an origin creates its stored login. The old `login_required` fail-closed check is retired — it made every new site an operator task.
- **The server reports only what it knows about login** (FWL-046, 2026-09-08 decided): `storedLogin` says whether a stored context was injected, nothing more. Whether the page is actually logged in is the purchasing agent's judgment from the snapshot, so the selector-based `logged_in_selector` / `login_check` (FWL-023) is retired — it duplicated that judgment, cost a navigation at begin and needed per-site selectors nobody maintained.
- **No per-key TTL; the unlock TTL (`WALLET_UNLOCK_TTL`) is the only value lifetime** (2026-09-02 decided).
- **The passphrase is never persisted; a deploy hands the unlock over through a transient DPAPI file** (2026-09-06 decided, FWL-042). Persisting it would reduce the vault to DPAPI-only protection; the handoff file lives only for the restart window, is deleted on first read, and restores the previous deadline rather than a fresh TTL.
- **Vault ↔ policy key lists are not cross-checked at start-up**; the vault is locked then (2026-09-02 decided).
- **Which click is a payment is not decided here** (2026-09-02 decided). That knowledge belongs to FronyShopping; the wallet only compares `expect.maxAmount` with the page amount, and only where `amount_selector` is configured.
- **Per-origin browser profile** (FWL-027, 2026-09-04 decided): the default is patchright chromium headless; an origin behind a bot manager runs system Chrome headful because chromium and headless fingerprints are blocked there. patchright is used so CDP `Runtime.enable` leaves no trace (FWL-028).
- **Login credentials live in the vault** (2026-09-03 decided): when there is no stored login or its cookie has died, the agent fills `{{vault:<site>.login.id}}` / `password` on the login page; the password key is bound to `input[type='password']` via `require_selector`.
- **Name, gender and birth date are not vault keys** (2026-09-05 decided): they are values that may be exposed; the vault holds only values that must not leak. Key names are `scope.field` for single values or `scope.instance.field` where several can exist (2026-09-06 decided; sites are `site.purpose.field`); the GUI's five personal fields are `profile.*` (`profile.carrier` stays for one-place management); a key with `allow_origins = []` is stored and listed but never fillable, so keys can be registered before a target site exists.
- **Keypad fill mode** (FWL-033, 2026-09-04): for image-button secure keypads the server clicks the digit buttons itself per `keypad_digit_selector`; the grant is consumed only after the fill succeeds.
- **Data root follows the home-server Frony convention** `%LOCALAPPDATA%\Frony\FronyBrowser\data` (2026-09-02).
