// billing-kit MCP server.
//
// Gives an assistant billing-kit's real capabilities over the Model Context
// Protocol: exact money math (the numbers the library actually computes, not a
// plausible `qty * rate / 100`), a double-entry balance check, and discovery of
// the API and the UI components.
//
// stdio transport: this is a local server a client (Claude Desktop, Claude Code,
// any MCP host) spawns and talks to over stdin/stdout. Nothing here listens on a
// socket, and nothing writes to stdout except protocol frames — logs go to
// stderr, because a stray console.log on stdout corrupts the JSON-RPC stream.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { SqlExecutor } from '@quxkit/billing-kit';
import { loadPlanCatalogue, type PlanCatalogue } from './catalogue.js';
import { openDatabase } from './db.js';
import { startHttp } from './http.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerDbTools } from './tools/db.js';

// Re-exported so this package can be COMPOSED as well as spawned.
//
// The family server (@quxkit/quxkit-mcp) mounts these onto its own server, and
// QuxCloud's Builder mounts them into a crew that has no transport at all.
// Both were reaching for `registerLedgerTools` on this module and finding
// nothing, because the functions lived one file down and the entry only
// called them — a package that is a bin and nothing else.
//
// Importing this module starts no server: `main()` is guarded on isMain.
export { registerDbTools } from './tools/db.js';
export { registerDiscoveryTools } from './tools/discover.js';
export { registerLedgerTools } from './tools/ledger.js';
export { registerPriceTools } from './tools/price.js';
export { registerWriteTools } from './tools/write.js';

import { registerDiscoveryTools } from './tools/discover.js';
import { registerLedgerTools } from './tools/ledger.js';
import { registerPriceTools } from './tools/price.js';
import { registerWriteTools } from './tools/write.js';

export interface ServerOptions {
  /**
   * A read-only executor over billing-kit's schema. When present, the DB-backed
   * read tools (query_usage, aggregate_usage, ledger_balance, ledger_entries,
   * subscription_status, wallet_balance) are registered; without it the server
   * is arithmetic and discovery only, exactly as before.
   */
  db?: SqlExecutor;
  /** Refuse DB calls for any tenant but this one (BILLING_KIT_MCP_TENANT). */
  tenantScope?: string;
  /** The operator's plans (BILLING_KIT_MCP_PLANS), served as billing://plans and used by explain-charge. */
  catalogue?: PlanCatalogue;
  /** Where billing-kit's SQL is read from for billing://schema; defaults to the installed package. */
  sqlDir?: string;
  /**
   * A WRITABLE executor, present only when the operator passed --allow-writes.
   * With it (and `allowWrites`), record_usage and apply_coupon do their write;
   * without it they are listed but every call is refused with isError.
   */
  writeDb?: SqlExecutor;
  /** The write flag (--allow-writes / BILLING_KIT_MCP_ALLOW_WRITES=1). */
  allowWrites?: boolean;
  /** Where write-tool audit lines go; defaults to stderr. */
  audit?: (line: string) => void;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'billing-kit-mcp', version: '0.1.0' },
    {
      instructions:
        'Tools backed by billing-kit. Use price_usage and format_money for any monetary value — ' +
        "they compute with billing-kit's exact Money type, so the number is correct rather than " +
        'invented. Never format an amount by dividing minor units by 100; it is wrong for a third ' +
        'of ISO 4217. check_ledger_balance verifies a double-entry posting sums to zero. ' +
        'search_api and list_components/get_component discover the library and its UI. ' +
        'Resources: billing://schema is the SQL schema' +
        (options.catalogue ? ', billing://plans is the plan catalogue' : '') +
        '. The explain-charge prompt walks a subscription period charge.' +
        (options.db || options.writeDb
          ? options.allowWrites && options.writeDb
            ? ' Writes are ENABLED: record_usage and apply_coupon write through billing-kit, only with confirm: true ' +
              'and an idempotencyKey; ask the user before calling either.'
            : ' record_usage and apply_coupon are listed but writes are disabled on this server; they will refuse.'
          : '') +
        (options.db
          ? ' The server is connected to a billing database (read-only): query_usage, aggregate_usage, ' +
            'ledger_balance, ledger_entries, subscription_status and wallet_balance read real rows; every ' +
            'call needs a tenantId. Use aggregate_usage / ledger_balance for totals — the row tools are capped.'
          : ''),
    },
  );

  registerPriceTools(server);
  registerLedgerTools(server);
  registerDiscoveryTools(server);
  if (options.db) registerDbTools(server, { db: options.db, tenantScope: options.tenantScope });
  if (options.db || options.writeDb) {
    registerWriteTools(server, {
      db: options.writeDb,
      enabled: options.allowWrites === true,
      tenantScope: options.tenantScope,
      audit: options.audit,
    });
  }
  registerResources(server, { catalogue: options.catalogue, sqlDir: options.sqlDir });
  registerPrompts(server, { db: options.db, tenantScope: options.tenantScope, catalogue: options.catalogue });
  return server;
}

