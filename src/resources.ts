// Resources: what an assistant can *read* rather than call.
//
//   billing://plans            the operator's plan catalogue (BILLING_KIT_MCP_PLANS)
//   billing://schema           billing-kit's shipped SQL, every file in order
//   billing://schema/{file}    one of those files
//
// The schema comes from the installed `@quxkit/billing-kit` package (its
// `sql/*.sql`, exported as `./sql/*`), so what the assistant reads is the DDL
// of the very version this server prices with — not a copy that could drift.

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlanCatalogue } from './catalogue.js';

export interface ResourceOptions {
  catalogue?: PlanCatalogue;
  /** Override where the SQL is read from (tests); defaults to the installed billing-kit. */
  sqlDir?: string;
}

/** billing-kit's `sql/` directory, resolved through its package exports. */
export function billingKitSqlDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@quxkit/billing-kit/package.json')), 'sql');
}

async function sqlFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

export function registerResources(server: McpServer, options: ResourceOptions = {}): void {
  const sqlDir = options.sqlDir ?? billingKitSqlDir();

  if (options.catalogue) {
    const cat = options.catalogue;
    server.registerResource(
      'plans',
      'billing://plans',
      {
        title: 'Plan catalogue',
        description:
          `The operator's plans (${cat.entries.length}, from ${cat.path}): id, currency, interval, base fee, ` +
          'seat price, per-metric included allowance and overage price, trial days. Amounts are exact decimal ' +
          'strings in the plan currency; rates are minor units per unit.',
        mimeType: 'application/json',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(cat.entries, null, 2) }],
      }),
    );
  }

  server.registerResource(
    'schema',
    'billing://schema',
    {
      title: 'billing-kit SQL schema',
      description:
        "billing-kit's shipped SQL (sql/*.sql), concatenated in apply order: the billing schema, usage_events, " +
        'ledger_transactions/ledger_entries, metering, partitions, subscriptions.',
      mimeType: 'application/sql',
    },
    async (uri) => {
      const files = await sqlFiles(sqlDir);
      const parts: string[] = [];
      for (const f of files) {
        parts.push(`-- ===== ${f} =====\n${await readFile(join(sqlDir, f), 'utf8')}`);
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/sql', text: parts.join('\n\n') }] };
    },
  );

  server.registerResource(
    'schema-file',
    new ResourceTemplate('billing://schema/{file}', {
      list: async () => ({
        resources: (await sqlFiles(sqlDir)).map((f) => ({
          uri: `billing://schema/${f}`,
          name: f,
          title: `billing-kit ${f}`,
          mimeType: 'application/sql',
        })),
      }),
    }),
    { title: 'One billing-kit SQL file', mimeType: 'application/sql' },
    async (uri, { file }) => {
      const name = String(file);
      const files = await sqlFiles(sqlDir);
      if (!files.includes(name)) throw new Error(`no such SQL file: ${name} (have ${files.join(', ')})`);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/sql', text: await readFile(join(sqlDir, name), 'utf8') }],
      };
    },
  );
}
