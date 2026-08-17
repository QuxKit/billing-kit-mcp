// The built bundle, driven over real stdio — the way an MCP host runs the bin.
//
// This is the only test that exercises dist/index.js, so it is the one that
// proves the external `@quxkit/billing-kit` import resolves at runtime (the
// bundle no longer inlines billing-kit; it is a peer). `pnpm test` runs the
// build first via the pretest script.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, '..', 'dist', 'index.js');

test('the built bin serves over stdio and resolves billing-kit as an external', async () => {
  assert.ok(existsSync(bin), `expected a build at ${bin} — run \`pnpm build\` first`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'price_usage'));
    const r = await client.callTool({
      name: 'price_usage',
      arguments: { quantity: '1234567', rate: '0.00012', currency: 'USD' },
    });
    const out = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    assert.match(out, /amount\s+1\.48 USD/);
    assert.notEqual(r.isError, true);
  } finally {
    await client.close();
  }
});
