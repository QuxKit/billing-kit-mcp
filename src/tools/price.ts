// Money tools. These call billing-kit's real arithmetic — the whole point is
// that an assistant gets the exact number the library would compute, not a
// plausible-looking one it invented with `qty * rate / 100`.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Money, Quantity, Rate, price } from 'billing-kit';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export function registerPriceTools(server: McpServer): void {
  server.registerTool(
    'price_usage',
    {
      title: 'Price metered usage',
      description:
        'Multiply a quantity by a per-unit rate to an exact Money amount, using billing-kit. ' +
        'The rate is in MINOR units per unit (cents), matching billing-kit. Returns the rounded ' +
        'amount and the exact pre-rounding value, so nothing is silently dropped.',
      inputSchema: {
        quantity: z.string().describe('Exact decimal quantity, e.g. "1234567" tokens or "12.5" GB-hours'),
        rate: z.string().describe('Price per unit in MINOR units (cents), e.g. "0.00012" for 0.00012 cents/token'),
        currency: z.string().length(3).describe('ISO-4217 code, e.g. "USD", "JPY", "KWD"'),
      },
    },
    async ({ quantity, rate, currency }) => {
      try {
        const q = Quantity.fromDecimalString(quantity);
        const r = Rate.fromDecimalString(rate);
        const { amount, exactMinor, residueMinor } = price(q, r, currency.toUpperCase());
        return text(
          [
            `${quantity} × ${rate} (minor units/unit) in ${currency.toUpperCase()}`,
            ``,
            `amount        ${amount.toDecimalString()} ${currency.toUpperCase()}`,
            `exact (minor) ${exactMinor}   ← nothing dropped; rounded once, half-even`,
            `residue       ${residueMinor}   ← what rounding set aside`,
            ``,
            `Computed with billing-kit's Money — no float touched the value.`,
          ].join('\n'),
        );
      } catch (err) {
        return text(`Could not price this: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'format_money',
    {
      title: 'Format a Money amount',
      description:
        'Format an amount (integer minor units) for display, correctly for the currency — ' +
        'no `/100`, which is wrong for JPY (0 minor digits) and KWD (3). Uses billing-kit + Intl.',
      inputSchema: {
        minorUnits: z.string().describe('The amount in integer minor units, e.g. "1999" for $19.99'),
        currency: z.string().length(3),
        locale: z.string().optional().describe('BCP-47 locale, e.g. "de-DE". Omit for the default.'),
        accounting: z.boolean().optional().describe('Render negatives as ($4.00) instead of -$4.00.'),
      },
    },
    async ({ minorUnits, currency, locale, accounting }) => {
      try {
        const money = Money.fromMinor(minorUnits, currency.toUpperCase());
        const fmt = new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: currency.toUpperCase(),
          currencySign: accounting ? 'accounting' : 'standard',
          // @ts-expect-error V3 string path — exact, no double
        }).format(money.toDecimalString());
        return text(`${minorUnits} minor ${currency.toUpperCase()} → ${fmt}`);
      } catch (err) {
        return text(`Could not format this: ${(err as Error).message}`);
      }
    },
  );
}
