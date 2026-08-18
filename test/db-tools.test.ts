// The DB-backed read tools, against the real billing_kit_test database.
//
// Seeded through billing-kit's own API (record, post, createSubscription) on a
// writable executor; read back through the server over an in-memory MCP client
// on the read-only executor the bin uses. Every assertion is therefore "the
// tool reports what billing-kit wrote", not "the tool reports what the test
// inserted with hand-written SQL".

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  accrualPosting,
  Money,
  post,
  Quantity,
  Rate,
  record,
  type SqlExecutor,
  walletTopupPosting,
} from '@quxkit/billing-kit';
import { createSubscription, definePlan } from '@quxkit/billing-kit/subscriptions';
import { loadPlanCatalogue } from '../src/catalogue.ts';
import { createServer, type ServerOptions } from '../src/index.ts';
import { MAX_ROWS } from '../src/tools/db.ts';
import { type DbHarness, SKIP_REASON, setupDatabase } from './db-harness.ts';

const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const iso = (d: Date) => d.toISOString();
const usd = (v: string) => Money.fromDecimalString(v, 'USD');

async function connect(options: ServerOptions) {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTx);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTx);
  return client;
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
const textOf = (r: ToolResult): string =>
  (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
// biome-ignore lint/suspicious/noExplicitAny: test-side JSON parse of the tool text
const jsonOf = (r: ToolResult): any => JSON.parse(textOf(r));

const harness: DbHarness | null = await setupDatabase();

after(async () => {
  await harness?.close();
});

describe('DB-backed read tools', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as DbHarness;
  let client: Client;
  let subscriptionId = '';

  before(async () => {
    const seed: SqlExecutor = h.seed;
    // 60 usage events for acme/u1 (tokens.input), 3 for another metric, 2 for
    // another tenant with the same subject id — the tenant boundary must hold.
    for (let i = 0; i < 60; i++) {
      await record(
        seed,
        {
          tenantId: 'acme',
          subjectId: 'u1',
          source: 'test',
          externalId: `evt-${i}`,
          metric: 'tokens.input',
          quantity: Quantity.fromBigInt(1000n),
          occurredAt: minutesAgo(120 - i),
          metadata: { model: i % 2 === 0 ? 'a' : 'b' },
        },
        NOW,
      );
    }
    for (let i = 0; i < 3; i++) {
      await record(
        seed,
        {
          tenantId: 'acme',
          subjectId: 'u1',
          source: 'test',
          externalId: `gb-${i}`,
          metric: 'gb_hours',
          quantity: Quantity.fromDecimalString('2.5'),
          occurredAt: minutesAgo(30 - i),
        },
        NOW,
      );
    }
    for (let i = 0; i < 2; i++) {
      await record(
        seed,
        {
          tenantId: 'other',
          subjectId: 'u1',
          source: 'test',
          externalId: `o-${i}`,
          metric: 'tokens.input',
          quantity: Quantity.fromBigInt(999_999n),
          occurredAt: minutesAgo(10),
        },
        NOW,
      );
    }
    // A charge (customer owes 19.99) and a wallet top-up of 20.00.
    await post(
      seed,
      accrualPosting({ tenantId: 'acme', subjectId: 'u1', chargeId: 'ch-1', amount: usd('19.99'), memo: 'Aug' }),
      NOW,
    );
    await post(
      seed,
      walletTopupPosting({
        tenantId: 'acme',
        subjectId: 'u1',
        paymentId: 'pay-1',
        amount: usd('20.00'),
        occurredAt: NOW,
      }),
      NOW,
    );
    // A subscription.
    const plan = definePlan({
      id: 'team',
      currency: 'USD',
      interval: 'month',
      flat: usd('49.00'),
      usage: [
        {
          metric: 'tokens.input',
          included: Quantity.fromBigInt(1_000_000n),
          price: { kind: 'flat', rate: Rate.fromDecimalString('0.00012') },
        },
      ],
    });
    // Started 300 minutes ago, so the seeded usage falls inside its first period.
    const sub = await createSubscription(
      seed,
      { tenantId: 'acme', subjectId: 'u1', key: 'sub-k1', plan, seats: 3, startAt: minutesAgo(300) },
      NOW,
    );
    subscriptionId = sub.id;

    client = await connect({ db: h.db });
  });

  it('registers the six DB tools only when a db is given', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const t of [
      'query_usage',
      'aggregate_usage',
      'ledger_balance',
      'ledger_entries',
      'subscription_status',
      'wallet_balance',
    ]) {
      assert.ok(names.includes(t), `missing ${t}`);
    }
    const bare = await connect({});
    const bareNames = (await bare.listTools()).tools.map((t) => t.name);
    assert.ok(!bareNames.includes('query_usage'));
    // tenantId is required in every DB tool's schema
    for (const t of tools.filter((t) => names.includes(t.name) && t.name !== 'price_usage')) {
      if (
        ![
          'query_usage',
          'aggregate_usage',
          'ledger_balance',
          'ledger_entries',
          'subscription_status',
          'wallet_balance',
        ].includes(t.name)
      )
        continue;
      const req = (t.inputSchema as { required?: string[] }).required ?? [];
      assert.ok(req.includes('tenantId'), `${t.name} must require tenantId`);
    }
  });

  it('the read-only executor refuses writes', async () => {
    await assert.rejects(
      () =>
        h.db.query(
          `INSERT INTO billing.usage_event_keys (tenant_id, source, external_id, event_id, occurred_at) VALUES ('x','y','z', gen_random_uuid(), now())`,
        ),
      /read-only transaction/,
    );
    // ...and inside a transaction too
    await assert.rejects(
      () => h.db.transaction((tx) => tx.query(`DELETE FROM billing.usage_events`)),
      /read-only transaction/,
    );
    // reads are fine
    const rows = await h.db.query<{ n: string }>('SELECT count(*)::text AS n FROM billing.usage_events');
    assert.equal(rows[0]?.n, '65');
  });

  it('query_usage pages with a cap and says when it was cut short', async () => {
    const r = await client.callTool({
      name: 'query_usage',
      arguments: {
        tenantId: 'acme',
        subjectId: 'u1',
        metric: 'tokens.input',
        since: iso(minutesAgo(200)),
        until: iso(NOW),
      },
    });
    assert.notEqual(r.isError, true);
    const out = jsonOf(r);
    assert.equal(out.count, 50, 'default page is 50');
    assert.equal(out.truncated, true);
    assert.match(out.hint, /aggregate_usage/);
    assert.equal(out.events[0].quantity, '1000');
    assert.equal(out.events[0].metric, 'tokens.input');
    assert.ok(out.events[0].occurredAt < out.events[1].occurredAt, 'oldest first');

    const all = jsonOf(
      await client.callTool({
        name: 'query_usage',
        arguments: { tenantId: 'acme', subjectId: 'u1', since: iso(minutesAgo(200)), until: iso(NOW), limit: MAX_ROWS },
      }),
    );
    assert.equal(all.count, 63);
    assert.equal(all.truncated, false);

    // over the cap is a schema error, not a bigger page
    const tooMany = await client.callTool({
      name: 'query_usage',
      arguments: {
        tenantId: 'acme',
        subjectId: 'u1',
        since: iso(minutesAgo(200)),
        until: iso(NOW),
        limit: MAX_ROWS + 1,
      },
    });
    assert.equal(tooMany.isError, true);
  });

  it('query_usage holds the tenant boundary and requires tenantId', async () => {
    const other = jsonOf(
      await client.callTool({
        name: 'query_usage',
        arguments: { tenantId: 'other', subjectId: 'u1', since: iso(minutesAgo(200)), until: iso(NOW) },
      }),
    );
    assert.equal(other.count, 2);
    assert.equal(other.events[0].quantity, '999999');

    const missing = await client.callTool({
      name: 'query_usage',
      arguments: { subjectId: 'u1', since: iso(minutesAgo(200)), until: iso(NOW) },
    });
    assert.equal(missing.isError, true);
  });

  it('aggregate_usage returns the exact quantity billing-kit computes', async () => {
    const sum = jsonOf(
      await client.callTool({
        name: 'aggregate_usage',
        arguments: {
          tenantId: 'acme',
          subjectId: 'u1',
          metric: 'tokens.input',
          since: iso(minutesAgo(200)),
          until: iso(NOW),
        },
      }),
    );
    assert.equal(sum.method, 'sum');
    assert.equal(sum.quantity, '60000');
    assert.equal(sum.eventCount, 60);

    const gb = jsonOf(
      await client.callTool({
        name: 'aggregate_usage',
        arguments: {
          tenantId: 'acme',
          subjectId: 'u1',
          metric: 'gb_hours',
          since: iso(minutesAgo(200)),
          until: iso(NOW),
        },
      }),
    );
    assert.equal(gb.quantity, '7.5');

    const uniq = jsonOf(
      await client.callTool({
        name: 'aggregate_usage',
        arguments: {
          tenantId: 'acme',
          subjectId: 'u1',
          metric: 'tokens.input',
          since: iso(minutesAgo(200)),
          until: iso(NOW),
          method: 'unique',
          uniqueBy: 'model',
        },
      }),
    );
    assert.equal(uniq.quantity, '2');

    // billing-kit's typed failure surfaces with its code
    const bad = await client.callTool({
      name: 'aggregate_usage',
      arguments: {
        tenantId: 'acme',
        subjectId: 'u1',
        metric: 'tokens.input',
        since: iso(NOW),
        until: iso(minutesAgo(200)),
      },
    });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /window_invalid/);
  });

  it('ledger_balance and ledger_entries read the posted ledger', async () => {
    const owed = jsonOf(
      await client.callTool({
        name: 'ledger_balance',
        arguments: { tenantId: 'acme', subjectId: 'u1', account: 'customer_balance', currency: 'usd' },
      }),
    );
    assert.equal(owed.balance, '19.99');
    assert.equal(owed.minorUnits, '1999');
    assert.equal(owed.currency, 'USD');

    const rev = jsonOf(
      await client.callTool({
        name: 'ledger_balance',
        arguments: { tenantId: 'acme', subjectId: 'u1', account: 'revenue_accrued', currency: 'USD' },
      }),
    );
    assert.equal(rev.balance, '-19.99');

    const before = jsonOf(
      await client.callTool({
        name: 'ledger_balance',
        arguments: {
          tenantId: 'acme',
          subjectId: 'u1',
          account: 'customer_balance',
          currency: 'USD',
          asOf: iso(minutesAgo(600)),
        },
      }),
    );
    assert.equal(before.balance, '0.00');

    const ents = jsonOf(
      await client.callTool({
        name: 'ledger_entries',
        arguments: { tenantId: 'acme', subjectId: 'u1' },
      }),
    );
    assert.equal(ents.count, 4, 'two postings, two legs each');
    assert.equal(ents.truncated, false);
    const kinds = new Set(ents.entries.map((e: { sourceKind: string }) => e.sourceKind));
    assert.deepEqual([...kinds].sort(), ['charge', 'payment']);
    assert.ok(ents.entries.some((e: { memo: string | null }) => e.memo === 'Aug'));

    const one = jsonOf(
      await client.callTool({
        name: 'ledger_entries',
        arguments: { tenantId: 'acme', subjectId: 'u1', account: 'cash', limit: 1 },
      }),
    );
    assert.equal(one.count, 1);
    assert.equal(one.entries[0].account, 'cash');
    assert.equal(one.entries[0].amount, '20.00');

    const paged = jsonOf(
      await client.callTool({
        name: 'ledger_entries',
        arguments: { tenantId: 'acme', subjectId: 'u1', limit: 3 },
      }),
    );
    assert.equal(paged.count, 3);
    assert.equal(paged.truncated, true);
    assert.match(paged.hint, /ledger_balance/);
  });

  it('wallet_balance is the positive prepaid credit', async () => {
    const w = jsonOf(
      await client.callTool({
        name: 'wallet_balance',
        arguments: { tenantId: 'acme', subjectId: 'u1', currency: 'USD' },
      }),
    );
    assert.equal(w.available, '20.00');
    assert.equal(w.minorUnits, '2000');
    const none = jsonOf(
      await client.callTool({
        name: 'wallet_balance',
        arguments: { tenantId: 'other', subjectId: 'u1', currency: 'USD' },
      }),
    );
    assert.equal(none.available, '0.00');
  });

  it('subscription_status by id and by key; not found is a tool error', async () => {
    const byId = jsonOf(
      await client.callTool({ name: 'subscription_status', arguments: { tenantId: 'acme', id: subscriptionId } }),
    );
    assert.equal(byId.planId, 'team');
    assert.equal(byId.state, 'active');
    assert.equal(byId.seats, 3);
    assert.equal(byId.key, 'sub-k1');
    const byKey = jsonOf(
      await client.callTool({ name: 'subscription_status', arguments: { tenantId: 'acme', key: 'sub-k1' } }),
    );
    assert.equal(byKey.id, subscriptionId);

    const wrongTenant = await client.callTool({
      name: 'subscription_status',
      arguments: { tenantId: 'other', id: subscriptionId },
    });
    assert.equal(wrongTenant.isError, true);
    assert.match(textOf(wrongTenant), /No subscription/);

    const neither = await client.callTool({ name: 'subscription_status', arguments: { tenantId: 'acme' } });
    assert.equal(neither.isError, true);
    assert.match(textOf(neither), /invalid_subscription/);
  });

  it('BILLING_KIT_MCP_TENANT scoping refuses other tenants on every tool', async () => {
    const scoped = await connect({ db: h.db, tenantScope: 'acme' });
    const ok = await scoped.callTool({
      name: 'wallet_balance',
      arguments: { tenantId: 'acme', subjectId: 'u1', currency: 'USD' },
    });
    assert.notEqual(ok.isError, true);

    const calls: Array<[string, Record<string, unknown>]> = [
      ['query_usage', { subjectId: 'u1', since: iso(minutesAgo(200)), until: iso(NOW) }],
      ['aggregate_usage', { subjectId: 'u1', metric: 'tokens.input', since: iso(minutesAgo(200)), until: iso(NOW) }],
      ['ledger_balance', { subjectId: 'u1', account: 'cash', currency: 'USD' }],
      ['ledger_entries', { subjectId: 'u1' }],
      ['subscription_status', { key: 'sub-k1' }],
      ['wallet_balance', { subjectId: 'u1', currency: 'USD' }],
    ];
    for (const [name, args] of calls) {
      const r = await scoped.callTool({ name, arguments: { tenantId: 'other', ...args } });
      assert.equal(r.isError, true, `${name} must refuse an out-of-scope tenant`);
      assert.match(textOf(r), /outside this server's scope/);
    }
  });

  it('explain-charge walks the subscription, plan, usage and ledger with billing-kit numbers', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const catalogue = await loadPlanCatalogue(resolve(here, 'fixtures', 'plans.json'));
    const withPlans = await connect({ db: h.db, catalogue });
    const got = await withPlans.getPrompt({
      name: 'explain-charge',
      arguments: { tenantId: 'acme', subscription: 'sub-k1' },
    });
    const text = (got.messages[0]?.content as { text: string } | undefined)?.text ?? '';
    assert.match(text, /billing-kit's walk/);
    assert.match(
      text,
      new RegExp(`subscription: ${subscriptionId} \\(key sub-k1\\) subject u1 plan "team" state active seats 3`),
    );
    assert.match(text, /plan: team USD per month: base 49.00, seat 10.00 \(min 1\), trial 14 days/);
    // 60 x 1000 tokens in the period, 10k included in the catalogue plan -> 50k overage x 0.00012 = 6 minor
    assert.match(text, /usage tokens.input: 60000 over 60 events, included 10000/);
    assert.match(text, /usage gb_hours: 7.5 over 3 events/);
    assert.match(text, /flat\s+49\.00 USD/);
    assert.match(text, /seats\s+30\.00 USD/);
    assert.match(text, /usage\s+0\.06 USD.*tokens/);
    assert.match(text, /total: \d+\.\d\d USD/);
    // the ledger half: the seeded accrual is a charge posting; owed is 19.99
    assert.match(text, /1 charge posting\(s\) to customer_balance since period start: 19.99 USD \(ch-1, Aug\)/);
    assert.match(text, /owed now \(customer_balance USD\): 19.99/);

    // by id too
    const byId = await withPlans.getPrompt({
      name: 'explain-charge',
      arguments: { tenantId: 'acme', subscription: subscriptionId },
    });
    assert.match((byId.messages[0]?.content as { text: string } | undefined)?.text ?? '', /key sub-k1/);

    // no catalogue: the walk says the plan is unavailable and points at the tools
    const noPlans = await client.getPrompt({
      name: 'explain-charge',
      arguments: { tenantId: 'acme', subscription: 'sub-k1' },
    });
    const t2 = (noPlans.messages[0]?.content as { text: string } | undefined)?.text ?? '';
    assert.match(t2, /plan: unavailable — no plan catalogue is configured/);
    assert.match(t2, /owed now/);

    // plan not in the catalogue
    const solo = await loadPlanCatalogue(resolve(here, 'fixtures', 'plans.mjs'));
    const wrongCat = await connect({ db: h.db, catalogue: solo });
    const t3 =
      (
        (await wrongCat.getPrompt({ name: 'explain-charge', arguments: { tenantId: 'acme', subscription: 'sub-k1' } }))
          .messages[0]?.content as { text: string } | undefined
      )?.text ?? '';
    assert.match(t3, /plan: "team" is NOT in the catalogue .*\(have solo\)/);

    // not found, and out of scope
    const missing = await withPlans.getPrompt({
      name: 'explain-charge',
      arguments: { tenantId: 'acme', subscription: 'no-such' },
    });
    assert.match((missing.messages[0]?.content as { text: string } | undefined)?.text ?? '', /NOT FOUND/);
    const scoped = await connect({ db: h.db, tenantScope: 'acme' });
    const out = await scoped.getPrompt({ name: 'explain-charge', arguments: { tenantId: 'other', subscription: 'x' } });
    assert.match((out.messages[0]?.content as { text: string } | undefined)?.text ?? '', /scoped to tenant "acme"/);
  });
});
