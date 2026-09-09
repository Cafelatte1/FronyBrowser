# Testing

**When to read**: when adding or changing a test, or a test fails for a reason you do not recognise
**Code**: `backend/test/`, `frontend/test/`, `vitest.workspace.ts`
**Related**: [architecture](architecture.md)

---

## Run

```
npm test                # unit + integration + frontend, about a minute
npm run test:unit       # unit + frontend only, seconds
npm run test:integration
npm run test:live       # needs WALLET_LIVE=1 (set by the script), WALLET_SERVER, FRONY_KEY, an unlocked vault on that server
```

Four vitest workspace projects (`vitest.workspace.ts`, FWL-019): `unit`, `integration`, `live` (only included when `WALLET_LIVE=1`), `frontend`.

## Layout

| Path | Covers |
|---|---|
| `backend/test/unit/core/` | vault, dpapi-independent logic, scrubber, variants, resolve, session, policy, grant, types — no browser, no disk, no network. The weight of this project's regression coverage lives here |
| `backend/test/unit/app/` | `storage.ts` (session file merge/split/skip logic) without real DPAPI |
| `backend/test/unit/api/` | auth cache/fail-closed behavior, bind allow-list, keepalive, handlers (egress/policy wiring) with fakes |
| `backend/test/integration/` | real patchright browser, real DPAPI, local HTTP: `snapshot.test.ts` (rule 1 regression — never skip or delete), `mcp.test.ts`, `gui-http.test.ts`, `keypad.test.ts`, `dpapi.test.ts`, `storage-wiring.test.ts`, `browser-pool.test.ts` (idle browser shutdown, FWL-036) |
| `backend/test/live/` | real server + the operator's own sites — untracked (gitignored), kept on the operator's machine. `npm run test:live` needs `WALLET_LIVE=1`, `WALLET_SERVER`, `FRONY_KEY`, an unlocked vault |
| `frontend/test/unit/` | `schema.test.ts` — schema ↔ `config/policy.example.toml` cross-check plus the field regex (`checkFields`) cases |
| `frontend/test/dom/` | `gui.test.ts` — jsdom render + login/save/delete flow, checks what leaves the page in request bodies |

## Fixtures and helpers

All backend suites share `backend/test/helpers/`:

- `fakes.ts` — `fakeCipher` (entropy-checking stand-in for DPAPI), `fakeVault`, `fakeTarget` (an `ActionTarget` fake for handler tests without a browser), and `signPayGrant`/`freshGrant`, a test-only pay-grant signer (the real issuer is FronyShopping; see [pay-grant](pay-grant.md))
- `mcp-client.ts` — `connectMcp(baseUrl, bearer)`, used by both integration and live tests to call tools and read the raw text body (for scrub-hit checks)
- `live.ts` — `liveEnv()` (fails loudly, not silently, if `WALLET_SERVER`/`FRONY_KEY` are missing), `requireUnlocked`, `probeOrigin`

Do not duplicate these — extend them instead.

## Dry-run rehearsal

To rehearse a real checkout without a charge ([pay-grant](pay-grant.md#dry-run)):

1. In the registration GUI, click "DRY RUN 켜기" — the red "DRY RUN" badge must be visible in the header.
2. Run the E2E shopping flow (FronyShopping → `session_begin` → … → `fill` of the payment PIN with a grant). The payment frame opens but the PIN is never typed.
3. The agent ends with `abort_transaction` ("no order"); confirm in the shop that no order exists and in `audit.jsonl` that the `fill` record has `dry: true`.
4. Click "DRY RUN 끄기" and check the badge is gone before any real purchase.

A sprite-keypad site: the dry run must reach the PIN popup and end with a `fill {mode: keypad, resolver: sprite-template, dry: true}` audit record. A `keypad_unresolved` there means the sprite or markup changed — capture the new sprite next to `backend/test/fixtures/sprite-keypad-*.png` and regenerate `backend/core/src/keypad-glyphs.ts` before the real run.

## Conventions

- Unit tests must not touch a browser, DPAPI, disk, or the network; use the fakes.
- `frontend/test/` must not import backend code (rule 12) — cross-check `config/policy.example.toml` by parsing it directly with `smol-toml`, as `schema.test.ts` does.
- New tests that assert "no leak" should check the raw response text (as `mcp.test.ts`/`gui.test.ts` do), not just the parsed object, since a leak could hide in a field the assertion does not otherwise inspect.
- When a new redaction variant is found on a real site (e.g. `010****5678`, `+82 10-...`), add a case to `backend/test/unit/core/variants.test.ts` — this is the primary ongoing maintenance activity for this codebase, since Playwright already verifies the browser mechanics but nothing else catches a missed variant.
