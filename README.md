# FronyBrowser

A browser-automation MCP server that fills personal data into web pages without ever
showing the value to the AI agent.

The agent drives the browser through MCP (page_tree, navigate, fill, click) and refers
to secrets by key name only:

```
fill(ref: "7:e42", value: "{{vault:card.personal.number}}")
```

The placeholder is resolved inside this process and typed into the page over CDP. The
value never appears in a tool result, a page tree, a log, or an error message — every
response leaves through one scrubbing exit, the page tree never carries input values, and the
tool surface is a whitelist (no script execution, no HTML dump). Why each of those holds
is in CLAUDE.md, "Absolute rules".

What it is not: a shopping assistant. It does not decide what to buy or whether a price
is right. The one thing it checks on the value side is that a key registered with the
`grant` flag is filled only with a valid pay grant from the calling service
([docs/pay-grant.md](docs/pay-grant.md)).

## Quick start

Requires Node 20+ and Windows (the vault is encrypted with DPAPI, per user account).

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

For a server other devices reach, run the normal mode: it verifies every bearer token
through a FronyAuth introspection endpoint (`FRONY_SERVICE_KEY`, `FRONY_AUTH_URL`,
`FRONY_AUTH_ISSUER`). This service stores no credential of its own; FronyAuth issues,
verifies and revokes every key, and owns that contract.

Register it in an MCP client with a device key issued by FronyAuth:

```powershell
claude mcp add --transport http FronyBrowser http://<server>:9420/mcp --header "Authorization: Bearer <device key>"
```

Put values in the vault from the GUI at `http://<server>:9420/` or the CLI, then unlock
it once per server start (the GUI's "등록 현황 불러오기 · 서버 보관함 열기" button does the same as the CLI):

```powershell
npm run wallet -- set card.personal.number --type card
npm run wallet -- unlock
```

There is no per-site configuration on this server. A key name is `group.subject.field`, and the
only rule attached to a key is the `grant` flag you tick in the GUI. Which browser to use, keypad
selectors and amount checks all arrive per call from the calling service.

## Tools

- Session: `session_begin`, `session_list`, `session_status`, `session_end`
- Page: `page_tree`, `navigate`, `fill`, `click`, `select`, `scroll`, `wait`, `page_switch`
- Vault: `vault_list` (names, types, labels and the grant flag — never values or their lengths)

The folder `backend/api/src/handlers/` is the whitelist: a capability that has no handler there does
not exist. Read it before adding one.

## Docs

`docs/` holds only what the code cannot answer: [operations.md](docs/operations.md) (deploying and
running the home server) and [pay-grant.md](docs/pay-grant.md) (the token contract the issuing
service must match). For anything about this codebase, read the code. Authentication lives in
FronyAuth, which owns both the implementation and its documentation.
