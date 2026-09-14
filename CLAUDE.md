# CLAUDE.md

## Project

FronyBrowser: a security-focused browser MCP server. When browser automation needs personal data (card number, phone, address, login or payment password), the agent sends only a key name such as `{{vault:card.personal.number}}`; the real value stays in this process's memory and goes to the page through CDP. No value ever enters the LLM context, a response, or a log.
Data lives outside the repo in `%LOCALAPPDATA%\Frony\FronyBrowser\data` (moved with `WALLET_DATA_DIR`): the DPAPI-encrypted vault, per-origin login sessions, and the audit log. There is no server-side policy file (FWL-055): which browser to use, keypad selectors and amount checks are the caller's business. The only value-side rule is the vault's per-key `grant` flag.

## Absolute rules

The project exists to stop PII leaks; each rule closes one leak path. Check any new feature or adapter against
every one of them before writing code — the test is "does this create a new path for a value to leave the process."
Code comments cite these by number (`규칙 5`), so the numbering is fixed. 7 was retired with the policy file
(FWL-055) and is not reused.

| # | Rule | Why | Where enforced |
|---|---|---|---|
| 1 | Never serialize `input` / `textarea` / contenteditable values, on any page, vault-filled or not — and never photograph them either | the caller has no reason to read back what it typed | `backend/app/src/snapshot.ts` never reads `.value`; the `SafeSnapshot` brand in `backend/core/src/types.ts` has one producer; `page_image` masks `FIELD_SELECTOR` in every frame |
| 2 | The feature whitelist is `backend/api/src/handlers/` | the scrubber matches plain text, so a single `evaluate` / `btoa(value)` path would defeat it entirely | `backend/api/src/handlers/index.ts`; no `evaluate`, HTML dump, console or network handler exists |
| 3 | Every response passes `egress.ts`, including responses to program callers. `page_image`'s PNG bytes are the one exception — see the decision below | one exit point — the server cannot know whether a caller feeds the response to an LLM | `backend/api/src/egress.ts:scrub`; `ScrubbedResponse` is a branded type only `scrub()` produces |
| 4 | The frame origin is read from the browser, for the frame the target element belongs to — never taken as a caller argument | card fields sit in a cross-origin PG iframe, so a top-level reading would be wrong, and the audit record has to say where the value actually went | `backend/app/src/frames.ts:originOfHandle`; `fill` records it and accepts no origin field |
| 5 | The audit log holds metadata only — never values, never raw exception objects, never grant tokens | Playwright error messages sometimes contain the value that was being typed | the `AuditRecord` type in `backend/core/src/audit.ts`; `failFromUnknown` in `types.ts` drops the original message |
| 6 | No Playwright trace, video or HAR | the worst case leaks the whole browsing context to disk | `backend/app/src/context.ts` — `newContext` never sets `recordVideo` / `recordHar` |
| 8 | Session ids are server-issued | a caller-chosen id could be guessed and hijacked by another caller | `backend/core/src/session.ts:begin` generates `s_<32 hex>` |
| 9 | Approval never falls back automatically | if nobody clicks, the flow expires or fails — it must not proceed | the channel itself is v2; only its contract shape exists, in `backend/core/src/contract.ts` |
| 10 | Never bind `0.0.0.0` — Tailscale address or loopback only, with Bearer auth on top | network trust alone must not be the only guard | `backend/api/src/http/server.ts:assertBindable` |
| 11 | Login sessions (`storageState`) are never plaintext at rest | session cookies are password-equivalent | `backend/app/src/storage.ts` — DPAPI plus passphrase-derived entropy, the same scheme as the vault |
| 12 | `frontend/` never imports backend code | keeps vault code out of a client bundle | `frontend/src/` talks only to HTTP routes; `backend/api/src/http/static.ts` is the only serving point |
| 13 | A key carrying the vault's `grant` flag is never filled without a pay grant | it protects irreversible actions — payment passwords | `backend/core/src/grant.ts`, enforced in `handlers/impl.ts:fill`; the issuer-side contract is [docs/pay-grant.md](docs/pay-grant.md) |

## Design decisions

Why the code looks the way it does. The behaviour itself is in the code; these are the reasons that are not.

