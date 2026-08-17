// Prompts: reusable, argument-taking instructions a host can offer as a slash
// command. One so far:
//
//   explain-charge  — walk a subject's period charge: the subscription, the plan
//                     it references, the usage aggregated per metered metric over
//                     the current period, and the charge billing-kit computes
//                     from those — then ask the assistant to explain it.
//
// When the server has a database (and a catalogue), the prompt does the walk
// itself and embeds the figures, so the assistant explains numbers billing-kit
// produced rather than ones it derived. Without one, it hands back the same
// walk as a procedure over the tools, so the assistant still follows the right
// path instead of improvising.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { aggregateUsage, balance, entries, type Quantity, type SqlExecutor } from '@quxkit/billing-kit';
import { chargeForPeriod, getSubscription, type Subscription } from '@quxkit/billing-kit/subscriptions';
import { z } from 'zod';
import type { PlanCatalogue } from './catalogue.js';
import { plainDecimal } from './tools/db.js';

export interface PromptOptions {
  db?: SqlExecutor;
  tenantScope?: string;
  catalogue?: PlanCatalogue;
}

const PROCEDURE = [
  'Walk the charge step by step, using the tools rather than arithmetic of your own:',
  '1. subscription_status (by id or key) — plan id, state, seats, currentPeriodStart/End, trialEnd.',
  '2. Read billing://plans and find that plan: base fee, seat price, and each metered metric with its',
  '   included allowance and overage price.',
  '3. For each metered metric, aggregate_usage (sum) over [currentPeriodStart, currentPeriodEnd).',
  '4. Lines: base fee (waived while the period starts inside the trial); seats x seat price (at least',
  '   the plan minimum); for each metric, usage above the included allowance priced with price_usage;',
  '   any discount last. Sum with billing-kit numbers only.',
  '5. ledger_entries for the subject in the period (sourceKind "charge") and ledger_balance of',
  '   customer_balance to show what was posted and what is owed now.',
  'Explain each line in plain language, quote the exact figures the tools returned, and say clearly',
  'when a figure could not be obtained rather than estimating it.',
].join('\n');

const userMessage = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

export function registerPrompts(server: McpServer, options: PromptOptions = {}): void {
  server.registerPrompt(
    'explain-charge',
    {
      title: 'Explain a period charge',
      description:
        "Walk a subject's charge for the current subscription period — subscription, plan, per-metric usage, " +
        'the lines billing-kit computes, and what the ledger shows — and explain it in plain language.',
      argsSchema: {
        tenantId: z.string().describe('The tenant.'),
        subscription: z.string().describe('The subscription id, or the caller key it was created under.'),
      },
    },
    async ({ tenantId, subscription }) => {
      const head = `Explain the current-period charge for subscription "${subscription}" in tenant "${tenantId}".`;
      if (!options.db) return userMessage(`${head}\n\n${PROCEDURE}`);
      if (options.tenantScope !== undefined && tenantId !== options.tenantScope) {
        return userMessage(
          `${head}\n\nThis server is scoped to tenant "${options.tenantScope}"; it cannot read tenant "${tenantId}". ` +
            'Tell the user so rather than guessing.',
        );
      }
      const walk = await walkCharge(options.db, options.catalogue, tenantId, subscription);
      return userMessage(
        `${head}\n\nbilling-kit's walk of this charge (computed by the server, not to be re-derived):\n\n` +
          `${walk}\n\n` +
          'Explain each line in plain language for the customer, quoting these exact figures. Where a figure ' +
          'is marked unavailable, say so and use the tools listed to obtain it rather than estimating.\n\n' +
          PROCEDURE,
      );
    },
  );
}

