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
import { registerDiscoveryTools } from './tools/discover.js';
import { registerLedgerTools } from './tools/ledger.js';
import { registerPriceTools } from './tools/price.js';

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'billing-kit-mcp', version: '0.1.0' },
    {
      instructions:
        'Tools backed by billing-kit. Use price_usage and format_money for any monetary value — ' +
        "they compute with billing-kit's exact Money type, so the number is correct rather than " +
        'invented. Never format an amount by dividing minor units by 100; it is wrong for a third ' +
        'of ISO 4217. check_ledger_balance verifies a double-entry posting sums to zero. ' +
        'search_api and list_components/get_component discover the library and its UI.',
    },
  );

  registerPriceTools(server);
  registerLedgerTools(server);
  registerDiscoveryTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, never stdout — stdout is the protocol channel.
  process.stderr.write('billing-kit-mcp: ready on stdio\n');
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
