// Discovery tools — the API reference and the component registry.
//
// These read bundled metadata snapshots, not live source. The component tool in
// particular returns names, descriptions and the install command only, never the
// component source: that source is proprietary and gated by a seat, and an MCP
// server is not the place to hand it out.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Imported, not read at runtime: the bundler inlines these snapshots into the
// server, so it stays a single self-contained file with no data directory to ship.
import apiData from '../data/api.json' with { type: 'json' };
import registryData from '../data/components.json' with { type: 'json' };

interface ApiSymbol {
  name: string;
  kind: string;
  module: string;
  summary: string;
  members: string[];
  gotcha?: string;
}
interface Component {
  name: string;
  title: string;
  type: string;
  description: string;
  categories: string[];
  registryDependencies: string[];
  dependencies: string[];
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export function registerDiscoveryTools(server: McpServer): void {
  const api = apiData as { symbols: ApiSymbol[] };
  const registry = registryData as { homepage: string; items: Component[] };

  server.registerTool(
    'search_api',
    {
      title: "Search billing-kit's API",
      description:
        "Find billing-kit's exports by name or keyword and see their signatures — Money, Quantity, " +
        'Rate, price, the metering and ledger functions, and the provider interface. Empty query lists everything.',
      inputSchema: { query: z.string().optional().describe('A symbol name or keyword, e.g. "money", "ledger", "provider"') },
    },
    async ({ query }) => {
      const q = (query ?? '').toLowerCase();
      const hits = api.symbols.filter(
        (s) => !q || s.name.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q) || s.module.includes(q),
      );
      if (hits.length === 0) return text(`No billing-kit symbol matched "${query}".`);
      return text(
        hits
          .map((s) =>
            [
              `${s.name}  (${s.kind}, from '${s.module}')`,
              `  ${s.summary}`,
              ...s.members.map((m) => `    ${m}`),
              s.gotcha ? `  ⚠ ${s.gotcha}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n'),
      );
    },
  );

  server.registerTool(
    'list_components',
    {
      title: 'List billing-kit UI components',
      description:
        'List the shadcn-compatible components in billing-kit-components — pricing, usage, ledger, ' +
        'checkout and superadmin — with what each is for. Metadata only.',
      inputSchema: { category: z.string().optional().describe('Filter by category, e.g. "pricing", "usage", "ledger"') },
    },
    async ({ category }) => {
      const items = registry.items.filter(
        (c) => c.type !== 'registry:lib' && c.type !== 'registry:hook' && (!category || c.categories.includes(category)),
      );
      return text(
        [
          `${items.length} components${category ? ` in "${category}"` : ''}:`,
          '',
          ...items.map((c) => `  ${c.name.padEnd(22)} ${c.description}`),
          '',
          `Install any with:  npx shadcn add ${registry.homepage ?? '<registry>'}/<name>.json`,
          `(A current per-seat licence is required — see billing-kit-components.)`,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'get_component',
    {
      title: 'Get a component (metadata)',
      description:
        'Details for one component: what it does, its npm and registry dependencies, and how to ' +
        'install it. Returns metadata and the install command, never the (proprietary) source.',
      inputSchema: { name: z.string().describe('The component name, e.g. "pricing-table"') },
    },
    async ({ name }) => {
      const c = registry.items.find((i) => i.name === name);
      if (!c) {
        const near = registry.items
          .map((i) => i.name)
          .filter((n) => n.includes(name) || name.includes(n))
          .slice(0, 5);
        return text(`No component named "${name}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
      }
      return text(
        [
          `${c.name} — ${c.title}`,
          c.description,
          '',
          c.categories.length ? `categories:   ${c.categories.join(', ')}` : '',
          c.dependencies.length ? `npm deps:     ${c.dependencies.join(', ')}` : '',
          c.registryDependencies.length ? `registry deps: ${c.registryDependencies.join(', ')}` : '',
          '',
          `install:  npx shadcn add ${registry.homepage ?? '<registry>'}/${c.name}.json`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );
}
