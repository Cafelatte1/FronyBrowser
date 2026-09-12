# Pay grant contract (FWL-022)

**When to read**: when changing the grant token format, or integrating a caller that issues grants
**Code**: `backend/core/src/grant.ts`, `backend/api/src/handlers/impl.ts` (`fill`)
**Related**: [operations](operations.md)

The issuer lives in another repo and has to match this byte for byte, which is why this document exists. Everything
else about grants is in the code.

---

A key to an irreversible action — a payment password — is never filled without proof that the payment is a legitimate transaction. That proof is the pay grant.

Wallet does not decide what to buy or whether the price is right — it holds no business logic. That judgment is made by FronyShopping as it passes `open_transaction` → `identify_item` → `check_cart`, and the pay grant hands that verdict to wallet as **one signed token**. The two servers never call each other — they share one symmetric key (`FRONY_GRANT_KEY`), and the token travels through the agent's hands. Even if the agent is prompt-injected, it cannot forge the signature, so passing the token through it is not itself a risk.

| Role | Who |
|---|---|
| Issue | the grant issuer — the calling service that owns the purchase decision; currently FronyShopping `begin_checkout` (only after `check_cart` passes, for the same session) |
| Carry | the agent (passed as-is in `fill`'s `grant` argument) |
| Verify | FronyBrowser `fill`, only for keys carrying the vault's `grant` flag (`backend/core/src/grant.ts`) |

## Token format

```
pg1.<payloadSeg>.<sigSeg>
```

- `payloadSeg` = base64url (no padding) of the UTF-8 JSON payload
- `sigSeg` = base64url (no padding) of `HMAC-SHA256(key = secret string UTF-8, message = payloadSeg as an ASCII string)` — the signature covers the **`payloadSeg` string itself**, not the decoded JSON.

Payload:

```json
{
  "v": 1,
  "txn_id": "<FronyShopping transaction id>",
  "session_id": "<wallet sessionId>",
  "max_total": 23400,
  "iat": 1800000000,
  "exp": 1800000300
}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | fixed `1` | any other value → `malformed` |
| `txn_id` | string | FronyShopping's transaction id, for joining audits |
| `session_id` | string | the **wallet-issued** sessionId; used from another session is rejected |
| `max_total` | integer | the cap for that transaction; wallet only records it, never judges against it |
| `iat` | integer (unix seconds) | issue time |
| `exp` | integer (unix seconds) | `iat + 300` — TTL fixed at 300 seconds |

`max_total`/`iat`/`exp` must be integers (`Number.isInteger`); otherwise `malformed`.

## Verification order (fail-closed)

`verifyPayGrant(token, key, { sessionId, nowMs, used })` checks in this order and stops at the first failure:

1. Splitting on `.` must yield exactly 3 parts with prefix `pg1`, or → `malformed`
2. Recompute the HMAC over `payloadSeg` and compare with `timingSafeEqual`; a length mismatch also counts as → `bad_signature`
3. Payload JSON parsing/field validation failure → `malformed`
4. `exp * 1000 <= nowMs` → `expired` (the boundary value counts as expired)
5. `session_id !== sessionId` → `session_mismatch`
6. token already used → `reused`
7. Pass → verification only. `used` is added by the caller (the `fill` handler) **only after the fill actually succeeds** (single-use, FWL-033) — a failed attempt (e.g. `element_not_actionable`) does not burn the grant, so the same grant can be retried.

Three layers of defense: **signature** (forgery), **`exp` 300s** (replay window), **session binding + single-use** (replay). The `used` set lives only in the wallet process and is empty after a restart, but by then most tokens have already expired.

## Failure codes seen by the caller

| Code | When | retriable |
|---|---|---|
| `grant_required` | key requires a grant but no `grant` argument was given | false |
| `grant_invalid` | the grant was rejected for any of reasons 1–6 above | false |

**Which step failed is never told to the caller.** The reason (`malformed`/`bad_signature`/`expired`/`session_mismatch`/`reused`/`no_grant_key`) is recorded only in the audit log's `grant_denied` event's `reason` field — this avoids giving a caller a way to refine and retry a forged token.

The audit log never records the token itself (rule 5). A successful fill that consumed a grant carries only a `grant: true` field.

## Sprite keypads

One simple-pay PIN keypad (inside the provider's iframe) has no digit anywhere in the DOM: each key is `<a class="pad-key" data-key="N">` showing one 25×26 cell of a per-session sprite PNG, and the shuffle is baked into that PNG. The caller passes `keypad: { keySelector, cellSelector, resolver: "sprite-template" }` on `fill` (FWL-038, selectors moved caller-side in FWL-055): the browser adapter reads the computed `background-image` data URL and `background-position` of every `cellSelector` element under `keySelector`, and `backend/core/src/keypad-sprite.ts` crops each cell to its alpha bounding box and compares it byte-for-byte with the glyph templates in `keypad-glyphs.ts` (generated from a captured sprite; a second capture from another session matches exactly, see `backend/test/unit/core/keypad-sprite.test.ts`). The fill then clicks the keys in PIN order.

Fail-closed: not exactly ten cells, more than one sprite image, a cell matching zero or several templates, the same digit twice, or a key count that changes between resolving and clicking → `keypad_unresolved` (not retriable) and nothing is clicked. No sprite, cell, or resolved digit leaves the process; the audit `fill` record carries only `mode: keypad`, `resolver` and `len`. A changed glyph set on the site means a new capture and regenerated templates, never approximate matching.

## Test Mode and the issuer

Test Mode (FWL-035, renamed in FWL-056) rehearses a checkout without paying. It is a runtime switch on this server,
toggled from the console and persisted across restarts — not a policy flag and not something the token carries.

What the issuer has to know: while it is on, a `fill` on a grant-flagged key still runs every check above and
**consumes the grant**, but nothing is typed. The response is identical to a real fill, deliberately, so the agent
cannot tell. The PIN field therefore reaches the payment step empty and the run should end with the issuer's own
abort path, not a payment. Grants carry no test flag and the switch is global, never per key.

## Operations

The `grant` flag is per vault key, set in the console (FWL-055 retired the policy file that used to carry it). A key
with the flag on is never filled without a grant.

- If `FRONY_GRANT_KEY` is unset, every grant-flagged fill fails closed with `grant_invalid`, and the server warns at
  start-up. It never silently skips verification.
- **Both launchers must hold the same `FRONY_GRANT_KEY`.** FronyBrowser (`9420`) and the issuing service (`9430`) are
  separate processes on the same home server, so the value is set independently in each launcher script. Changing it
  means updating both and restarting both together; updating only one turns every issued token into a
  `bad_signature`, which surfaces only at the payment step.
- The key is a shared secret and is never committed — it lives only in the launcher files.
