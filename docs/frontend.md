# Frontend

**When to read**: when changing the vault registration page, its field schema, or its build
**Code**: `frontend/src/`
**Related**: [http-api](http-api.md), [testing](testing.md)

---

## Stack and build

Vite + vanilla TypeScript, no framework. `frontend/src/main.ts` is the whole page logic; `frontend/src/schema.ts` defines the field list and is imported by both the page and its tests. Build: `npm run -w frontend build` (also run as part of the root `npm run build`), output committed at `frontend/dist/` and served by `backend/api/src/http/static.ts` — there is no separate frontend server process (rule 12: `frontend/` never imports backend code; it talks to `/login`, `/health`, `/vault/*` over `fetch`).

## Pages

| Page | File | Shows |
|---|---|---|
| Sign-in | `frontend/index.html` (`#view-login`) + `main.ts` | FronyAuth admin sign-in form |
| Vault console | `frontend/index.html` (`#view-main`) + `main.ts` | Two-pane console (FWL-054, 2026-09-09 decided): a left rail with the vault state card (open / locked / no vault yet / unreachable), the key-group navigation with `filled/total` counts, the DRY RUN state and Sign out; a content pane that edits one group at a time; a sticky bottom bar holding the master password, the entered-field count and the save button |

UI text is English; the visual language is the Frony design system — `frontend/public/ds/tokens.css` (copied from the Claude Design project, dark theme only) with self-hosted Pretendard and JetBrains Mono under `frontend/public/ds/fonts/`, and the brand mark at `frontend/public/brand/frony-mark.ico`. Vite copies `public/` into `dist/` as-is; `static.ts` already serves `.woff2` and `.ico`.

## Data loading and state

- `GET /health` — polled every 30s while logged in, drives the rail's vault state card (open with remaining TTL and a progress bar, locked, no vault yet, or unreachable).
- `GET` / `POST /admin/dry-run` — polled together with `/health`; drives the rail foot: a red DRY RUN card with "Turn off" while on, a "Payments live" line with a "DRY RUN" button while off. Turning it on asks for a `confirm()` first. Requires the `wsess_` token — see [pay-grant](pay-grant.md#dry-run).
- `POST /login` — exchanges FronyAuth admin credentials for a `wsess_` GUI session token.
- `POST /vault/list` — fetched with the entered passphrase to render which keys already have a value (name/type/length only — never the value). The rail's "Open with master password" / "Extend with master password" button runs this and then `/vault/unlock` with the same passphrase, read from the bottom bar (the only password field on the page).
- `POST /vault/set` (with `entries[]`) / `POST /vault/rm` — "Save this group" sends the filled fields of the group currently shown in one request so the server decrypts and re-encrypts the vault once (each DPAPI call spawns a PowerShell process, about a second); fields typed into other groups stay in their inputs until that group is saved. The "Add a key" screen ("Save this key") and delete work one key at a time.
- `POST /vault/unlock` — called right after a successful `/vault/list` by the same rail button; same route and TTL as the CLI `wallet unlock`. The passphrase is never stored client-side.
- Client-side state: `sessionStorage['wallet-wsess']` holds the GUI session token (cleared on logout or a `401`). The vault passphrase itself is never stored — it is read from the password input on each request.

## UI-only features

- **Feedback line**: the main view's status (`#msg`) is a green or red line at the top of the sticky bottom bar, so it is visible whatever the scroll position; it hides itself after 4 s (success) or 10 s (error). The sign-in view keeps its inline error.
- **Field schema and groups** (`frontend/src/schema.ts`): the three built-in groups (`personal` / `card` / `passport`) each carry an id, an English title, a blurb and their fields with per-field regex validation (`checkFields`) run client-side before any `/vault/set` call — if any entered field of the group fails its pattern, nothing is saved. Extra keys not in the schema (`EXTRA_KEY`: `scope.field` or `scope.instance.field`) are registered on the "Add a key" screen and then appear in the rail under a group named after the key's first segment (`groupOf`: `example-shop.login.id` → `example-shop`), where they can be overwritten or deleted like built-in fields.
- **Secret-masked inputs**: schema fields marked `secret: true` (CVV, card password prefix) render as `type="password"`; extra keys whose last segment contains `password`, `pin` or `pw` are masked too (`isSecretKey`); the rest render as plain text so a human can proofread what they typed.
- Key names in `schema.ts` must match `config/policy.example.toml`'s `[keys]` names or a fill using that key will fail — `frontend/test/unit/schema.test.ts` checks this pairing. `frontend/test/dom/gui.test.ts` runs the page in jsdom against a fake server and covers navigation, per-group save, the free-key group, delete, dry-run and the unlock button.
- **Responsive**: below 820px the rail moves above the content and the group navigation becomes a horizontal strip; below 700px a field row folds into two lines.
