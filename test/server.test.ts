// Drive the server exactly as an MCP host does: a real Client over a linked
// in-memory transport, listing and calling tools. If the price is right here,
// it is right for Claude Desktop too — same code path.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.ts';

async function connect() {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTx);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTx);
  return client;
}

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

test('lists all the tools', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'check_ledger_balance',
    'format_money',
    'get_component',
    'list_components',
    'price_usage',
    'search_api',
  ]);
});

test('price_usage returns billing-kit\'s exact number', async () => {
  const client = await connect();
  const r = await client.callTool({
    name: 'price_usage',
    arguments: { quantity: '1234567', rate: '0.00012', currency: 'USD' },
  });
  const out = textOf(r);
  // 1234567 * 0.00012 = 148.14804 minor units -> rounds to 148 -> $1.48
  assert.match(out, /amount\s+1\.48 USD/);
  assert.match(out, /148\.14804/); // exact pre-rounding value, nothing dropped
});

test('format_money is currency-correct, not / 100', async () => {
  const client = await connect();
  // JPY has no minor unit: 1500 minor is ¥1,500, not ¥15.00
  const jpy = textOf(await client.callTool({
    name: 'format_money',
    arguments: { minorUnits: '1500', currency: 'JPY' },
  }));
  assert.match(jpy, /￥1,500|¥1,500/);
  const usd = textOf(await client.callTool({
    name: 'format_money',
    arguments: { minorUnits: '1999', currency: 'USD' },
  }));
  assert.match(usd, /\$19\.99/);
});

test('check_ledger_balance confirms zero-sum, rejects unbalanced', async () => {
  const client = await connect();
  const ok = textOf(await client.callTool({
    name: 'check_ledger_balance',
    arguments: {
      legs: [
        { account: 'customer_balance', minorUnits: '1999', currency: 'USD' },
        { account: 'revenue_accrued', minorUnits: '-1999', currency: 'USD' },
      ],
    },
  }));
  assert.match(ok, /BALANCED/);

  const bad = textOf(await client.callTool({
    name: 'check_ledger_balance',
    arguments: {
      legs: [
        { account: 'cash', minorUnits: '2000', currency: 'USD' },
        { account: 'customer_balance', minorUnits: '-1999', currency: 'USD' },
      ],
    },
  }));
  assert.match(bad, /NOT BALANCED/);
});

test('discovery: search_api and list_components', async () => {
  const client = await connect();
  const api = textOf(await client.callTool({ name: 'search_api', arguments: { query: 'ledger' } }));
  assert.match(api, /post|balance/);
  const comps = textOf(await client.callTool({ name: 'list_components', arguments: {} }));
  assert.match(comps, /pricing-table|usage-meter/);
  // get_component returns metadata + install, never raw source
  const one = textOf(await client.callTool({ name: 'get_component', arguments: { name: 'pricing-table' } }));
  assert.match(one, /npx shadcn add/);
});
