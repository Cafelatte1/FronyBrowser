# CLAUDE.md

## Project

FronyBrowser: a security-focused browser MCP server. When browser automation needs personal data (card number, phone, address, login or payment password), the agent sends only a key name such as `{{vault:card.personal.number}}`; the real value stays in this process's memory and goes to the page through CDP. No value ever enters the LLM context, a response, or a log.
Data lives outside the repo in `%LOCALAPPDATA%\Frony\FronyBrowser\data` (moved with `WALLET_DATA_DIR`): the DPAPI-encrypted vault, per-origin login sessions, and the audit log. The policy (`policy.toml` under the data dir, or `WALLET_POLICY`) holds key policies and per-origin settings, names only; `config/policy.example.toml` is the committed template.

Non-negotiable rules, in short: input values are never serialized; the handler folder is the feature whitelist (no `evaluate`, HTML dump, console or network access); every response passes `egress.ts`; the frame origin, not an argument, decides policy; nothing that could hold a value reaches the audit log. The full list with rationale is in [docs/architecture.md](docs/architecture.md). Check any new feature against it before writing code.

## Layout

- `backend/core/` — pure logic, knows neither Playwright nor a protocol (TypeScript)
  - `src/vault.ts`, `src/dpapi.ts` — in-memory vault with unlock TTL; Windows DPAPI at rest
  - `src/policy.ts` — origin allow-lists, `require_selector`, `require_grant`, `expect` comparison
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
- Server: `npm run -w backend/api dev` — needs `FRONY_SERVICE_KEY`; `FRONY_GRANT_KEY` when the policy has a `require_grant` key · `WALLET_LOCAL=1 npm run -w backend/api dev` (local mode: loopback, no FronyAuth, GUI without login)
- Vault: `npm run wallet -- set <key> --type <type>` · `npm run wallet -- unlock` · `npm run wallet -- status` (vault state and dry-run flag)

## Deploy

Runs on the operator's home server (Tailscale address, port `9420`, one process for MCP, internal routes and the approval page) as the Task Scheduler task "FronyBrowser Server". The task is interactive-logon only (an origin with `headless = false` needs a window), so after a reboot the server starts once the account logs on. Bearer tokens are verified by FronyAuth introspection (`FRONY_AUTH_URL`); the vault is locked after every restart until `wallet unlock`.
Release tags only (`vX.Y.Z`); pushing to main changes nothing.
Procedure: push the tag, then on the server run `scripts\deploy.ps1 -Tag vX.Y.Z`; verify `/health` and that nothing listens on `0.0.0.0`. Details in [docs/operations.md](docs/operations.md).

## Docs

`docs/INDEX.md` lists every doc with when to read it. Read the matching doc before changing the vault or session storage, `policy.toml`, a handler or MCP tool, an HTTP route, auth, deploy, or the audit log, and update it in the same branch.

## FronyBoard

This project is tracked by FronyBoard (project key: FWL).
Manage tasks through the FronyBoard MCP tools, following the FronyBoard server instructions.
Task tags: `frontend` / `backend` / `infra` / `docs` for where the work lands, plus
`design` or `test` for what kind it is. Reuse these rather than coining a synonym.