/** What the bin reads from the environment. Exported so the tests can drive it. */
export interface RuntimeConfig {
  databaseUrl?: string;
  tenantScope?: string;
  plansPath?: string;
  /** --allow-writes or BILLING_KIT_MCP_ALLOW_WRITES=1 */
  allowWrites: boolean;
  /** `--http :port` — serve Streamable HTTP there instead of stdio. */
  http?: string;
  /** BILLING_KIT_MCP_TOKEN — the bearer token HTTP requests must present. */
  token?: string;
}

const truthy = (v: string | undefined) =>
  v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = []): RuntimeConfig {
  const trimmed = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : undefined);
  return {
    databaseUrl: trimmed(env.DATABASE_URL),
    tenantScope: trimmed(env.BILLING_KIT_MCP_TENANT),
    plansPath: trimmed(env.BILLING_KIT_MCP_PLANS),
    allowWrites: argv.includes('--allow-writes') || truthy(env.BILLING_KIT_MCP_ALLOW_WRITES),
    http: httpArg(argv),
    token: trimmed(env.BILLING_KIT_MCP_TOKEN),
  };
}

/** `--http :3100`, `--http=:3100`, or a bare `--http` (defaults to :3100). */
function httpArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--http=')) return a.slice('--http='.length) || ':3100';
    if (a === '--http') {
      const next = argv[i + 1];
      return next && !next.startsWith('--') ? next : ':3100';
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env, process.argv.slice(2));
  const opened = config.databaseUrl ? openDatabase(config.databaseUrl) : undefined;
  // A second, writable pool — only with the flag. The read tools never see it.
  const writable =
    config.databaseUrl && config.allowWrites
      ? openDatabase(config.databaseUrl, { readOnly: false, max: 2 })
      : undefined;
  const catalogue = config.plansPath ? await loadPlanCatalogue(config.plansPath) : undefined;
  const serverOptions: ServerOptions = {
    db: opened?.db,
    tenantScope: config.tenantScope,
    catalogue,
    writeDb: writable?.db,
    allowWrites: config.allowWrites,
  };
  const status =
    `${opened ? '(database connected, read-only' : '(no database'}` +
    `${config.tenantScope ? `, tenant ${config.tenantScope}` : ''}` +
    `${catalogue ? `, ${catalogue.plans.size} plans` : ''}` +
    `${writable ? ', WRITES ENABLED' : ''})`;

  let closeHttp: (() => Promise<void>) | undefined;
  if (config.http !== undefined) {
    // One McpServer per request (stateless); the pools above are shared.
    const http = await startHttp({
      listen: config.http,
      token: config.token,
      serverFactory: () => createServer(serverOptions),
    });
    closeHttp = http.close;
    process.stderr.write(`billing-kit-mcp: ready on ${http.url} ${status}\n`);
  } else {
    const server = createServer(serverOptions);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr, never stdout — stdout is the protocol channel.
    process.stderr.write(`billing-kit-mcp: ready on stdio ${status}\n`);
  }
  const shutdown = async () => {
    await closeHttp?.().catch(() => undefined);
    await opened?.close().catch(() => undefined);
    await writable?.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run when invoked directly, so tests can import createServer without
// starting the transport.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`billing-kit-mcp: fatal ${err}\n`);
    process.exit(1);
  });
}
