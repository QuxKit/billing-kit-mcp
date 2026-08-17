# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **DB-backed read tools.** With `DATABASE_URL` set the server registers
  `query_usage`, `aggregate_usage`, `ledger_balance`, `ledger_entries`,
  `subscription_status` and `wallet_balance`, all over billing-kit's own read
  functions on its `./pg` executor. Every connection is pinned with
  `SET default_transaction_read_only = on`; `tenantId` is required on every
  call; `BILLING_KIT_MCP_TENANT` refuses any other tenant; row tools are capped
  at 200 with an explicit `truncated` flag. README documents a read-only DB
  role. `pg` is now a runtime dependency (external in the bundle). Tests run
  against `billing_kit_test`, seeded through billing-kit's API; both CI
  workflows provide Postgres and set `REQUIRE_DB=1`.
- **Resources and a prompt.** `billing://schema` (billing-kit's `sql/*.sql`
  from the installed package, plus `billing://schema/{file}`), `billing://plans`
  (the operator's catalogue from `BILLING_KIT_MCP_PLANS` — JSON or a JS module,
  hydrated through `definePlan`), and the `explain-charge` prompt, which walks a
  subscription's current-period charge (subscription, plan, per-metric usage,
  `chargeForPeriod` lines, ledger postings and balance) when a database is
  connected and hands back the procedure otherwise.
- **Write tools behind a flag.** `--allow-writes` / `BILLING_KIT_MCP_ALLOW_WRITES=1`
  enables `record_usage` (billing-kit `record`) and `apply_coupon` (a credit
  note via `applyDiscount` + `creditNotePosting`), each requiring
  `confirm: true` and an `idempotencyKey`; listed but refused with `isError`
  when the flag is off; every attempt writes an audit line to stderr. The bin
  opens a separate writable pool only when the flag is on. `configFromEnv`
  now also reads argv.
- Discovery snapshots regenerated against billing-kit `main` (adds the
  `@quxkit/billing-kit/pg` subpath, `ENTRIES_MAX_ROWS`, `RECORD_MANY_MAX`,
  the sweep types) and billing-kit-components' current registry.
- `scripts/gen-discovery.mjs` regenerates `src/data/api.json` (every export of
  each `@quxkit/billing-kit` subpath, read from its built `.d.ts`, with the
  hand-curated `symbols` preserved and validated) and `src/data/components.json`
  (from billing-kit-components' `registry.json`, metadata only). `pnpm
  discovery:check` fails when the committed snapshots are stale; CI runs it.
- `search_api` falls back to the generated export list when no curated entry
  matches, so every real export is discoverable by name.
- A stdio test that spawns the built `dist/index.js` and prices through it.
- GitHub Actions CI (Node 20 / 22 matrix) and a release workflow on `v*` tags
  (`npm publish --provenance`); dependabot; CODEOWNERS.
- Biome (lint + format), c8 coverage with thresholds (lines 95, functions 85,
  branches 80), `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`.

### Changed
- `@quxkit/billing-kit` is now an **external peer dependency** (`^0.1.0`) rather
  than being bundled *and* declared as a `*` peer. Install with
  `npm i -g @quxkit/billing-kit-mcp @quxkit/billing-kit`; the server prices
  with whichever billing-kit sits next to it.
- Gitea CI derives node / brew paths instead of hard-coding `/Users/ezyp` and
  `/opt/homebrew`; both workflows run the same script set.
- `package.json`: `license`, `files`, `engines`, `prepublishOnly`
  (lint + typecheck + build + test); `pretest` builds so the stdio test has a bin.

### Fixed
- Tool failures (unparseable input, unknown component) now return
  `{ isError: true }` per the MCP spec instead of a successful text result.

## [0.1.0] - 2026-08-14

### Added
- Initial release: `price_usage`, `format_money`, `check_ledger_balance`,
  `search_api`, `list_components`, `get_component` over stdio.
