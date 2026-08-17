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
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerDbTools } from './tools/db.js';
import { registerDiscoveryTools } from './tools/discover.js';
import { registerLedgerTools } from './tools/ledger.js';
import { registerPriceTools } from './tools/price.js';

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
  registerResources(server, { catalogue: options.catalogue, sqlDir: options.sqlDir });
  registerPrompts(server, { db: options.db, tenantScope: options.tenantScope, catalogue: options.catalogue });
  return server;
}

/** What the bin reads from the environment. Exported so the tests can drive it. */
export interface RuntimeConfig {
  databaseUrl?: string;
  tenantScope?: string;
  plansPath?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const trimmed = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : undefined);
  return {
    databaseUrl: trimmed(env.DATABASE_URL),
    tenantScope: trimmed(env.BILLING_KIT_MCP_TENANT),
    plansPath: trimmed(env.BILLING_KIT_MCP_PLANS),
  };
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const opened = config.databaseUrl ? openDatabase(config.databaseUrl) : undefined;
  const catalogue = config.plansPath ? await loadPlanCatalogue(config.plansPath) : undefined;
  const server = createServer({ db: opened?.db, tenantScope: config.tenantScope, catalogue });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, never stdout — stdout is the protocol channel.
  process.stderr.write(
    `billing-kit-mcp: ready on stdio${opened ? ' (database connected, read-only' : ' (no database'}` +
      `${config.tenantScope ? `, tenant ${config.tenantScope}` : ''}` +
      `${catalogue ? `, ${catalogue.plans.size} plans` : ''})\n`,
  );
  const shutdown = async () => {
    await opened?.close().catch(() => undefined);
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
