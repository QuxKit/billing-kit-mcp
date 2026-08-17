// DB-backed read tools. Registered only when the server has a database.
//
// Everything here goes through billing-kit's own read functions — `queryUsage`,
// `aggregateUsage`, `balance`, `entries`, `walletBalance`, `getSubscription` —
// on an executor that `openDatabase` pinned read-only, so the number an
// assistant reports is the number the library computes, over a connection that
// cannot write. Three rules every tool obeys:
//
//   1. `tenantId` is a required argument. There is no "all tenants" read; a
//      call that forgets the tenant is a schema error, not a wide-open query.
//      When the server is started with BILLING_KIT_MCP_TENANT, a call naming
//      any other tenant is refused with isError.
//   2. Row-returning tools are capped (`limit` <= MAX_ROWS) and say when they
//      were cut short, so an assistant never sums a page and calls it a total —
//      it is told to narrow the window or use the aggregate tool.
//   3. Failures are `isError: true` with billing-kit's typed code where there is
//      one, so a host can branch on them.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountKind, AggregationMethod, SqlExecutor } from '@quxkit/billing-kit';
import { aggregateUsage, BillingError, balance, entries, queryUsage, walletBalance } from '@quxkit/billing-kit';
import { getSubscription } from '@quxkit/billing-kit/subscriptions';
import { z } from 'zod';

/** The most rows one call to a row-returning tool hands back. */
export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 50;

export interface DbToolOptions {
  db: SqlExecutor;
  /**
   * When set, every call must name this tenant. The scope is a guard on top of
   * the required argument, for an operator running one server per tenant.
   */
  tenantScope?: string;
}

const ACCOUNTS = [
  'customer_balance',
  'revenue_accrued',
  'revenue_settled',
  'settlement_variance',
  'cash',
  'customer_credit',
] as const satisfies readonly AccountKind[];

const METHODS = ['sum', 'count', 'max', 'unique'] as const satisfies readonly AggregationMethod[];

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});
const failure = (s: string) => ({ isError: true as const, content: [{ type: 'text' as const, text: s }] });

/**
 * A Quantity for display: billing-kit renders at its full scale
 * ("1000.000000000000"); trailing zeros carry no information, so they go — a
 * lossless trim, never a rounding.
 */
export const plainDecimal = (decimal: string): string =>
  decimal.includes('.') ? decimal.replace(/0+$/, '').replace(/\.$/, '') : decimal;

/** A tool failure carrying billing-kit's typed code when the error has one. */
function failed(what: string, err: unknown) {
  if (BillingError.is(err)) {
    return failure(`${what}: ${err.code} — ${err.message}`);
  }
  return failure(`${what}: ${(err as Error).message}`);
}

const tenantId = z.string().min(1).describe('The tenant. Required on every call; there is no cross-tenant read.');
const subjectId = z.string().min(1).describe('The billable party (customer/org) within the tenant.');
const isoDate = (what: string) =>
  z.string().datetime({ offset: true }).describe(`${what}, ISO-8601 with offset, e.g. "2026-08-01T00:00:00Z"`);
const limit = z
  .number()
  .int()
  .min(1)
  .max(MAX_ROWS)
  .optional()
  .describe(`Rows to return, 1..${MAX_ROWS} (default ${DEFAULT_ROWS}). The result says if it was cut short.`);