- **The vault and the browser driver run in one process.** The agent only ever sees `{{vault:key}}` and the value travels memory → CDP. This removes the deterministic leak path instead of filtering it.
- **No server-side policy file** (FWL-055). Per-site rules made every new site an operator task. Which browser to use, keypad selectors and amount checks are the caller's business now; the only value-side rule left is the per-key `grant` flag. The frame origin is still read and audited, but it no longer gates a fill.
- **Approval never uses MCP elicitation.** The moment approval is needed is the moment the model is untrusted, and elicitation would route the confirmation through that same model. The server would own its own channel; until that exists there is no approval tool.
- **The tool that returns the element tree is `page_tree`, not `snapshot`** (FWL-060). The picture of the page is `page_image`, and the conventional pair — `snapshot` / `screenshot` — differs by two letters, which is a poor thing to ask a model to choose between under time pressure. Both are named after what they return instead. The internal vocabulary still says snapshot (`SafeSnapshot`, `buildSnapshot`): the artifact is unchanged, and the tool name is the only part an agent reads.
- **`page_image` is the one response the scrubber cannot clean** (FWL-062). Plain-text matching finds nothing inside pixels, and scrubbing the base64 instead would be worse than useless — a card's last four digits are one of its variants, and four digits appear somewhere in any 200 KB base64 string, so a false hit would corrupt the image. Input fields are masked in every frame before the shutter, which draws rule 1's line in pixels; the masks reach into the payment iframe, which is where the card number lives and where a main-frame-only implementation would have left exactly the wrong field showing. What the site itself renders — a delivery name, phone, address — is captured as it looks. That is a deliberate trade and the tool description says so: the tree redacts those, the picture does not. Masking by value was considered and dropped: boxing the matching element covers far more than the value and the card's last-four variant matches stray digits, while rewriting the DOM before the shot is something this codebase does not do — `safeText` clones rather than mutates, and a checkout page under a bot manager is the worst place to start.
- **`page_image` is scaled to a 1024px long edge** (FWL-066), and that is not a parameter. A 1920x1080 shot costs about 1,844 tokens and most of it buys nothing: read at a 1024px long edge, the same search page still gives up every price, filter count and sort option for 786 tokens, while at 640 a price read as 1,640 where it was 2,640 — the one thing the picture exists to convey, wrong, and wrong silently rather than illegibly. A parameter would only invite an agent to pick at random. The downscale is a box filter so that solid regions keep their exact colour: the input masks are large solid rectangles, and only their edge pixels blend. Size is read back from the resulting PNG rather than from the viewport, which also retired the `evaluate` that read `innerWidth` because `viewportSize()` is null on the `chrome` profile.
- **`scroll` takes a ref, not a pixel offset** (FWL-061). A window-level scroll does nothing when the element sits in a modal or side panel with its own overflow, and checkout flows are full of those. The agent always has refs, so a ref costs it nothing.
- **The default page tree is lean** (FWL-044, narrowed in FWL-059): it drops only decoration and repetition — unnamed or duplicated images, footer regions, and text an element line already carries as its name — and folds unnamed runs. `raw: true` is the escape hatch, and refs are identical in both modes. There is one verbosity dial, not two: body text used to be dropped unless it looked like a price, but that rule guessed at what matters and hid inline errors and click results, and **an agent cannot ask for what it cannot see is missing** — the symmetric-looking argument for an opt-in flag does not hold. A name is cut at 60 characters with a price that falls off the end appended, because a product card is one link and its price is why the agent is reading it.
- **A session is one origin with an exclusive lease** (FWL-017) — two sessions on the same origin would destroy each other's checkout page. A lease held by the *same* client is taken over rather than refused (FWL-036), so an agent that lost its `sessionId` does not wait out the TTL; another client still gets `lease_conflict`.
- **The current page follows new tabs** (FWL-043), so an agent carries no tab state. `session_status.pages` lists what is open and `page_switch` is the only way back; there is deliberately no tab-close tool.
- **`navigate` stays on the session's site — same scheme and registrable domain, any subdomain — while page-initiated redirects flow freely** (FWL-069). PG, social login and card auth all redirect; the check exists to catch a caller wandering off, not to sandbox the site. It used to compare the exact origin, which blocked typed URLs that a click could reach: a bookstore measured on 2026-09-14 spreads home, product, search and store across four subdomains, so a stored product URL was unreachable from a session opened on the home origin. The lease (FWL-017) and the stored login file are still per exact origin. A session never re-binds: discovery of an unknown site happens in its own session, and the real session begins on the origin found.
- **Seeding a login is optional and a logged-out session is not an error** (FWL-045). The old fail-closed `login_required` check made every new site an operator task. The first `session_end(loggedIn=true)` for an origin creates its stored login.
- **The server reports only what it knows about login** (FWL-046): `storedLogin` says a stored context was injected, nothing more. Selector-based login checks were retired — they duplicated the agent's own judgment from the page tree, cost a navigation at begin, and needed per-site selectors nobody maintained.
- **Cookies are re-persisted only on `session_end(loggedIn=true)`** (FWL-026), and skipped when the new state is smaller than the stored one (FWL-025). That shrink guard protects against a wrong `loggedIn=true`, not against any particular bot manager.
- **A remembered launch profile is a better default, never a veto** (FWL-065, corrected in FWL-067). The caller picks browser and headless (FWL-055) and gets it wrong silently: a bot manager blocks by serving an ordinary page, so `session_begin` succeeds, every action succeeds and the audit log shows a normal session — measured on the live log, all three blocked headless sessions on one site ended `normal`, while the combination that worked reached `loggedIn=true` nine times and the blocked ones zero out of three. So "the session ran" teaches nothing, and `session_end(loggedIn=true)` is the only evidence available; it is also the assertion FWL-026 already trusts to overwrite stored cookies, so remembering it adds no new trust. Only a profile the caller **explicitly chose** is learned, because a default nobody picked proves nothing — keepalive omits the profile and passes "the home page loaded" as `loggedIn`, so it would otherwise teach every origin the bundled default. The memory is then used **only when the caller names no profile**, which is where it pays: keepalive renews a login through the combination that can actually log in rather than through headless chromium. Rejecting a differing explicit profile was tried and removed: it made the memory write-once, since the only path that updates it needs an explicit profile that reaches `loggedIn=true` and that profile was exactly the one being refused — a site changing its bot policy would have taken every run down until an operator deleted the file. It was also inverted on the merits, firing only when the caller's declared value disagreed with history, which usually means an operator changed the declared value on purpose. This server's memory is an observation; the caller's playbook is the declaration, and the observation does not overrule it. A remembered profile that cannot launch is forgotten, so an uninstalled Chrome does not leave every omitting caller failing.
- **The audit log marks process restarts** (FWL-065). Sessions the server was killed under leave no `session_end` (4 of 61 in the live log), which is indistinguishable from an abandoned session without a `server_start` line to read the gap against.
- **There is no per-key TTL — the unlock TTL is the only value lifetime.**
- **The passphrase is never persisted; a deploy hands the unlock over through a transient DPAPI file** (FWL-042). Persisting it would reduce the vault to DPAPI-only protection. The file lives only for the restart window, is deleted on first read, and restores the previous deadline rather than granting a fresh TTL.
- **patchright rather than Playwright** (FWL-028): CDP `Runtime.enable` leaves no trace. Some sites also block chromium and headless fingerprints, so the caller can ask for system Chrome headful per session.
- **Login credentials live in the vault.** With no stored login, the agent fills `{{vault:<site>.login.id}}` / `.password` on the login page itself rather than an operator pre-seeding a cookie.
- **Name, gender and birth date are not vault keys**: they are values that may be exposed, and the vault holds only values that must not leak.
- **Every vault key is exactly `group.subject.field`** (FWL-057). One key is one row on the console, and the segment count matching the screen is what makes that true. The server is the enforcement point, not the GUI.
- **The server presses secure-keypad digits itself** (FWL-033). For image-button keypads the caller passes the selectors and the server clicks in PIN order. The grant is consumed only after the fill succeeds, so a failed attempt can be retried.
- **Test Mode is a runtime switch, not a rule** (FWL-035, FWL-056). It rehearses a checkout without paying: every check on a grant-flagged key still runs, and then nothing is typed. The response is identical to a real fill on purpose — an agent that could tell would behave differently in rehearsal than in production.
- **Authentication is delegated to FronyAuth entirely.** This service stores no credential and no token file: every bearer is resolved remotely on first use and cached briefly. Beyond that cache window an outage fails closed — nothing is accepted merely because verification could not be attempted. A failed reach returns `503`, never `401`, because `401` would read as "your key is wrong" and send the operator hunting the wrong thing.
- **The data root follows the home-server Frony convention**, `%LOCALAPPDATA%\Frony\FronyBrowser\data`.

