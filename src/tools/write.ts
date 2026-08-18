// Write tools. Off by default; on only with --allow-writes / BILLING_KIT_MCP_ALLOW_WRITES=1.
//
//   record_usage   one usage event, through billing-kit's `record`
//   apply_coupon   a credit note for a discount, through `applyDiscount` + `creditNotePosting` + `post`
//
// Four guards, in the order they are checked:
//
//   1. The flag. When writes are not enabled the tools are still listed — so an
//      assistant can tell the operator what it *would* do — but every call is
//      refused with isError. Nothing an argument can carry turns them on.
//   2. `confirm: true`. A required argument, not a default: the assistant has to
//      state, in the call, that the user asked for this write.
//   3. An idempotency key. billing-kit's ingest and ledger are idempotent on the
//      caller's key (`externalId` per source; `sourceId` per posting), so a
//      retried or duplicated call is a no-op that says `deduplicated: true` —
//      the retry is boring, which is the whole point.
//   4. The tenant scope, same as the read tools.
//
// Every attempt — refused or not — writes one audit line to stderr (never
// stdout: that is the protocol channel), so an operator can see what an
// assistant tried. `audit` is injectable for tests.
//
// The executor is the WRITABLE pool `openDatabase(url, { readOnly: false })`
// opens only when the flag is on; the read tools keep their read-only one.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BillingError,
  type Clock,
  creditNotePosting,
  Money,
  post,
  Quantity,
  record,
  type SqlExecutor,
} from '@quxkit/billing-kit';
import { applyDiscount, type DiscountRule } from '@quxkit/billing-kit/subscriptions';
import { z } from 'zod';

export interface WriteToolOptions {
  /** A writable executor. Absent when writes are off; calls are refused before it is touched. */
  db?: SqlExecutor;
  /** The flag. */
  enabled: boolean;
  tenantScope?: string;
  /** Where audit lines go. Defaults to stderr. */
  audit?: (line: string) => void;
  clock?: Clock;
}

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});
const failure = (s: string) => ({ isError: true as const, content: [{ type: 'text' as const, text: s }] });
function failed(what: string, err: unknown) {
  return BillingError.is(err)
    ? failure(`${what}: ${err.code} — ${err.message}`)
    : failure(`${what}: ${(err as Error).message}`);
}

export const WRITES_DISABLED =
  'writes are disabled on this server. Start it with --allow-writes (or BILLING_KIT_MCP_ALLOW_WRITES=1) ' +
  'to enable record_usage and apply_coupon; nothing in a tool call can turn them on.';

const tenantId = z.string().min(1).describe('The tenant. Required.');
const subjectId = z.string().min(1).describe('The billable party within the tenant.');
const confirm = z
  .boolean()
  .describe('Must be true. States that the user explicitly asked for this write; false or missing is refused.');
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'The caller-chosen idempotency key. Repeating a call with the same key is a no-op that reports ' +
      'deduplicated: true — never a second write.',
  );

