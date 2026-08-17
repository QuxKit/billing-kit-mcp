# @quxkit/billing-kit-mcp

<img src="https://raw.githubusercontent.com/QuxKit/quxkit-brand/main/billing-kit/sizes/billing-kit-128.png" width="76" align="right" alt="">

**QuxKit** · blue stone · exact money math for AI assistants

![status](https://img.shields.io/badge/status-shipped-2ea043) ![licence](https://img.shields.io/badge/licence-Apache--2.0-4f83f6) ![npm](https://img.shields.io/badge/npm-%40quxkit%2Fbilling--kit--mcp-cb3837)

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant
billing-kit's real capabilities: **exact money math**, a **double-entry balance
check**, **discovery** of the API and the UI components, and — with a
`DATABASE_URL` — **read-only answers from a real billing database** (usage,
aggregates, ledger balances and entries, wallets, subscription state). It also
serves the **plan catalogue** and the **SQL schema** as resources, and an
**`explain-charge`** prompt that walks a subscription's period charge.

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
                                   │  ── with DATABASE_URL ──  │
                                   │  query_usage              │
                                   │  aggregate_usage          │
                                   │  ledger_balance/entries   │
                                   │  wallet_balance           │
                                   │  subscription_status      │
                                   └──────┬────────────┬───────┘
                                          │ exact      │ read-only
                                          │ arithmetic │ SqlExecutor
                                          ▼            ▼
                                   @quxkit/billing-kit   Postgres (billing.*)
                                   Money · Quantity      SET default_transaction_read_only
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

With `DATABASE_URL` set, six more (see [Database-backed tools](#database-backed-tools)):

| Tool | What it does |
|---|---|
| `query_usage` | A subject's raw usage events in `[since, until)`, oldest first, capped at 200 rows and honest about it (`truncated: true`). |
| `aggregate_usage` | One exact quantity for a metric over a window — `sum` / `count` / `max` / `unique` — computed in Postgres by billing-kit. |
| `ledger_balance` | The balance of one account (`customer_balance`, `revenue_accrued`, `cash`, `customer_credit`, …) for a subject in a currency. |
| `ledger_entries` | A subject's ledger entries, optionally for one account and window, capped at 200. |
| `wallet_balance` | Prepaid credit available, as a positive amount. |
| `subscription_status` | A subscription's persisted state by id or by creation key: plan, state, seats, current period, trial end. |

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

## Database-backed tools

Point the server at a billing-kit database and it can answer questions about
*this* customer rather than about arithmetic in general:

```sh
DATABASE_URL=postgres://billing_ro@db.internal/billing billing-kit-mcp
# optionally pin every call to one tenant:
BILLING_KIT_MCP_TENANT=acme DATABASE_URL=... billing-kit-mcp
```

Or in the host config:

```json
{
  "mcpServers": {
    "billing-kit": {
      "command": "billing-kit-mcp",
      "env": { "DATABASE_URL": "postgres://billing_ro@db.internal/billing" }
    }
  }
}
```

Then:

> *"How many input tokens did org_42 use in tenant acme this month?"*
> → `aggregate_usage` → `{ quantity: "1234567", eventCount: 8812 }`

> *"What does org_42 owe right now?"*
> → `ledger_balance customer_balance USD` → `{ balance: "19.99" }`

The rules, in the order they matter:

```
 assistant ──▶ tool call { tenantId, subjectId, ... }
                 │
                 ├─ tenantId missing? ──▶ schema error (no cross-tenant read exists)
                 ├─ BILLING_KIT_MCP_TENANT set and ≠ tenantId? ──▶ isError
                 │
                 ▼
             billing-kit read function (queryUsage, aggregateUsage,
             balance, entries, walletBalance, getSubscription)
                 │
                 ▼
             pg.Pool ─ every connection: SET default_transaction_read_only = on
                 │
                 ▼
             billing.* tables    (an INSERT here is refused by Postgres)
```

- **Read-only, twice.** Every connection the server opens runs
  `SET default_transaction_read_only = on` before it serves a query, so a
  write — a tool bug, or a prompt injection that talks the assistant into one
  — is refused by Postgres. That is per-session and a superuser could undo it,
  so also connect as a **read-only role** (see below). Nothing here writes.
- **Tenant id on every call.** There is no "all tenants" read; the schema
  requires `tenantId`. `BILLING_KIT_MCP_TENANT` additionally refuses any call
  that names another tenant, for one-server-per-tenant deployments.
- **Capped and honest.** Row-returning tools take `limit` (1..200, default 50)
  and return `truncated: true` plus a hint when more rows exist. The instructions
  tell the assistant to use `aggregate_usage` / `ledger_balance` for totals and
  never to sum a page — those two run billing-kit's exact `SUM` in Postgres.
- **billing-kit's numbers.** Quantities and amounts are billing-kit's exact
  decimal strings (`"19.99"`, `"1234567"`, plus `minorUnits`); no float is
  involved anywhere in the path.
- **Typed failures.** A billing-kit error surfaces as `isError: true` with its
  code in the text (`window_invalid`, `invalid_subscription`, …).

## Resources and prompts

| Resource | What it is |
|---|---|
| `billing://plans` | The operator's plan catalogue, from the file named by `BILLING_KIT_MCP_PLANS` (see below). Absent when no catalogue is configured. |
| `billing://schema` | billing-kit's shipped SQL (`sql/*.sql`) concatenated in apply order, read from the installed `@quxkit/billing-kit` — the DDL of the very version this server prices with. |
| `billing://schema/{file}` | One of those files (`billing://schema/001_core.sql`, …); the template lists them. |

| Prompt | Arguments | What it does |
|---|---|---|
| `explain-charge` | `tenantId`, `subscription` (id or creation key) | Walks the subscription's current-period charge and asks the assistant to explain it. With a database it does the walk itself — subscription state, the plan from the catalogue, `aggregate_usage` per metered metric over the period, the lines `chargeForPeriod` computes, the charge postings and balance in the ledger — and embeds those exact figures. Without one it hands back the same walk as a procedure over the tools. |

```
 explain-charge { tenantId, subscription }
   │
   ├─ subscription_status ─── plan id, seats, period, trial
   ├─ billing://plans ─────── base, seats, included, overage price
   ├─ aggregate_usage ─────── per metered metric over the period
   ├─ chargeForPeriod ─────── lines: flat / seats / usage / discount, total
   └─ ledger_entries + ledger_balance ── what was posted, what is owed
        ▼
   "Explain each line, quoting these exact figures."
```

### The plan catalogue

billing-kit does not persist plans — the catalogue is the application's, held
in code. Point the server at it and the assistant can read what `team` costs:

```sh
BILLING_KIT_MCP_PLANS=./plans.json billing-kit-mcp
```

A `.json` file (an array, or `{ "plans": [...] }`), or a `.js` / `.mjs` module
whose default (or `plans`) export is the same shape:

```json
{
  "plans": [
    {
      "id": "team", "name": "Team",
      "currency": "USD", "interval": "month",
      "flat": "49.00",
      "seats": { "unit": "10.00", "min": 1 },
      "usage": [
        { "metric": "tokens.input", "included": "1000000",
          "price": { "kind": "flat", "rate": "0.00012" } },
        { "metric": "gb_hours",
          "price": { "kind": "tiered", "mode": "graduated",
                     "tiers": [ { "upTo": "100", "rate": "5" }, { "upTo": null, "rate": "3" } ] } }
      ],
      "trialDays": 14
    }
  ]
}
```

Amounts (`flat`, `seats.unit`, tier `flat`) are decimal strings in the plan's
currency; `included` / `upTo` are decimal quantities; `rate` is minor units per
unit — billing-kit's own conventions, no floats. Every entry is hydrated through
billing-kit's `definePlan`, so an invalid catalogue is refused at startup with
billing-kit's reason (`invalid_plan`, `unknown_currency`, …) rather than
mis-pricing later. `name` and `description` are free-form and served as-is.

### Read-only role

Create a role that can read `billing.*` and nothing else, and hand *that* to
`DATABASE_URL`:

```sql
CREATE ROLE billing_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE billing TO billing_ro;
GRANT USAGE ON SCHEMA billing TO billing_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO billing_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO billing_ro;
-- belt and braces: even a session that unset the flag stays read-only
ALTER ROLE billing_ro SET default_transaction_read_only = on;
```

The schema is billing-kit's (`@quxkit/billing-kit/sql/*.sql`); the server does
not create or migrate anything.

## Errors

A tool that cannot do what was asked (an unparseable quantity, a bad currency,
an unknown component name) returns an MCP **tool error** — `isError: true` with
a one-line explanation in `content` — rather than a successful result whose text
happens to describe a problem. A host can therefore branch on the flag. An
*unbalanced* posting is not an error: `check_ledger_balance` answers
`NOT BALANCED` as a normal result, because that is the answer.

## How it talks

stdio, newline-delimited JSON-RPC — the host spawns the server and speaks over
stdin/stdout. Logs go to **stderr**, because anything on stdout that isn't a
protocol frame corrupts the stream.

## Tests

```sh
pnpm test           # builds first, then drives the server in-memory and over stdio
createdb billing_kit_test && REQUIRE_DB=1 pnpm test   # ...plus the DB-backed tools
```

The DB-backed tools are tested against a real Postgres (`billing_kit_test` by
default; `BILLING_KIT_TEST_DATABASE_URL` to point elsewhere). The harness
rebuilds `billing.*` from the SQL files billing-kit ships, seeds through
billing-kit's own API (`record`, `post`, `createSubscription`), and reads back
through the server on the same read-only connection the bin opens — including
a probe that an `INSERT` on that connection is refused. Without a reachable
database the suite skips; with `REQUIRE_DB=1` (CI) it fails instead.

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
