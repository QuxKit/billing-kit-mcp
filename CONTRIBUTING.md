# Contributing

## Dev setup

This server dev-links its peer and reads a sibling's registry, so check the
family out side by side:

```
BRETT/
  billing-kit/               # peer — must be built (pnpm build) before this repo installs
  billing-kit-components/    # registry.json feeds src/data/components.json
  billing-kit-mcp/           # this repo
```

```sh
cd billing-kit && pnpm install && pnpm build && cd ..
cd billing-kit-mcp && pnpm install
```

No database is needed. If the siblings live elsewhere, point at them with
`BILLING_KIT_DIR` / `BILLING_KIT_COMPONENTS_DIR` (paths relative to this repo).

## Scripts

| Script | What |
|---|---|
| `pnpm dev` | run the server from source over stdio |
| `pnpm build` | esbuild -> `dist/index.js` (billing-kit external) |
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | builds, then runs every `test/*.test.ts` (in-memory MCP client + a stdio spawn of the bin) |
| `pnpm test:coverage` | the same under c8, with thresholds |
| `pnpm discovery:gen` | regenerate `src/data/*.json` from the siblings |
| `pnpm discovery:check` | exit 1 if the committed snapshots are stale |

Tests live flat in `test/` so the glob works on Node 20 without `--test` glob
support.

## Workflow

Every change gets an **issue**, a **branch** named `<type>/<issue>-<slug>`, and
a **pull request**; nothing lands on `main` directly. Commit subjects are
Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `style:`).

Before pushing: `pnpm lint && pnpm typecheck && pnpm build && pnpm test &&
pnpm discovery:check`. If you change what billing-kit exports or the components
registry, run `pnpm discovery:gen` and commit the regenerated JSON — CI fails
otherwise.

Curated API entries (`symbols` in `src/data/api.json`) are hand-written and
kept short; edit them in place, the generator preserves them and checks each
one still names a real export.

Never write to stdout in server code — it is the JSON-RPC channel. Log to
stderr.