export function registerWriteTools(server: McpServer, options: WriteToolOptions): void {
  const audit = options.audit ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.clock ?? (() => new Date());

  const log = (tool: string, fields: Record<string, unknown>) =>
    audit(
      `billing-kit-mcp: audit ${tool} ${Object.entries(fields)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')}`,
    );

  type Refusal = ReturnType<typeof failure>;
  type Gate = { refused: Refusal; db?: undefined } | { refused?: undefined; db: SqlExecutor };
  /** The shared guards. Returns a refusal, or the writable executor. */
  const admit = (tool: string, a: { tenantId: string; confirm: boolean; idempotencyKey: string }): Gate => {
    const base = { tenant: a.tenantId, key: a.idempotencyKey };
    if (!options.enabled || !options.db) {
      log(tool, { ...base, outcome: 'refused', reason: 'writes_disabled' });
      return { refused: failure(WRITES_DISABLED) };
    }
    if (a.confirm !== true) {
      log(tool, { ...base, outcome: 'refused', reason: 'not_confirmed' });
      return { refused: failure(`${tool} needs confirm: true — state that the user asked for this write.`) };
    }
    if (options.tenantScope !== undefined && a.tenantId !== options.tenantScope) {
      log(tool, { ...base, outcome: 'refused', reason: 'out_of_scope' });
      return {
        refused: failure(
          `tenant "${a.tenantId}" is outside this server's scope (BILLING_KIT_MCP_TENANT=${options.tenantScope})`,
        ),
      };
    }
    return { db: options.db };
  };

  server.registerTool(
    'record_usage',
    {
      title: 'Record one usage event (write)',
      description:
        "Record a usage event through billing-kit's idempotent ingest. Requires the server to run with " +
        '--allow-writes, confirm: true, and an idempotencyKey (stored as the event externalId, namespaced by ' +
        'source): the same key twice records once and reports deduplicated: true.',
      inputSchema: {
        tenantId,
        subjectId,
        source: z.string().min(1).describe('The producer, e.g. "assistant" or "api". Namespaces the key.'),
        metric: z.string().min(1).describe('What is counted, e.g. "tokens.input".'),
        quantity: z
          .string()
          .regex(/^\d+(\.\d+)?$/, 'a non-negative decimal string')
          .describe('Exact decimal quantity.'),
        occurredAt: z
          .string()
          .datetime({ offset: true })
          .describe(
            'When it happened (ISO-8601 with offset). Required, not defaulted: it is part of the event and of ' +
              'the idempotency check — a retry must send the same instant. Must not be in the future.',
          ),
        metadata: z.record(z.unknown()).optional(),
        idempotencyKey,
        confirm,
      },
    },
    async (a) => {
      const gate = admit('record_usage', a);
      if (gate.refused) return gate.refused;
      try {
        const at = now();
        const r = await record(
          gate.db,
          {
            tenantId: a.tenantId,
            subjectId: a.subjectId,
            source: a.source,
            externalId: a.idempotencyKey,
            metric: a.metric,
            quantity: Quantity.fromDecimalString(a.quantity),
            occurredAt: new Date(a.occurredAt),
            metadata: a.metadata,
          },
          at,
        );
        log('record_usage', {
          tenant: a.tenantId,
          subject: a.subjectId,
          key: a.idempotencyKey,
          metric: a.metric,
          quantity: a.quantity,
          outcome: r.deduplicated ? 'deduplicated' : 'recorded',
          eventId: r.eventId,
        });
        return json({
          recorded: !r.deduplicated,
          deduplicated: r.deduplicated,
          eventId: r.eventId,
          tenantId: a.tenantId,
          subjectId: a.subjectId,
          metric: a.metric,
          quantity: a.quantity,
          occurredAt: r.occurredAt.toISOString(),
          receivedAt: r.receivedAt.toISOString(),
        });
      } catch (err) {
        log('record_usage', { tenant: a.tenantId, key: a.idempotencyKey, outcome: 'failed', error: String(err) });
        return failed('Could not record usage', err);
      }
    },
  );

  server.registerTool(
    'apply_coupon',
    {
      title: 'Apply a coupon as a credit note (write)',
      description:
        'Reduce what a subject owes by a discount, posted as a credit note in the ledger (customer_balance ' +
        "down, revenue_accrued reversed) — billing-kit's append-only way to say a charge was too much. The " +
        'discount is applyDiscount(chargeAmount, rule): a percent in basis points (2000 = 20%) or a fixed ' +
        'amount, clamped to chargeAmount. chargeAmount is explicit (look it up with ledger_balance or the ' +
        'period charge) so a retry reproduces the same posting. Requires --allow-writes, confirm: true, and ' +
        'an idempotencyKey (the credit note id): the same key twice posts once.',
      inputSchema: {
        tenantId,
        subjectId,
        currency: z.string().length(3),
        coupon: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('percent'), bps: z.number().int().min(0).max(10_000) }),
            z.object({ kind: z.literal('amount'), off: z.string().regex(/^\d+(\.\d+)?$/, 'a decimal string') }),
          ])
          .describe('{ kind: "percent", bps } or { kind: "amount", off: "5.00" }'),
        chargeAmount: z
          .string()
          .regex(/^\d+(\.\d+)?$/, 'a decimal string')
          .describe('The amount the coupon applies to (decimal string in `currency`), e.g. the period charge.'),
        memo: z.string().max(200).optional(),
        idempotencyKey,
        confirm,
      },
    },
    async (a) => {
      const gate = admit('apply_coupon', a);
      if (gate.refused) return gate.refused;
      const cur = a.currency.toUpperCase();
      try {
        const base = Money.fromDecimalString(a.chargeAmount, cur);

        const rule: DiscountRule =
          a.coupon.kind === 'percent'
            ? { kind: 'percent', bps: a.coupon.bps }
            : { kind: 'amount', off: Money.fromDecimalString(a.coupon.off, cur) };
        const discount = applyDiscount(base, rule);
        if (discount.isZero()) {
          log('apply_coupon', {
            tenant: a.tenantId,
            subject: a.subjectId,
            key: a.idempotencyKey,
            outcome: 'nothing_to_apply',
          });
          return json({
            applied: false,
            reason: 'the discount comes to zero',
            base: base.toDecimalString(),
            currency: cur,
          });
        }
        const posted = await post(
          gate.db,
          creditNotePosting({
            tenantId: a.tenantId,
            subjectId: a.subjectId,
            creditNoteId: a.idempotencyKey,
            amount: discount,
            memo: a.memo ?? `coupon ${a.coupon.kind === 'percent' ? `${a.coupon.bps} bps` : `${a.coupon.off} ${cur}`}`,
          }),
          now(),
        );
        log('apply_coupon', {
          tenant: a.tenantId,
          subject: a.subjectId,
          key: a.idempotencyKey,
          discount: discount.toDecimalString(),
          currency: cur,
          outcome: posted.deduplicated ? 'deduplicated' : 'posted',
          transactionId: posted.transactionId,
        });
        return json({
          applied: !posted.deduplicated,
          deduplicated: posted.deduplicated,
          transactionId: posted.transactionId,
          base: base.toDecimalString(),
          discount: discount.toDecimalString(),
          currency: cur,
          creditNoteId: a.idempotencyKey,
        });
      } catch (err) {
        log('apply_coupon', { tenant: a.tenantId, key: a.idempotencyKey, outcome: 'failed', error: String(err) });
        return failed('Could not apply the coupon', err);
      }
    },
  );
}
