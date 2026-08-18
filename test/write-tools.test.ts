// The write tools, both ways: refused when the flag is off (and when confirm is
// missing, and out of scope), and actually writing through billing-kit when it
// is on — with the idempotency key making a replay a no-op — against the real
// billing_kit_test database. Audit lines are captured through the injectable
// sink and asserted on.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { accrualPosting, Money, post } from '@quxkit/billing-kit';
import { createServer, type ServerOptions } from '../src/index.ts';
import { WRITES_DISABLED } from '../src/tools/write.ts';
import { type DbHarness, SKIP_REASON, setupDatabase } from './db-harness.ts';

const NOW = new Date();
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
const jsonOf = (r: ToolResult): any => {
  const t = textOf(r);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`not JSON: ${t}`);
  }
};

const harness: DbHarness | null = await setupDatabase();
after(async () => {
  await harness?.close();
});

describe('write tools', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as DbHarness;
  const audit: string[] = [];
  let ro: Client; // db only, writes off
  let rw: Client; // writes on

  before(async () => {
    await post(
      h.seed,
      accrualPosting({ tenantId: 'acme', subjectId: 'u9', chargeId: 'ch-9', amount: usd('40.00'), memo: 'Sept' }),
      NOW,
    );
    ro = await connect({ db: h.db, audit: (l) => audit.push(l) });
    rw = await connect({ db: h.db, writeDb: h.seed, allowWrites: true, audit: (l) => audit.push(l) });
  });

  const usageArgs = {
    tenantId: 'acme',
    subjectId: 'u9',
    source: 'assistant',
    metric: 'tokens.input',
    quantity: '2500',
    occurredAt: NOW.toISOString(),
    idempotencyKey: 'req-1',
    confirm: true,
  };

  it('are listed but refuse with isError when writes are off', async () => {
    const names = (await ro.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('record_usage') && names.includes('apply_coupon'));
    // and not at all without any database
    const bare = await connect({});
    const bareNames = (await bare.listTools()).tools.map((t) => t.name);
    assert.ok(!bareNames.includes('record_usage'));

    audit.length = 0;
    const r = await ro.callTool({ name: 'record_usage', arguments: usageArgs });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), WRITES_DISABLED);
    const c = await ro.callTool({
      name: 'apply_coupon',
      arguments: {
        tenantId: 'acme',
        subjectId: 'u9',
        currency: 'USD',
        coupon: { kind: 'percent', bps: 1000 },
        chargeAmount: '40.00',
        idempotencyKey: 'cn-1',
        confirm: true,
      },
    });
    assert.equal(c.isError, true);
    assert.match(textOf(c), /writes are disabled/);
    assert.equal(audit.length, 2);
    assert.match(
      audit[0] ?? '',
      /audit record_usage tenant="acme" key="req-1" outcome="refused" reason="writes_disabled"/,
    );
    assert.match(audit[1] ?? '', /audit apply_coupon .*reason="writes_disabled"/);

    // the flag alone without a writable executor is still off
    const halfOn = await connect({ db: h.db, allowWrites: true });
    assert.equal((await halfOn.callTool({ name: 'record_usage', arguments: usageArgs })).isError, true);

    // nothing was written
    const rows = await h.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing.usage_events WHERE tenant_id = 'acme' AND subject_id = 'u9'`,
    );
    assert.equal(rows[0]?.n, '0');
  });

  it('require confirm: true and an idempotency key even when on', async () => {
    audit.length = 0;
    const notConfirmed = await rw.callTool({ name: 'record_usage', arguments: { ...usageArgs, confirm: false } });
    assert.equal(notConfirmed.isError, true);
    assert.match(textOf(notConfirmed), /needs confirm: true/);
    assert.match(audit[0] ?? '', /reason="not_confirmed"/);

    const noConfirm = await rw.callTool({ name: 'record_usage', arguments: { ...usageArgs, confirm: undefined } });
    assert.equal(noConfirm.isError, true);
    const noKey = await rw.callTool({ name: 'record_usage', arguments: { ...usageArgs, idempotencyKey: undefined } });
    assert.equal(noKey.isError, true);
    const emptyKey = await rw.callTool({ name: 'record_usage', arguments: { ...usageArgs, idempotencyKey: '' } });
    assert.equal(emptyKey.isError, true);
  });

  it('record_usage writes through billing-kit; a replay with the same key is a no-op', async () => {
    audit.length = 0;
    const first = jsonOf(await rw.callTool({ name: 'record_usage', arguments: usageArgs }));
    assert.equal(first.recorded, true);
    assert.equal(first.deduplicated, false);
    assert.ok(first.eventId);
    assert.match(audit[0] ?? '', /audit record_usage .*outcome="recorded"/);

    const again = jsonOf(await rw.callTool({ name: 'record_usage', arguments: usageArgs }));
    assert.equal(again.deduplicated, true);
    assert.equal(again.recorded, false);
    assert.equal(again.eventId, first.eventId);
    assert.match(audit[1] ?? '', /outcome="deduplicated"/);

    // the same key with a DIFFERENT payload is billing-kit's idempotency_conflict, not a second write
    const conflict = await rw.callTool({ name: 'record_usage', arguments: { ...usageArgs, quantity: '999' } });
    assert.equal(conflict.isError, true);
    assert.match(textOf(conflict), /idempotency_conflict/);

    // visible through the read tools, once, at the first quantity
    const agg = jsonOf(
      await ro.callTool({
        name: 'aggregate_usage',
        arguments: {
          tenantId: 'acme',
          subjectId: 'u9',
          metric: 'tokens.input',
          since: new Date(NOW.getTime() - 3_600_000).toISOString(),
          until: new Date(NOW.getTime() + 3_600_000).toISOString(),
        },
      }),
    );
    assert.equal(agg.quantity, '2500');
    assert.equal(agg.eventCount, 1);

    // billing-kit's own validation surfaces as a typed failure
    const future = await rw.callTool({
      name: 'record_usage',
      arguments: {
        ...usageArgs,
        idempotencyKey: 'req-future',
        occurredAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(),
      },
    });
    assert.equal(future.isError, true);
    assert.match(textOf(future), /invalid_event/);
    assert.match(audit.at(-1) ?? '', /outcome="failed"/);
  });

  it('apply_coupon posts a credit note against what is owed; replay is a no-op', async () => {
    const owedBefore = jsonOf(
      await ro.callTool({
        name: 'ledger_balance',
        arguments: { tenantId: 'acme', subjectId: 'u9', account: 'customer_balance', currency: 'USD' },
      }),
    );
    assert.equal(owedBefore.balance, '40.00');

    audit.length = 0;
    const args = {
      tenantId: 'acme',
      subjectId: 'u9',
      currency: 'usd',
      coupon: { kind: 'percent', bps: 2500 },
      chargeAmount: '40.00',
      idempotencyKey: 'coupon-spring',
      confirm: true,
    };
    const first = jsonOf(await rw.callTool({ name: 'apply_coupon', arguments: args }));
    assert.equal(first.applied, true);
    assert.equal(first.base, '40.00');
    assert.equal(first.discount, '10.00');
    assert.equal(first.creditNoteId, 'coupon-spring');
    assert.match(audit[0] ?? '', /audit apply_coupon .*discount="10.00" currency="USD" outcome="posted"/);

    const again = jsonOf(await rw.callTool({ name: 'apply_coupon', arguments: args }));
    assert.equal(again.deduplicated, true);
    assert.equal(again.applied, false);
    assert.equal(again.transactionId, first.transactionId);

    // same key, different discount: billing-kit refuses with idempotency_conflict — nothing posted
    const conflict = await rw.callTool({
      name: 'apply_coupon',
      arguments: { ...args, coupon: { kind: 'percent', bps: 10000 } },
    });
    assert.equal(conflict.isError, true);
    assert.match(textOf(conflict), /idempotency_conflict/);

    const owedAfter = jsonOf(
      await ro.callTool({
        name: 'ledger_balance',
        arguments: { tenantId: 'acme', subjectId: 'u9', account: 'customer_balance', currency: 'USD' },
      }),
    );
    assert.equal(owedAfter.balance, '30.00', 'one credit note of 10.00, not two');

    // fixed amount against an explicit charge amount, clamped by billing-kit
    const fixed = jsonOf(
      await rw.callTool({
        name: 'apply_coupon',
        arguments: {
          ...args,
          coupon: { kind: 'amount', off: '100.00' },
          chargeAmount: '5.00',
          idempotencyKey: 'coupon-fixed',
          memo: 'goodwill',
        },
      }),
    );
    assert.equal(fixed.discount, '5.00');
    const ents = jsonOf(
      await ro.callTool({
        name: 'ledger_entries',
        arguments: { tenantId: 'acme', subjectId: 'u9', account: 'customer_balance' },
      }),
    );
    assert.ok(
      ents.entries.some((e: { memo: string | null; amount: string }) => e.memo === 'goodwill' && e.amount === '-5.00'),
    );

    // nothing to apply: a discount that rounds to nothing posts nothing
    const nothing = jsonOf(
      await rw.callTool({
        name: 'apply_coupon',
        arguments: { ...args, chargeAmount: '0.00', idempotencyKey: 'coupon-nothing' },
      }),
    );
    assert.equal(nothing.applied, false);
    assert.match(nothing.reason, /zero/);
    // an occurredAt-less record_usage is a schema error: the instant is part of the key
    const noWhen = await rw.callTool({ name: 'record_usage', arguments: { ...usageArgs, occurredAt: undefined } });
    assert.equal(noWhen.isError, true);
    // chargeAmount is required on apply_coupon
    const noBase = await rw.callTool({
      name: 'apply_coupon',
      arguments: { ...args, chargeAmount: undefined, idempotencyKey: 'y' },
    });
    assert.equal(noBase.isError, true);

    // billing-kit's typed refusal
    const bad = await rw.callTool({
      name: 'apply_coupon',
      arguments: { ...args, coupon: { kind: 'percent', bps: 20000 }, idempotencyKey: 'x' },
    });
    assert.equal(bad.isError, true);
  });

  it('honour the tenant scope', async () => {
    const scoped = await connect({
      db: h.db,
      writeDb: h.seed,
      allowWrites: true,
      tenantScope: 'acme',
      audit: (l) => audit.push(l),
    });
    const r = await scoped.callTool({
      name: 'record_usage',
      arguments: { ...usageArgs, tenantId: 'other', idempotencyKey: 'o-1' },
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /outside this server's scope/);
    assert.match(audit.at(-1) ?? '', /reason="out_of_scope"/);
  });

  it('the default audit sink is stderr', async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const c = await connect({ db: h.db });
      await c.callTool({ name: 'record_usage', arguments: usageArgs });
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(lines.some((l) => l.startsWith('billing-kit-mcp: audit record_usage')));
  });
});
