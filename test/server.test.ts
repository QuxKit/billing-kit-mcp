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

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
const textOf = (r: ToolResult): string =>
  (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');

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

test("price_usage returns billing-kit's exact number", async () => {
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
  const jpy = textOf(
    await client.callTool({
      name: 'format_money',
      arguments: { minorUnits: '1500', currency: 'JPY' },
    }),
  );
  assert.match(jpy, /￥1,500|¥1,500/);
  const usd = textOf(
    await client.callTool({
      name: 'format_money',
      arguments: { minorUnits: '1999', currency: 'USD' },
    }),
  );
  assert.match(usd, /\$19\.99/);
});

test('check_ledger_balance confirms zero-sum, rejects unbalanced', async () => {
  const client = await connect();
  const ok = textOf(
    await client.callTool({
      name: 'check_ledger_balance',
      arguments: {
        legs: [
          { account: 'customer_balance', minorUnits: '1999', currency: 'USD' },
          { account: 'revenue_accrued', minorUnits: '-1999', currency: 'USD' },
        ],
      },
    }),
  );
  assert.match(ok, /BALANCED/);

  const bad = textOf(
    await client.callTool({
      name: 'check_ledger_balance',
      arguments: {
        legs: [
          { account: 'cash', minorUnits: '2000', currency: 'USD' },
          { account: 'customer_balance', minorUnits: '-1999', currency: 'USD' },
        ],
      },
    }),
  );
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

test('search_api falls back to the generated export list for uncurated names', async () => {
  const client = await connect();
  const out = textOf(await client.callTool({ name: 'search_api', arguments: { query: 'walletTopupPosting' } }));
  assert.match(out, /walletTopupPosting\s+\(value, from '@quxkit\/billing-kit'\)/);
  const none = textOf(await client.callTool({ name: 'search_api', arguments: { query: 'zzz-not-a-thing' } }));
  assert.match(none, /No billing-kit symbol matched/);
});

test('tool failures carry isError: true, successes do not', async () => {
  const client = await connect();
  const bad = await client.callTool({
    name: 'price_usage',
    arguments: { quantity: 'not-a-number', rate: '0.1', currency: 'USD' },
  });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Could not price this/);

  const badMoney = await client.callTool({ name: 'format_money', arguments: { minorUnits: '19.99', currency: 'USD' } });
  assert.equal(badMoney.isError, true);

  const badLegs = await client.callTool({
    name: 'check_ledger_balance',
    arguments: {
      legs: [
        { account: 'a', minorUnits: 'x', currency: 'USD' },
        { account: 'b', minorUnits: '-1', currency: 'USD' },
      ],
    },
  });
  assert.equal(badLegs.isError, true);

  const missing = await client.callTool({ name: 'get_component', arguments: { name: 'no-such-component' } });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /No component named/);

  const ok = await client.callTool({
    name: 'price_usage',
    arguments: { quantity: '1', rate: '100', currency: 'USD' },
  });
  assert.notEqual(ok.isError, true);
  // An unbalanced posting is a valid answer ("not balanced"), not a tool failure.
  const unbalanced = await client.callTool({
    name: 'check_ledger_balance',
    arguments: {
      legs: [
        { account: 'a', minorUnits: '2', currency: 'USD' },
        { account: 'b', minorUnits: '-1', currency: 'USD' },
      ],
    },
  });
  assert.notEqual(unbalanced.isError, true);
});

test('configFromEnv reads DATABASE_URL and BILLING_KIT_MCP_TENANT, blank means unset', async () => {
  const { configFromEnv } = await import('../src/index.ts');
  assert.deepEqual(configFromEnv({}), {
    databaseUrl: undefined,
    tenantScope: undefined,
    plansPath: undefined,
    allowWrites: false,
  });
  assert.deepEqual(configFromEnv({ DATABASE_URL: '  ', BILLING_KIT_MCP_TENANT: '' }), {
    databaseUrl: undefined,
    tenantScope: undefined,
    plansPath: undefined,
    allowWrites: false,
  });
  assert.deepEqual(configFromEnv({ DATABASE_URL: 'postgres://x/y', BILLING_KIT_MCP_TENANT: 'acme ' }), {
    databaseUrl: 'postgres://x/y',
    tenantScope: 'acme',
    plansPath: undefined,
    allowWrites: false,
  });
});

test('configFromEnv reads BILLING_KIT_MCP_PLANS', async () => {
  const { configFromEnv } = await import('../src/index.ts');
  assert.equal(configFromEnv({ BILLING_KIT_MCP_PLANS: './plans.json' }).plansPath, './plans.json');
  assert.equal(configFromEnv({}).plansPath, undefined);
});

test('configFromEnv: --allow-writes or BILLING_KIT_MCP_ALLOW_WRITES turns writes on', async () => {
  const { configFromEnv } = await import('../src/index.ts');
  assert.equal(configFromEnv({}).allowWrites, false);
  assert.equal(configFromEnv({}, ['--allow-writes']).allowWrites, true);
  assert.equal(configFromEnv({ BILLING_KIT_MCP_ALLOW_WRITES: '1' }).allowWrites, true);
  assert.equal(configFromEnv({ BILLING_KIT_MCP_ALLOW_WRITES: 'true' }).allowWrites, true);
  assert.equal(configFromEnv({ BILLING_KIT_MCP_ALLOW_WRITES: '0' }).allowWrites, false);
});
