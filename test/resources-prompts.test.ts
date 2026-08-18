// Resources (billing://plans, billing://schema[/file]) and the explain-charge
// prompt, driven through a real MCP client over an in-memory transport. The
// DB-backed half of explain-charge (the actual walk) is in db-tools.test.ts,
// next to the seeded database it walks.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadPlanCatalogue, parseCatalogue } from '../src/catalogue.ts';
import { createServer, type ServerOptions } from '../src/index.ts';
import { billingKitSqlDir } from '../src/resources.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f: string) => resolve(here, 'fixtures', f);

async function connect(options: ServerOptions = {}) {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTx);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTx);
  return client;
}

test('loadPlanCatalogue: JSON ({plans:[...]}) and a module (default export), hydrated through definePlan', async () => {
  const json = await loadPlanCatalogue(fixture('plans.json'));
  assert.deepEqual([...json.plans.keys()], ['free', 'team']);
  const team = json.plans.get('team');
  assert.ok(team);
  assert.equal(team.flat.toDecimalString(), '49.00');
  assert.equal(team.seats?.unit.toDecimalString(), '10.00');
  assert.equal(team.usage[1]?.price.kind, 'tiered');
  assert.equal(team.trialDays, 14);
  assert.equal(json.entries[1]?.name, 'Team');

  const mod = await loadPlanCatalogue(fixture('plans.mjs'));
  assert.deepEqual([...mod.plans.keys()], ['solo']);
  assert.equal(mod.plans.get('solo')?.currency, 'EUR');
});

test('parseCatalogue refuses what billing-kit or the shape refuses, with the reason', () => {
  assert.throws(
    () => parseCatalogue({ plans: [{ id: 'x', currency: 'USD', interval: 'month', flat: 'ten' }] }, 'f'),
    /flat.*decimal/,
  );
  assert.throws(
    () => parseCatalogue([{ id: 'x', currency: 'ZZZ', interval: 'month', flat: '1.00', usage: [] }], 'f'),
    /unknown_currency|ZZZ/,
  );
  assert.throws(
    () =>
      parseCatalogue(
        [
          { id: 'x', currency: 'USD', interval: 'month', flat: '1.00', usage: [] },
          { id: 'x', currency: 'USD', interval: 'month', flat: '2.00', usage: [] },
        ],
        'f',
      ),
    /appears twice/,
  );
  assert.throws(() => parseCatalogue({ nope: true }, 'f'), /expected an array of plans/);
  // a negative base fee is billing-kit's invalid_plan, surfaced from definePlan
  assert.throws(
    () => parseCatalogue([{ id: 'x', currency: 'USD', interval: 'month', flat: '-1.00', usage: [] }], 'f'),
    /negative/,
  );
});

test('loadPlanCatalogue: bad or missing JSON is a clear error', async () => {
  await assert.rejects(() => loadPlanCatalogue(fixture('plans-bad.json')), /not valid JSON/);
  await assert.rejects(() => loadPlanCatalogue(fixture('missing.json')), /ENOENT/);
});

test("resources: billing://schema serves billing-kit's SQL; per-file template lists and reads", async () => {
  assert.ok(existsSync(billingKitSqlDir()), 'billing-kit sql dir resolves through package exports');
  const client = await connect();
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes('billing://schema'));
  assert.ok(!uris.includes('billing://plans'), 'no catalogue, no plans resource');
  assert.ok(
    uris.some((u) => u === 'billing://schema/001_core.sql'),
    'template list expands to files',
  );

  const all = await client.readResource({ uri: 'billing://schema' });
  const text = (all.contents[0] as { text: string }).text;
  assert.match(text, /===== 001_core\.sql =====/);
  assert.match(text, /CREATE TABLE IF NOT EXISTS billing\.ledger_entries/);
  assert.match(text, /===== 020_subscriptions\.sql =====/);
  assert.equal(all.contents[0]?.mimeType, 'application/sql');

  const one = await client.readResource({ uri: 'billing://schema/020_subscriptions.sql' });
  assert.match((one.contents[0] as { text: string }).text, /subscriptions/);
  assert.doesNotMatch((one.contents[0] as { text: string }).text, /===== 001_core/);

  await assert.rejects(() => client.readResource({ uri: 'billing://schema/nope.sql' }), /no such SQL file/);

  const { resourceTemplates } = await client.listResourceTemplates();
  assert.ok(resourceTemplates.some((t) => t.uriTemplate === 'billing://schema/{file}'));
});

test('resources: billing://plans serves the catalogue entries as JSON', async () => {
  const catalogue = await loadPlanCatalogue(fixture('plans.json'));
  const client = await connect({ catalogue });
  const { resources } = await client.listResources();
  const plans = resources.find((r) => r.uri === 'billing://plans');
  assert.ok(plans);
  assert.match(plans.description ?? '', /2, from .*plans\.json/);
  const r = await client.readResource({ uri: 'billing://plans' });
  const entries = JSON.parse((r.contents[0] as { text: string }).text);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].id, 'team');
  assert.equal(entries[1].seats.unit, '10.00');
});

test('prompt explain-charge without a database hands back the procedure', async () => {
  const client = await connect();
  const { prompts } = await client.listPrompts();
  const p = prompts.find((x) => x.name === 'explain-charge');
  assert.ok(p);
  assert.deepEqual(
    p.arguments?.map((a) => [a.name, a.required]),
    [
      ['tenantId', true],
      ['subscription', true],
    ],
  );
  const got = await client.getPrompt({
    name: 'explain-charge',
    arguments: { tenantId: 'acme', subscription: 'sub-k1' },
  });
  const text = (got.messages[0]?.content as { text: string } | undefined)?.text ?? '';
  assert.match(text, /subscription "sub-k1" in tenant "acme"/);
  assert.match(text, /subscription_status/);
  assert.match(text, /aggregate_usage/);
  assert.match(text, /billing:\/\/plans/);
  assert.doesNotMatch(text, /billing-kit's walk/);
});
