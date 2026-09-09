# FronyBrowser

A browser-automation MCP server that fills personal data into web pages without ever
showing the value to the AI agent.

The agent drives the browser through MCP (snapshot, navigate, fill, click) and refers
to secrets by key name only:

```
fill(ref: "7:e42", value: "{{vault:card.personal.number}}")
```

The placeholder is resolved inside this process and typed into the page over CDP. The
value never appears in a tool result, a snapshot, a log, or an error message — every
response leaves through one scrubbing exit, snapshots never carry input values, and the
tool surface is a whitelist (no script execution, no HTML dump). Why each of those holds
is written up in [docs/architecture.md](docs/architecture.md).

What it is not: a shopping assistant. It does not decide what to buy or whether a price
is right; it only checks that what the caller declared (`expect`, a pay grant from
[FronyShopping](docs/pay-grant.md)) matches what the page shows.

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
Copy-Item config\policy.example.toml "$env:LOCALAPPDATA\Frony\FronyBrowser\data\policy.toml"
$env:WALLET_LOCAL = "1"
npm run -w backend/api dev
```

For a server other devices reach, run the normal mode: it verifies every bearer token
through a FronyAuth introspection endpoint (`FRONY_SERVICE_KEY`, `FRONY_AUTH_URL`,
`FRONY_AUTH_ISSUER`; the contract is in [docs/auth.md](docs/auth.md)).

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

The key policy (which origins may receive which key, which keys need a pay grant) lives on the
server (`policy.toml` under the data dir, copied from `config/policy.example.toml`); the schema is
in [docs/data-model.md](docs/data-model.md).

## Tools

- Session: `session_begin`, `session_list`, `session_status`, `session_end`
- Page: `snapshot`, `navigate`, `fill`, `click`, `select`, `wait`, `page_switch`
- Vault: `vault_list` (names and types only)
- Approval: `approval_wait`

Details, the whitelist rule and how to add one: [docs/tool-surface.md](docs/tool-surface.md).

## Docs

`docs/INDEX.md` lists every doc with when to read it. Deployment on a home server is
in [docs/operations.md](docs/operations.md).
