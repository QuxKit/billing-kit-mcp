// Ledger tool. Checks a set of legs is a valid double-entry transaction — that
// they sum to zero per currency — using billing-kit's exact Money arithmetic,
// so an assistant proposing a posting can verify it before writing it.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Money } from '@quxkit/billing-kit';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export function registerLedgerTools(server: McpServer): void {
  server.registerTool(
    'check_ledger_balance',
    {
      title: 'Check a double-entry transaction balances',
      description:
        "Verify a transaction's legs sum to zero per currency — the invariant billing-kit's " +
        'ledger enforces with a deferred trigger. Amounts are integer minor units; positive is a ' +
        'debit, negative a credit.',
      inputSchema: {
        legs: z
          .array(
            z.object({
              account: z.string().describe('e.g. customer_balance, revenue_accrued, cash'),
              minorUnits: z.string().describe('Integer minor units; negative for a credit'),
              currency: z.string().length(3),
            }),
          )
          .min(2)
          .describe('The legs of one transaction'),
      },
    },
    async ({ legs }) => {
      try {
        const byCurrency = new Map<string, Money>();
        for (const leg of legs) {
          const cur = leg.currency.toUpperCase();
          const amount = Money.fromMinor(leg.minorUnits, cur);
          const running = byCurrency.get(cur);
          byCurrency.set(cur, running ? running.plus(amount) : amount);
        }

        const lines = legs.map(
          (l) =>
            `  ${l.account.padEnd(20)} ${Money.fromMinor(l.minorUnits, l.currency.toUpperCase()).toDecimalString().padStart(12)} ${l.currency.toUpperCase()}`,
        );
        const sums = [...byCurrency.entries()].map(([cur, m]) => `  Σ ${cur} = ${m.toDecimalString()}`);
        const balanced = [...byCurrency.values()].every((m) => m.isZero());

        return text(
          [
            balanced ? 'BALANCED ✓ — this is a valid double-entry transaction.' : 'NOT BALANCED ✗ — billing-kit would reject this posting.',
            '',
            'legs:',
            ...lines,
            '',
            'sums:',
            ...sums,
          ].join('\n'),
        );
      } catch (err) {
        return text(`Could not check this: ${(err as Error).message}`);
      }
    },
  );
}
