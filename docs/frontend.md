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
| Registration / login | `frontend/index.html` + `main.ts` (`view-login` / `view-main` sections) | FronyAuth admin login form; once authenticated, vault field sections with registered/empty badges and a save-all flow |

## Data loading and state

- `GET /health` — polled every 30s while logged in, drives the "vault locked/unlocked/TTL remaining" header text.
- `GET` / `POST /admin/dry-run` — polled together with `/health`; drives the header "DRY RUN" badge (rendered only while on) and the toggle button ("DRY RUN 켜기" / "DRY RUN 끄기", the latter styled `danger`). Turning it on asks for a `confirm()` first. Requires the `wsess_` token — see [pay-grant](pay-grant.md#dry-run).
- `POST /login` — exchanges FronyAuth admin credentials for a `wsess_` GUI session token.
- `POST /vault/list` — fetched with the entered passphrase to render which keys already have a value (name/type/length only — never the value). The "등록 현황 불러오기 · 서버 금고 열기" button runs this and then `/vault/unlock` with the same passphrase.
- `POST /vault/set` (with `entries[]`) / `POST /vault/rm` — the save button sends every filled field in one request so the server decrypts and re-encrypts the vault once (each DPAPI call spawns a PowerShell process, about a second); the free-key form and delete work one key at a time.
- `POST /vault/unlock` — called right after a successful `/vault/list` by the same button; same route and TTL as the CLI `wallet unlock`. The passphrase is never stored client-side.
- Client-side state: `sessionStorage['wallet-wsess']` holds the GUI session token (cleared on logout or a `401`). The vault passphrase itself is never stored — it is read from the password input on each request.

## UI-only features

- **Toast messages**: the main-view status line (`#msg`) is a fixed top-right toast that hides itself after 4 s (success) or 10 s (error), since the page is long enough that a bottom message needs scrolling. The login view keeps its inline message.

- **Field schema and sections** (`frontend/src/schema.ts`): the registration form is organized into sections ("개인정보" / "카드정보" / "여권정보") with per-field regex validation (`checkFields`) run client-side before any `/vault/set` call — if any entered field fails its pattern, nothing is saved. Extra keys not in the schema (`EXTRA_KEY`: `scope.field` or `scope.instance.field`) can be added via a free-form key/type/value form and are listed separately.
- **Secret-masked inputs**: fields marked `secret: true` (CVV, card password prefix) render as `type="password"`; the rest render as plain text so a human can proofread what they typed.
- Key names in `schema.ts` must match `config/policy.example.toml`'s `[keys]` names or a fill using that key will fail — `frontend/test/unit/schema.test.ts` checks this pairing.
