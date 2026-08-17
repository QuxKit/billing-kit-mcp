# @quxkit/billing-kit-mcp

<img src="https://raw.githubusercontent.com/QuxKit/quxkit-brand/main/billing-kit/sizes/billing-kit-128.png" width="76" align="right" alt="">

**QuxKit** · blue stone · exact money math for AI assistants

![status](https://img.shields.io/badge/status-shipped-2ea043) ![licence](https://img.shields.io/badge/licence-Apache--2.0-4f83f6) ![npm](https://img.shields.io/badge/npm-%40quxkit%2Fbilling--kit--mcp-cb3837)

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant
billing-kit's real capabilities: **exact money math**, a **double-entry balance
check**, and **discovery** of the API and the UI components.

The point is the first one. Ask a model to price 1,234,567 tokens at $0.0000012
and it will happily invent a number with `qty * rate / 100` — which is wrong for
a third of ISO 4217 and drifts on large values. This server hands the model the
number billing-kit *actually computes*, from the same `Money` type a
floating-point error can't touch.

```
 MCP host                          ┌───────────────────────────┐
 Claude Desktop ◀──── stdio ─────▶ │  @quxkit/billing-kit-mcp  │
 Claude Code          JSON-RPC     │                           │
                                   │  price_usage              │
                                   │  format_money             │
                                   │  check_ledger_balance     │
                                   │  search_api               │
                                   │  list_components          │
                                   └─────────────┬─────────────┘
                                                 │ exact arithmetic
                                                 ▼
                                   @quxkit/billing-kit
                                   Money · Quantity · Rate · price
```

_Rendered diagrams (mermaid): [docs/DIAGRAMS.md](https://github.com/QuxKit/billing-kit-mcp/blob/main/docs/DIAGRAMS.md)._

## Why it matters

The same question, two ways — the difference is the whole reason this server exists:

```
 price 1,234,567 tokens at $0.0000012 / token, USD

   ✗  assistant on its own
      invents qty × rate ÷ 100 — drifts on large values,
      and is wrong for a third of ISO 4217

   ✓  price_usage → billing-kit
      $1.48 · exact 148.14804 minor units, from the Money type
```

A language model is a plausible-number generator; money needs the *correct* number.
This server moves the arithmetic out of the model and into billing-kit, where a
float can't touch it.

## Tools

| Tool | What it does |
|---|---|
| `price_usage` | Multiply a quantity by a per-unit rate to an exact `Money`, with the pre-rounding value kept. **Backed by billing-kit — the number is correct, not invented.** |
| `format_money` | Format integer minor units for a currency, correctly (no `/100`; right for JPY, KWD). |
| `check_ledger_balance` | Verify a double-entry transaction's legs sum to zero per currency — the invariant billing-kit's ledger enforces. |
| `search_api` | Find billing-kit's exports and signatures — `Money`, `price`, the metering and ledger functions, the provider interface. |
| `list_components` / `get_component` | Discover the shadcn-compatible UI. Metadata and the install command only — never the (proprietary) component source. |

## Install

From npm — the server and the library it prices with, side by side:

```sh
npm i -g @quxkit/billing-kit-mcp @quxkit/billing-kit
billing-kit-mcp          # speaks MCP over stdio; logs go to stderr
```

`@quxkit/billing-kit` is a **peer dependency**, not bundled: the number the
server hands back is whatever version of billing-kit you installed next to it,
so it tracks the library instead of freezing a copy of it. The bundle inlines
everything else (the MCP SDK, zod, the discovery snapshots), so there is
nothing else to ship.

From a checkout:

```sh
pnpm install
pnpm build           # esbuild -> dist/index.js, with @quxkit/billing-kit external
```

## Use it from an MCP host

Add it to your host's server config. For **Claude Desktop**
(`claude_desktop_config.json`) or **Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "billing-kit": {
      "command": "billing-kit-mcp"
    }
  }
}
```

(From a checkout, use `"command": "node", "args": ["/absolute/path/to/billing-kit-mcp/dist/index.js"]`
instead.)

Then ask, in plain language:

> *"With billing-kit, what does 1,234,567 tokens at a rate of 0.00012 cost in USD?"*
> → `price_usage` → **$1.48** (exact: 148.14804 minor)

> *"Do these ledger legs balance: customer_balance +19.99, revenue_accrued −19.99?"*
> → `check_ledger_balance` → **BALANCED ✓**

## How it talks

stdio, newline-delimited JSON-RPC — the host spawns the server and speaks over
stdin/stdout. Logs go to **stderr**, because anything on stdout that isn't a
protocol frame corrupts the stream.

## Tests

```sh
pnpm test           # builds first, then drives the server in-memory and over stdio
```

The suite drives the server through a real MCP `Client` over an in-memory
transport — the same code path a host uses — asserting that `price_usage`
returns billing-kit's exact value, `format_money` is currency-correct, and the
ledger check accepts a balanced posting and rejects an unbalanced one. A second
file spawns the built `dist/index.js` over real stdio, so the external
`@quxkit/billing-kit` import is proven to resolve the way it will after
`npm i -g`.


## The QuxKit family

Libraries you embed, not services you operate. Each kit owns one narrow thing
and composes with the rest over shared shapes — one executor interface, one
opaque tenant id, one Money type.

| Package | Stone | What it owns |
|---|---|---|
| [`@quxkit/identity-kit`](https://github.com/QuxKit/identity-kit) | gold | Accounts, argon2id credentials, revocable sessions — produces a `UserId`. |
| [`@quxkit/tenant-kit`](https://github.com/QuxKit/tenant-kit) | green | Tenant directory, request→tenant resolution, row-level-security isolation. |
| [`@quxkit/billing-kit`](https://github.com/QuxKit/billing-kit) | blue | Metering, exact pricing, a double-entry ledger, provider settlement. |
| [`@quxkit/billing-kit-adapters`](https://github.com/QuxKit/billing-kit-adapters) | blue | Payment providers beyond Stripe and Paddle. |
| [`tenant-kit-adapters`](https://github.com/QuxKit/tenant-kit-adapters) | green | Enterprise SSO, SCIM provisioning, RBAC-engine bridges. |
| [`billing-kit-components`](https://github.com/QuxKit/billing-kit-components) | blue | shadcn-compatible billing UI, per seat. |
| [`@quxkit/billing-kit-mcp`](https://github.com/QuxKit/billing-kit-mcp) | blue | Exact money math for AI assistants over MCP. |

## Licence

Apache-2.0. Open on purpose — it exists to make billing-kit easier to adopt.
It reads billing-kit (Apache-2.0) directly, and reports only *metadata* about
billing-kit-components (which is proprietary and per-seat); no component source
passes through it.
