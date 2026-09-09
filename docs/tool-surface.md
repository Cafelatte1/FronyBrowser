# MCP tool surface

**When to read**: when adding, renaming or regrouping a tool, or editing a tool description
**Code**: `backend/api/src/mcp/server.ts`, `backend/api/src/handlers/impl.ts`, `backend/api/src/handlers/index.ts`
**Related**: [architecture](architecture.md), [http-api](http-api.md), [data-model](data-model.md)

---

## Tools by group

All tools are registered in `backend/api/src/mcp/server.ts:buildMcpServer`. The MCP tool list is the `HANDLERS` whitelist (`backend/api/src/handlers/index.ts`) minus admin-only handlers (`vault_unlock`, and vault set/rm/list which live only under `vault-admin.ts`) minus the internal-only `sweep_expired`.

- **Session**: `session_begin`, `session_list`, `session_status`, `session_end` — a session is one target origin with an exclusive lease; see [architecture](architecture.md#request--data-flow). `session_list` / `session_status` report the session's target `kind` (`browser` today) next to the browser profile fields, which only browser sessions carry.
- **Page action**: `snapshot`, `navigate`, `fill`, `click`, `select`, `wait`, `page_switch` — act on the current session's browser context via `ref`s from the last `snapshot`. Snapshot refs cover headings, links, buttons, form fields, ARIA widgets and images, plus `clickable` (FWL-029): elements with no proper role but an `onclick`, a focusable `tabindex`, or a computed `cursor: pointer` and visible text — the outermost such element that contains no proper ref target. Delegated-handler `div` buttons (some sites' popups) are reached this way; agents should prefer a `button`/`link` with the same label when both exist. Same-origin links carry `href=<pathname>` (origin and query string stripped — a query can hold a token), so an agent can also reach a result with `navigate` (FWL-043).
- **Current page follows the browser** (FWL-043, 2026-09-07 decided): when a click opens a new tab or popup, that page becomes the session's current page for every later `snapshot`/action, `click` returns its URL, and `session_status.url` reports it; the refs of the previous page go stale (new generation). If the current page closes itself (a card-issuer popup), the most recently opened live page becomes current. Earlier pages stay open; `session_status.pages` lists them as `{ index, url, current }` with the query string stripped. The one escape hatch is `page_switch({ index })`, for the rare case of returning to the product tab after an ad opened in a new tab — the tab's selections survive, its refs need a fresh snapshot, and the next tab the site opens is followed again. There is deliberately no tab-close tool (`session_end` closes them all) and no auto-follow origin restriction yet; that is decided with the PG-window design.
- **Lean by default** (FWL-044, 2026-09-07 decided): opt-in flags are not used by mid-tier agents (the 2026-09-07 live run never touched `filter`), so the default tree already drops what carries no action and no information — images with no name, inside a link or button, or with the same name as the neighbouring element, `footer`/`contentinfo` regions, and body text that does not look like a price (`\d원`) — and folds a run of three or more identical unnamed elements (the secure keypad) into one line `×N [ref=first..last]` whose every ref is valid. Collection and numbering are untouched, so a ref is the same in lean and raw. `text: true` adds all body text; `raw: true` returns the complete tree. The header is never cut (the login marker lives there). Measured 2026-09-07 on the deployed server (raw → lean lines): site A search ~480 → ~180, site B search ~523 → ~355, site B product 293 → 137 (details in FWL-044). Same-label link+button pairs (site B filters) are deliberately not merged — which of the two reacts to a click is unknown.
- **Snapshot slices** (FWL-043): `snapshot({ filter: "interactive" })` returns only buttons, links, form fields, ARIA widgets and clickables (no headings, images or text); `snapshot({ ref })` returns only that element's subtree (the ref must come from the latest snapshot, else `stale_ref`). Both walk and number the whole page exactly like the full tree and only choose which lines to print, so on an unchanged page the same element has the same ref index in a slice and in the full tree. Every snapshot call, sliced or not, still opens a new generation — only the latest snapshot's refs are valid.
- **Vault (read-only)**: `vault_list` — names and types only, never values.
- **Approval**: `approval_wait` — long-polls a pending-approval token; always returns `approval_expired` in this codebase (v2 channel not implemented, see [architecture](architecture.md#approval-model)).

Not exposed over MCP: `vault_unlock` (admin device key or GUI session only, via `/vault/unlock`), vault `set`/`rm`/`list` writes (admin only, via `/vault/*`), `sweep_expired` (internal timer in `main.ts`).

## `instructions=` vs tool descriptions

Everything the agent reads is English and service-neutral (FWL-039): no consumer service, site or PG is named, and `backend/test/integration/mcp.test.ts` fails on Hangul or such names in `instructions`, descriptions or schemas. The same test pins the names consumers depend on: `session_begin(origin, traceId, expect.maxAmount)`, `session_end(loggedIn)`, `fill(ref, value, grant)` and the `{{vault:key}}` placeholder syntax; the error code `vault_locked` is also referenced by name by consumers, so renaming any error code must be announced.

`INSTRUCTIONS` (server-wide, `backend/api/src/mcp/server.ts`) carries what applies to every tool: the response shape and `retriable`, the codes that need a human and must not be retried (`vault_locked`, `keypad_unresolved`, `grant_required`, `grant_invalid`, `amount_mismatch`, `amount_unavailable`), that values never come back, the session lifecycle, and this server's own tool order (`session_begin → snapshot → actions → session_end`). It deliberately says nothing about when to obtain a grant or how a purchase proceeds — that is the calling service's procedure, and two servers narrating it would drift.

Per-tool `description` strings hold only what is needed to use that one tool: placeholders and the keypad path for `fill`, the `clickable` role for `snapshot`, the `loggedIn` rule for `session_end`, the redirect exception for `navigate`. Stubs (`approval_wait`, `onApproval`) say so explicitly so the agent does not wait on them.

## Adding a tool

1. Add the function to `createHandlers` in `backend/api/src/handlers/impl.ts` (or a new file if it does not fit the whitelist's existing shape) — return `Result<T>`, never a value that isn't already covered by egress scrubbing, and add an audit record for anything that touches policy, the vault, or the browser.
2. Add the name to `HANDLERS` in `backend/api/src/handlers/index.ts` — this list is the feature whitelist (rule 2 in [architecture](architecture.md#absolute-rules)).
3. Register it in `buildMcpServer` (`backend/api/src/mcp/server.ts`) with a Zod `inputSchema` and a `description` that a caller can act on without reading source.
4. Add unit tests under `backend/test/unit/api/handlers.test.ts` and, if it touches the browser, an integration test — see [testing](testing.md).
5. Update this doc's tool table and, if the tool changes what leaves the vault or crosses a frame boundary, re-check the rule table in [architecture](architecture.md#absolute-rules).