## Layout

- `backend/core/` — pure logic, knows neither Playwright nor a protocol (TypeScript)
  - `src/vault.ts`, `src/dpapi.ts` — in-memory vault with unlock TTL; Windows DPAPI at rest
  - `src/scrubber.ts`, `src/variants.ts` — value → `[REDACTED:key]` for every known variant
  - `src/session.ts`, `src/grant.ts`, `src/audit.ts` — session lease and TTL, pay-grant verification, append-only audit
  - `src/ports.ts`, `src/types.ts` — the `ActionTarget` port and the `ScrubbedResponse` / `SafeSnapshot` branded types
- `backend/app/` — the only place that knows patchright (Playwright fork): browser contexts, a11y snapshots without input values, frame-origin lookup, actions
- `backend/api/` — the process: `egress.ts` (single exit for every response), `handlers/` (the whitelist), `mcp/` (agent entry, streamable HTTP), `http/` (internal routes and static serving of `frontend/dist`)
- `backend/cli/` — vault set/rm/unlock, handoff and status
- `frontend/` — vault registration GUI (Vite + vanilla TS). Must not import backend code; talks HTTP only
- `backend/test/` — `unit/` (no browser), `integration/` (real browser and DPAPI), `live/` (real sites), shared helpers in `helpers/`

