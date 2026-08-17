# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
