# Data model

**When to read**: when changing the vault file, session storage, `policy.toml`, or the audit record shape
**Code**: `backend/core/src/vault.ts`, `backend/core/src/dpapi.ts`, `backend/core/src/policy.ts`, `backend/app/src/storage.ts`, `backend/core/src/audit.ts`
**Related**: [architecture](architecture.md), [logging](logging.md), [pay-grant](pay-grant.md)

---

## Storage layout

Root is `WALLET_DATA_DIR`, default `%LOCALAPPDATA%\Frony\FronyBrowser\data` (`backend/core/src/paths.ts:defaultDataDir`; falls back to `./data` when `LOCALAPPDATA` is unset, e.g. non-Windows).

```
<data root>/
  vault.dpapi          single DPAPI blob — all vault entries
  sessions/
    <host-slug>.dpapi   one file per stored login origin (per registrable domain)
  audit.jsonl           append-only, one JSON object per line
  dry-run.json          `{ "dryRun": boolean }` — GUI dry-run switch; missing or unparsable means off
  unlock-handoff.dpapi  transient (FWL-042): DPAPI blob `{ passphrase, unlockedUntil, issuedAt }` written by `/vault/handoff`, deleted by the next start-up on first read; ignored after 10 min
```

`policy.toml` (under the data root, or wherever `WALLET_POLICY` points; not committed — start from `config/policy.example.toml`) holds no secrets, only key names and domains.

## Schemas

### Vault file (`vault.dpapi`)

A DPAPI blob whose plaintext is `key → { type, value }` JSON (`backend/core/src/vault.ts:decode`). Self-contained on purpose: type travels with the value so a CLI or admin GUI needs no `policy.toml` to interpret the file.

| Field | Type | Notes |
|---|---|---|
| `type` | `card` \| `phone` \| `rrn` \| `email` \| `name` \| `address` \| `text` | drives which redaction variants `variants()` generates |
| `value` | string | plaintext, only ever held in process memory once unlocked |

Encryption: Windows DPAPI, user scope, `CRYPTPROTECT_LOCAL_MACHINE` never used. Entropy is `SHA-256(passphrase)` (`backend/core/src/vault.ts:entropyOf`) — the blob needs both the Windows account that encrypted it and the passphrase to open. Writes are atomic (`.vault-<rand>.tmp` + rename, `writeVaultFile`).

### Session storage (`sessions/<slug>.dpapi`)

One file per baseDomain with a stored login — created by the first `session_end(loggedIn=true)` for the origin (FWL-045). Filename is `originSlug(origin)` — the host with non-alnum/`.`/`-` characters replaced by `_` (`backend/app/src/storage.ts:originSlug`). Plaintext is a Playwright `storageState` object (`{ cookies, origins }`), same DPAPI + passphrase-entropy scheme as the vault.

- `hasStorageState(sessionsDir, origin)` checks by filename only (no decryption) — used by `session_begin` to tell "this origin has a stored login" apart from "this origin has none" even while the vault is locked, and by `persistStorageStates` to decide whether an ended session creates a new file.
- `mergeStorageStates` combines every file whose baseDomain matches the target origin's baseDomain into one `storageState` before opening a session — a session only ever receives cookies for its own baseDomain (FWL-017).
- `persistStorageStates` re-splits an ended session's `storageState` back across the matching stored-login files, and creates `<slug>.dpapi` for the session's own origin when no file for its baseDomain exists (FWL-045; only cookies of that baseDomain are written). An existing file is skipped if the new cookie set is less than half the size of the existing one (`shrunk`) — see `backend/app/src/storage.ts:persistSkipReason` (FWL-025; the vendor-specific cookie-name check was dropped in FWL-048). Skips are audited as `storage_persist_skipped`.

### Policy (`policy.toml`)

Parsed by `backend/core/src/policy.ts:parsePolicy`. Everything fails closed: unknown fields, bad enum values, or a missing required field abort server start-up.

`[keys."<name>"]` — `<name>` is `scope.field` (single value: `profile.phone`, `passport.number`) or `scope.instance.field` (several possible: `card.personal.number`, `example-shop.login.id`); the GUI's free-key form accepts only these two shapes:

| Field | Required | Type | Notes |
|---|---|---|---|
| `type` | yes | one of `card,phone,rrn,email,name,address,text` | |
| `allow_origins` | yes | array of exact `scheme://host[:port]` strings; `[]` means stored only (registrable, listed, never fillable) | no wildcards; checked against the **frame** origin of the fill target |
| `confirm` | no | `never` \| `session` \| `always` | defaults to `[defaults].confirm` (`never`) |
| `require_selector` | no | CSS selector string | fill target must match this selector (second line of defense against injection) |
| `require_grant` | no | boolean, default `false` | key can only be filled with a valid pay grant — see [pay-grant](pay-grant.md) |
| `input_mode` | no | `text` (default) \| `keypad` | `keypad` means no `<input>` exists; the server clicks digit buttons |
| `keypad_digit_selector` | required iff `input_mode = "keypad"` and no resolver | CSS selector containing `{digit}` | placeholder is substituted with each digit to locate the button |
| `keypad_digit_resolver` | no (`keypad` only) | `sprite-template` | keypad whose digits are not in the DOM: the server reads each key's sprite cell and matches it against built-in glyph templates ([pay-grant](pay-grant.md#sprite-keypads)) |
| `keypad_key_selector` / `keypad_cell_selector` | required iff `keypad_digit_resolver` is set | CSS selectors | the clickable key, and the element inside it whose computed `background-image`/`background-position` shows the digit |

`[origins."<origin>"]`:

| Field | Required | Notes |
|---|---|---|
| `label` | yes | display name |
| `amount_selector` | no | CSS selector for the page's displayed amount, compared against `session_begin`'s `expect.maxAmount` |
| `kind` | no, default `browser` | target kind the session attaches to (FWL-037). Only `browser` is registered today; start-up refuses a policy that names a kind with no `ActionTarget` |
| `browser` | no, default `chromium` | `chromium` \| `chrome` (system Chrome channel); `kind = "browser"` only |
| `headless` | no, default `true` | `false` only works where an interactive logon session exists; `kind = "browser"` only |

`[approval]`: `timeout` (default `5m`), `wait_max` (default `90s`), `recheck_before_act` (default `true`), `amount_fallback` (`deny`\|`confirm`, default `deny`), `amount_tolerance` (default `3%`), `notify` (default `["page"]`).

### Audit record

See [logging](logging.md) for the full event catalogue. Common shape (`backend/core/src/audit.ts:AuditRecord`): `ts` (added by `createAudit`), `evt`, `sid`, `client`, `traceId`, `origin`, plus event-specific fields. Values are never written; not even hashes (`backend/core/src/audit.ts` header — short values are reversible from a hash).

## Invariants and validation

- **Fail-closed policy parsing**: an unknown field, a missing `allow_origins`, or a malformed duration/percent string aborts `loadPolicy` and the server never starts (`backend/core/src/policy.ts:rejectUnknown`).
- **No wildcard origins.** `allow_origins` and `[origins."..."]` keys must be an exact `http(s)` origin with no path and no `*` (`assertOrigin`).
- **`keypad_digit_selector` requires `{digit}`** and is rejected outside `input_mode = "keypad"`. It cannot be combined with `keypad_digit_resolver`; the resolver requires both `keypad_key_selector` and `keypad_cell_selector`, and only `sprite-template` is accepted.
- **Vault and policy key lists are never cross-checked.** A key present in policy but absent from the vault fails at fill time with `key_not_found`; a key present in the vault but absent from policy fails with `origin_not_permitted` (both paths are deliberately indistinguishable to the caller — see [tool-surface](tool-surface.md#error-shape) — so vault contents cannot be probed).
- **`FRONY_GRANT_KEY` is mandatory if any key has `require_grant = true`** — checked at start-up in `backend/api/src/main.ts` via `policyRequiresGrant`.
- **Session storage never mixes baseDomains**: a session for origin A never receives origin B's cookies even if both have stored logins (`mergeStorageStates` filters by `baseDomain`).

## Ids and timestamps

- Session ids: `s_<32 hex chars>` from `randomBytes(16)`, issued by `backend/core/src/session.ts:begin` — never caller-supplied (rule 8).
- Audit timestamps: `new Date().toISOString()` (UTC, milliseconds), stamped at `append()` time — not caller-supplied.
- Vault/session file writes use `randomBytes(6)` for temp-file suffixes, not as identifiers.

## Migration policy

No migration tooling exists. The vault and session file formats are read and rewritten wholesale on every mutation (`writeVaultFile`, `persistStorageStates`); a schema change means updating `decode`/`VALUE_TYPES` and requires re-registering existing keys through the CLI or GUI, since old files with an unrecognized shape are rejected (`vault file: malformed entry for key "..."`).