Dependency direction is `api → app → core`; never the reverse.

## Commands (from the repo root)

- Test: `npm test` (unit + integration + frontend, about a minute) · `npm run test:unit` · `npm run test:live` (needs `WALLET_SERVER`, `FRONY_KEY`, an unlocked vault)
- Typecheck / build: `npm run typecheck` · `npm run build`
- Server: `npm run -w backend/api dev` — needs `FRONY_SERVICE_KEY`; `FRONY_GRANT_KEY` to fill keys registered with the grant flag (missing → warning at start, `grant_invalid` at fill) · `WALLET_LOCAL=1 npm run -w backend/api dev` (local mode: loopback, no FronyAuth, GUI without login)
- Vault: `npm run wallet -- set <key> --type <type>` · `npm run wallet -- unlock` · `npm run wallet -- status` (vault state and Test Mode flag)

## Deploy

Runs on the operator's home server (Tailscale address, port `9420`, one process for MCP, internal routes and the approval page) as the Task Scheduler task "FronyBrowser Server". The task is interactive-logon only (a session opened with `headless: false` needs a window), so after a reboot the server starts once the account logs on. Bearer tokens are verified by FronyAuth introspection (`FRONY_AUTH_URL`); the vault is locked after every restart until `wallet unlock`.
Release tags only (`vX.Y.Z`); pushing to main changes nothing.
Procedure: push the tag, then on the server run `scripts\deploy.ps1 -Tag vX.Y.Z`; verify `/health` and that nothing listens on `0.0.0.0`. Details in [docs/operations.md](docs/operations.md).

## Docs

`docs/` holds only what the code cannot answer — [operations.md](docs/operations.md) (running this machine: deploy, failures seen, backup and recovery) and [pay-grant.md](docs/pay-grant.md) (the token contract the issuing service has to match). The documents that described this codebase have been deleted, so read the code. Do not write new ones.
Authentication is not documented here — FronyAuth (`project-auth`) owns it outright.

## FronyBoard

This project is tracked by FronyBoard (project key: FWL).
Manage tasks through the FronyBoard MCP tools, following the FronyBoard server instructions.
Task tags: `frontend` / `backend` / `infra` / `docs` for where the work lands, plus
`design` or `test` for what kind it is. Reuse these rather than coining a synonym.