async function walkCharge(
  db: SqlExecutor,
  catalogue: PlanCatalogue | undefined,
  tenantId: string,
  ref: string,
): Promise<string> {
  const out: string[] = [];
  // By id first, then by key. A ref that is not an id (the id column is a uuid)
  // makes the id lookup throw in Postgres; that is the signal to try the key.
  const sub: Subscription | null =
    (await getSubscription(db, { tenantId, id: ref }).catch(() => null)) ??
    (await getSubscription(db, { tenantId, key: ref }));
  if (!sub) return `subscription: NOT FOUND — no subscription with id or key "${ref}" in tenant "${tenantId}".`;

  const start = sub.currentPeriodStart;
  const end = sub.currentPeriodEnd;
  const trial = sub.trialEnd !== null && start < sub.trialEnd;
  out.push(
    `subscription: ${sub.id} (key ${sub.key}) subject ${sub.subjectId} plan "${sub.planId}" state ${sub.state} ` +
      `seats ${sub.seats} period [${start.toISOString()}, ${end.toISOString()})` +
      `${sub.trialEnd ? ` trialEnd ${sub.trialEnd.toISOString()}${trial ? ' (period starts inside the trial: base + seats waived)' : ''}` : ''}` +
      `${sub.cancelAtPeriodEnd ? ' cancels at period end' : ''}`,
  );

  const plan = catalogue?.plans.get(sub.planId);
  if (!plan) {
    out.push(
      catalogue
        ? `plan: "${sub.planId}" is NOT in the catalogue at ${catalogue.path} (have ${[...catalogue.plans.keys()].join(', ') || 'none'}). Lines unavailable.`
        : 'plan: unavailable — no plan catalogue is configured (BILLING_KIT_MCP_PLANS). Read the plan from the operator and price the lines with price_usage.',
    );
  } else {
    out.push(
      `plan: ${plan.id} ${plan.currency} per ${plan.interval}: base ${plan.flat.toDecimalString()}` +
        `${plan.seats ? `, seat ${plan.seats.unit.toDecimalString()} (min ${plan.seats.min ?? 0})` : ''}` +
        `${plan.trialDays ? `, trial ${plan.trialDays} days` : ''}`,
    );
    const usage: Record<string, Quantity> = {};
    for (const u of plan.usage) {
      const agg = await aggregateUsage(db, {
        tenantId,
        subjectId: sub.subjectId,
        metric: u.metric,
        window: { start, end },
        method: 'sum',
      });
      usage[u.metric] = agg.quantity;
      out.push(
        `usage ${u.metric}: ${plainDecimal(agg.quantity.toDecimalString())} over ${agg.eventCount} events` +
          `${u.included ? `, included ${plainDecimal(u.included.toDecimalString())}` : ''}` +
          `, price ${u.price.kind === 'flat' ? `flat ${u.price.rate.toDecimalString()} minor/unit` : `${u.price.mode} tiers`}`,
      );
    }
    const charge = chargeForPeriod(plan, { seats: sub.seats, usage, trial });
    out.push('lines:');
    for (const l of charge.lines) {
      out.push(
        `  ${l.kind.padEnd(9)} ${l.amount.toDecimalString().padStart(12)} ${charge.currency}  ${l.description}` +
          `${l.quantity ? ` (qty ${plainDecimal(l.quantity.toDecimalString())})` : ''}` +
          `${l.residueMinor !== undefined ? ` residue ${l.residueMinor}` : ''}`,
      );
    }
    out.push(`total: ${charge.total.toDecimalString()} ${charge.currency}`);
  }

  const currency = plan?.currency ?? sub.currency;
  const posted = await entries(db, {
    tenantId,
    subjectId: sub.subjectId,
    account: 'customer_balance',
    since: start,
    limit: 20,
  });
  const charges = posted.filter((e) => e.sourceKind === 'charge');
  out.push(
    charges.length
      ? `ledger: ${charges.length} charge posting(s) to customer_balance since period start: ${charges
          .map(
            (e) => `${e.amount.toDecimalString()} ${e.amount.currency} (${e.sourceId}${e.memo ? `, ${e.memo}` : ''})`,
          )
          .join('; ')}`
      : 'ledger: no charge posted to customer_balance since period start (the period has not been charged yet).',
  );
  const owed = await balance(db, { tenantId, subjectId: sub.subjectId, account: 'customer_balance', currency });
  out.push(`owed now (customer_balance ${currency}): ${owed.toDecimalString()}`);
  return out.join('\n');
}