export function registerDbTools(server: McpServer, options: DbToolOptions): void {
  const { db, tenantScope } = options;

  /** The tenant guard: refuses a call for a tenant other than the scoped one. */
  const outOfScope = (t: string) =>
    tenantScope !== undefined && t !== tenantScope
      ? failure(`tenant "${t}" is outside this server's scope (BILLING_KIT_MCP_TENANT=${tenantScope})`)
      : null;

  server.registerTool(
    'query_usage',
    {
      title: 'Read raw usage events',
      description:
        "List a subject's recorded usage events in a half-open window [since, until), oldest first, " +
        `capped at ${MAX_ROWS} rows. For a total, use aggregate_usage — never sum a capped page.`,
      inputSchema: {
        tenantId,
        subjectId,
        metric: z.string().optional().describe('Restrict to one metric, e.g. "tokens.input". Omit for all.'),
        since: isoDate('Window start (inclusive)'),
        until: isoDate('Window end (exclusive)'),
        limit,
      },
    },
    async (a) => {
      const scoped = outOfScope(a.tenantId);
      if (scoped) return scoped;
      try {
        const want = a.limit ?? DEFAULT_ROWS;
        const rows = await queryUsage(db, {
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          metric: a.metric,
          window: { start: new Date(a.since), end: new Date(a.until) },
          limit: want + 1,
        });
        const truncated = rows.length > want;
        const page = truncated ? rows.slice(0, want) : rows;
        return json({
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          window: { since: a.since, until: a.until },
          count: page.length,
          truncated,
          ...(truncated ? { hint: 'More events exist. Narrow since/until, or use aggregate_usage for totals.' } : {}),
          events: page.map((e) => ({
            eventId: e.eventId,
            source: e.source,
            externalId: e.externalId,
            metric: e.metric,
            quantity: plainDecimal(e.quantity.toDecimalString()),
            occurredAt: e.occurredAt.toISOString(),
            receivedAt: e.receivedAt.toISOString(),
            metadata: e.metadata,
          })),
        });
      } catch (err) {
        return failed('Could not read usage', err);
      }
    },
  );

  server.registerTool(
    'aggregate_usage',
    {
      title: 'Aggregate usage over a window',
      description:
        "Collapse a subject's usage for one metric over [since, until) to one exact quantity, computed in " +
        'Postgres by billing-kit (sum | count | max | unique). This is the number a charge is priced on.',
      inputSchema: {
        tenantId,
        subjectId,
        metric: z.string().min(1),
        since: isoDate('Window start (inclusive)'),
        until: isoDate('Window end (exclusive)'),
        method: z.enum(METHODS).default('sum'),
        uniqueBy: z.string().optional().describe('For method "unique": the metadata key whose distinct values count.'),
      },
    },
    async (a) => {
      const scoped = outOfScope(a.tenantId);
      if (scoped) return scoped;
      try {
        const agg = await aggregateUsage(db, {
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          metric: a.metric,
          window: { start: new Date(a.since), end: new Date(a.until) },
          method: a.method,
          uniqueBy: a.uniqueBy,
        });
        return json({
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          metric: agg.metric,
          method: agg.method,
          window: { since: a.since, until: a.until },
          quantity: plainDecimal(agg.quantity.toDecimalString()),
          eventCount: agg.eventCount,
        });
      } catch (err) {
        return failed('Could not aggregate usage', err);
      }
    },
  );

  server.registerTool(
    'ledger_balance',
    {
      title: 'Balance of one ledger account',
      description:
        "The balance of one account for one subject in one currency — billing-kit's exact SUM in Postgres. " +
        'Positive is a debit balance (customer_balance: what they owe), negative a credit balance.',
      inputSchema: {
        tenantId,
        subjectId,
        account: z.enum(ACCOUNTS),
        currency: z.string().length(3),
        asOf: isoDate('Balance as of this instant (exclusive)').optional(),
      },
    },
    async (a) => {
      const scoped = outOfScope(a.tenantId);
      if (scoped) return scoped;
      try {
        const m = await balance(db, {
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          account: a.account,
          currency: a.currency.toUpperCase(),
          asOf: a.asOf ? new Date(a.asOf) : undefined,
        });
        return json({
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          account: a.account,
          currency: m.currency,
          balance: m.toDecimalString(),
          minorUnits: m.toJSON().amount,
          ...(a.asOf ? { asOf: a.asOf } : {}),
        });
      } catch (err) {
        return failed('Could not read the balance', err);
      }
    },
  );

  server.registerTool(
    'ledger_entries',
    {
      title: 'Read ledger entries',
      description:
        "A subject's ledger entries, oldest first, optionally for one account and/or window, capped at " +
        `${MAX_ROWS} rows. For the authoritative total use ledger_balance — never sum a capped page.`,
      inputSchema: {
        tenantId,
        subjectId,
        account: z.enum(ACCOUNTS).optional(),
        since: isoDate('Posted at or after (inclusive)').optional(),
        until: isoDate('Posted before (exclusive)').optional(),
        limit,
      },
    },
    async (a) => {
      const scoped = outOfScope(a.tenantId);
      if (scoped) return scoped;
      try {
        const want = a.limit ?? DEFAULT_ROWS;
        const rows = await entries(db, {
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          account: a.account,
          since: a.since ? new Date(a.since) : undefined,
          until: a.until ? new Date(a.until) : undefined,
          limit: want + 1,
        });
        const truncated = rows.length > want;
        const page = truncated ? rows.slice(0, want) : rows;
        return json({
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          count: page.length,
          truncated,
          ...(truncated
            ? { hint: 'More entries exist. Narrow since/until, or use ledger_balance for the total.' }
            : {}),
          entries: page.map((e) => ({
            id: e.id,
            transactionId: e.transactionId,
            account: e.account,
            amount: e.amount.toDecimalString(),
            currency: e.amount.currency,
            legNo: e.legNo,
            sourceKind: e.sourceKind,
            sourceId: e.sourceId,
            postedAt: e.postedAt.toISOString(),
            memo: e.memo,
          })),
        });
      } catch (err) {
        return failed('Could not read entries', err);
      }
    },
  );

  server.registerTool(
    'subscription_status',
    {
      title: 'Subscription status',
      description:
        "One subscription's persisted state — plan, state (trialing | active | canceled), seats, current period, " +
        'trial end, cancel-at-period-end — by id or by the caller key it was created under.',
      inputSchema: {
        tenantId,
        id: z.string().optional().describe('The subscription id.'),
        key: z.string().optional().describe("The caller's idempotency key from creation. Give id or key."),
      },
    },
    async (a) => {
      const scoped = outOfScope(a.tenantId);
      if (scoped) return scoped;
      try {
        const s = await getSubscription(db, { tenantId: a.tenantId, id: a.id, key: a.key });
        if (!s)
          return failure(`No subscription in tenant "${a.tenantId}" with ${a.id ? `id ${a.id}` : `key ${a.key}`}`);
        return json({
          id: s.id,
          tenantId: s.tenantId,
          subjectId: s.subjectId,
          key: s.key,
          planId: s.planId,
          currency: s.currency,
          state: s.state,
          seats: s.seats,
          currentPeriodStart: s.currentPeriodStart.toISOString(),
          currentPeriodEnd: s.currentPeriodEnd.toISOString(),
          trialEnd: s.trialEnd?.toISOString() ?? null,
          startedAt: s.startedAt.toISOString(),
          canceledAt: s.canceledAt?.toISOString() ?? null,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        });
      } catch (err) {
        return failed('Could not read the subscription', err);
      }
    },
  );

  server.registerTool(
    'wallet_balance',
    {
      title: 'Prepaid wallet balance',
      description:
        "The prepaid credit a subject has to spend, as a positive amount — billing-kit's walletBalance " +
        '(the negation of the customer_credit liability).',
      inputSchema: {
        tenantId,
        subjectId,
        currency: z.string().length(3),
        asOf: isoDate('Balance as of this instant (exclusive)').optional(),
      },
    },
    async (a) => {
      const scoped = outOfScope(a.tenantId);
      if (scoped) return scoped;
      try {
        const m = await walletBalance(db, {
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          currency: a.currency.toUpperCase(),
          asOf: a.asOf ? new Date(a.asOf) : undefined,
        });
        return json({
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          currency: m.currency,
          available: m.toDecimalString(),
          minorUnits: m.toJSON().amount,
        });
      } catch (err) {
        return failed('Could not read the wallet', err);
      }
    },
  );
}
