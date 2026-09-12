# Logging

**When to read**: when adding an audit event or field, or reading the log files
**Code**: `backend/core/src/audit.ts`, call sites across `backend/api/src` and `backend/app/src`
**Related**: [data-model](data-model.md), [operations](operations.md)

---

This service does not use the loguru JSON Lines logging the other Frony services share; `audit.jsonl` has its own fixed, narrower field set because it is a security control, not a general event log — see [architecture](architecture.md#absolute-rules) rule 5 (never write a value).

## Files and retention

| File | Stream | Retention | One line per |
|---|---|---|---|
| `<data root>/audit.jsonl` | append-only JSON Lines | unbounded — `createAudit` only appends, no rotation in code | one audited action, decision or lifecycle event |
| `%LOCALAPPDATA%\Frony\FronyBrowser\logs\server.log` | plain text | managed by the launcher (outside this repo), not by application code | one line per `console.log`/`console.error`/`console.warn` call in `backend/api/src/main.ts` |

`server.log` is stdout/stderr text (server start message, DPAPI warnings, keepalive TTL banner, uncaught process errors), not structured — read it for "is the process even running" and startup failures, not for per-request detail.

## Common fields

Every `audit.jsonl` line (`backend/core/src/audit.ts:AuditRecord`):

| Field | Meaning |
|---|---|
| `ts` | ISO 8601 UTC timestamp, stamped by `createAudit.append` |
| `evt` | event name, see below |
| `sid` | session id, or `null` for events with no session |
| `client` | caller id from auth (`key:...`/`oauth:...`), or `null` |
| `traceId` | caller-supplied opaque string from `session_begin`, or `null` |
| `origin` | the relevant origin (usually the fill/click **frame** origin), or `null` |

Never present: any vault value, any hash of a value, a raw exception message, or a pay-grant token.

## Events

| Event | Extra fields |
|---|---|
| `session_begin` | `kind`, `profile` (the launch profile the policy chose, e.g. `{ kind, browser, headless }`), `expect`, `onApproval` |
| `session_end` | `reason` (`normal`\|`ttl`\|`replaced` — the same client began a new session on the origin, FWL-036), `loggedIn` (on normal end only) |
| `snapshot` | `generation`, `pages`, `slice` (`ref`\|`interactive`\|`null` — which slice was requested, FWL-043), `raw`, `text` (the FWL-044 flags); never the ref string or the tree |
| `navigate` | `url` |
| `page_switch` | `index`, `url` (the page made current, FWL-043) |
| `fill` | `key`, `len`, `ref`, `role`, `mode` (`text`\|`keypad`), `resolver` (`sprite-template`, sprite keypads only), `grant: true` when a grant was consumed, `dry: true` when dry-run skipped the input (grant still consumed) |
| `click` | `ref`, `role` |
| `select` | `ref`, `role` |
| `wait` | `ref`, `timeoutMs` |
| `action_failed` | `kind` (`navigate`\|`click`\|`fill`\|`select`\|`wait`\|`snapshot`), `ref?`, `key?` (fill only, no `len`), `code` |
| `policy_denied` | `key?`, `rule` (`unknown_key`\|`origin`\|`selector`\|`session_origin`\|`vault_missing`\|`keypad_digits_only`) |
| `expect_mismatch` | `expected?`, `observed` |
| `grant_denied` | `key`, `reason` (`missing`\|`no_grant_key`\|`malformed`\|`bad_signature`\|`expired`\|`session_mismatch`\|`reused`) — see [pay-grant](pay-grant.md) |
| `scrub_hit` | `handler`, `key`, `count`, `url` — non-zero means the structural filter missed a leak path; treat as a bug alarm |
| `vault_unlock` | `ok` |
| `vault_lock` | `reason` (`ttl`) |
| `vault_handoff` | `ok`, `remainingMs` — unlock handed to the next process (FWL-042); the matching start-up `vault_unlock` carries `source: handoff` |
| `vault_set` / `vault_rm` | `key`, `ok`, `len?` (set only) |
| `dry_run_set` | `on`, `client` (`admin:<username>` of the GUI session that flipped it) |
| `storage_persist_skipped` | `host`, `reason` (`shrunk`) |
| `auth_failed` | `reason` (`missing`\|`inactive`\|`not_admin`) |
| `gui_login` | `username`, `addr`, `ok`, `status?` — local mode logs `username: "local"` |
| `keepalive` | `ok`, `code?` |
| `approval_created` / `approval_granted` / `approval_denied` / `approval_expired` | reserved for the v2 approval channel; not emitted by any code path yet |

## Recipes

```bash
# every scrub hit — should be empty; each line is a leak the structural filter missed
jq 'select(.evt == "scrub_hit")' audit.jsonl

# denials for one origin
jq --arg o "https://www.example-shop.com" 'select(.evt == "policy_denied" and .origin == $o)' audit.jsonl

# pay-grant rejections and why
jq 'select(.evt == "grant_denied") | {ts, key, reason}' audit.jsonl

# reconstruct one session's timeline
jq --arg sid "s_..." 'select(.sid == $sid)' audit.jsonl

# skipped cookie re-persist (the agent will log in again next session)
jq 'select(.evt == "storage_persist_skipped")' audit.jsonl
```
