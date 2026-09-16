# FronyBrowser

A privacy-first browser for AI agents. The agent fills in your card number, your login
password and your payment PIN, and never sees a single one of them.

The values live in an encrypted vault on your own machine. The agent drives the browser
through MCP (page_tree, navigate, fill, click) and refers to a value by key name only:

```
fill(ref: "7:e42", value: "{{vault:card.personal.number}}")
```

The placeholder is resolved inside this process and typed into the page over CDP. The
value never appears in a tool result, a page tree, a log or an error message, and never
reaches the model behind the agent — every response leaves through one scrubbing exit, the
page tree never carries input values, and the tool surface is a whitelist (no script
execution, no HTML dump). Why each of those holds is in CLAUDE.md, "Absolute rules".

What it is not: a shopping assistant. It does not decide what to buy or whether a price
is right. The one thing it checks on the value side is that a key registered with the
`grant` flag is filled only with a valid pay grant from the calling service
([docs/pay-grant.md](docs/pay-grant.md)).

## Quick start

Requires Node 20+ and Windows: the vault is sealed with DPAPI under your own Windows account,
so no other account on the machine — and no copy of the file taken off it — can open it.

```powershell
git clone https://github.com/Cafelatte1/FronyBrowser
cd FronyBrowser
npm install
npm test
```

Run the server on your own machine, loopback only, with no authentication service
(local mode, see [docs/operations.md](docs/operations.md#local-mode)):

```powershell
$env:WALLET_LOCAL = "1"
npm run -w backend/api dev
```

For a server other devices reach, run the normal mode. It authenticates every call with a
bearer token, resolved in one of two ways: a static list in the launcher environment
(`WALLET_KEYS="agent:<token>,admin-box:<token>"`), or a FronyAuth introspection endpoint
(`FRONY_SERVICE_KEY`, `FRONY_AUTH_URL`, `FRONY_AUTH_ISSUER`), where FronyAuth issues,
verifies and revokes every key and owns that contract. Either way this service stores no
credential of its own beyond what the launcher hands it. Details in
[docs/operations.md](docs/operations.md#static-keys).

Register it in an MCP client with one of those tokens:

```powershell
claude mcp add --transport http FronyBrowser http://<server>:9420/mcp --header "Authorization: Bearer <device key>"
```

Put values in the vault from the GUI at `http://<server>:9420/` or the CLI, then unlock
it once per server start (the GUI's "Open vault" button does the same as the CLI):

```powershell
npm run wallet -- set card.personal.number --type card
npm run wallet -- unlock
```

There is no per-site configuration on this server. A key name is `group.subject.field`, and the
only rule attached to a key is the `grant` flag you tick in the GUI. Which browser to use, keypad
selectors and amount checks all arrive per call from the calling service.

## Tools

- Session: `session_begin`, `session_list`, `session_status`, `session_end`
- Page: `page_tree`, `page_image`, `navigate`, `fill`, `click`, `select`, `scroll`, `wait`, `page_switch`
- Vault: `vault_list` (names, types, labels and the grant flag — never values or their lengths)

The folder `backend/api/src/handlers/` is the whitelist: a capability that has no handler there does
not exist. Read it before adding one.

## Docs

`docs/` holds only what the code cannot answer: [operations.md](docs/operations.md) (deploying and
running the home server) and [pay-grant.md](docs/pay-grant.md) (the token contract the issuing
service must match). For anything about this codebase, read the code. FronyAuth-backed
authentication lives in FronyAuth, which owns both the implementation and its documentation.
