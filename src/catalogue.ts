// The plan catalogue: the operator's plans, loaded from a file named by
// BILLING_KIT_MCP_PLANS and served as the `billing://plans` resource.
//
// billing-kit deliberately does not persist plans — the catalogue is the
// application's, held in code. That is the right call for the library and a
// gap for an assistant: it can read a subscription's `planId` from the
// database but nothing tells it what "team" costs. This file closes the gap
// with a plain, declarative shape — a JSON file, or a JS/TS module whose default
// export (or `plans` export) is that same shape — hydrated into real billing-kit
// `Plan`s through `definePlan`, so an invalid catalogue is refused at load with
// billing-kit's own `invalid_plan` / `currency_mismatch` reason rather than
// mis-pricing later.
//
// Money is a decimal string in the plan's currency ("49.00"), quantities and
// rates are decimal strings too — the same conventions as billing-kit's own
// `fromDecimalString` constructors, so nothing here is a float.

import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Money, Quantity, Rate } from '@quxkit/billing-kit';
import { definePlan, type Plan } from '@quxkit/billing-kit/subscriptions';
import { z } from 'zod';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'a decimal string, e.g. "49.00"');

const tierEntry = z.object({
  /** Upper bound of the tier (exclusive of the next), or null for the last, unbounded tier. */
  upTo: decimal.nullable(),
  rate: decimal,
  flat: decimal.optional(),
});

const priceEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flat'), rate: decimal }),
  z.object({ kind: z.literal('tiered'), mode: z.enum(['volume', 'graduated']), tiers: z.array(tierEntry).min(1) }),
]);

export const planEntrySchema = z.object({
  id: z.string().min(1),
  currency: z.string().length(3),
  interval: z.enum(['day', 'week', 'month', 'year']),
  /** Recurring base fee, decimal string in `currency`. "0" for pay-as-you-go. */
  flat: decimal,
  seats: z.object({ unit: decimal, min: z.number().int().min(0).optional() }).optional(),
  usage: z
    .array(
      z.object({
        metric: z.string().min(1),
        included: decimal.optional(),
        price: priceEntry,
      }),
    )
    .default([]),
  trialDays: z.number().int().min(0).optional(),
  /** Free-form; served in the resource, ignored by pricing. */
  name: z.string().optional(),
  description: z.string().optional(),
});

export type PlanEntry = z.infer<typeof planEntrySchema>;

/** A file is either an array of entries or `{ plans: [...] }`. */
export const catalogueSchema = z.array(planEntrySchema);

export interface PlanCatalogue {
  /** Where it came from — for the resource description and error messages. */
  path: string;
  /** The declarative entries as loaded (validated), served as `billing://plans`. */
  entries: PlanEntry[];
  /** billing-kit `Plan`s, validated by `definePlan`, keyed by id. */
  plans: Map<string, Plan>;
}

/** Turn one declarative entry into a billing-kit `Plan` (throws on an invalid one). */
export function hydratePlan(entry: PlanEntry): Plan {
  const cur = entry.currency.toUpperCase();
  const money = (v: string) => Money.fromDecimalString(v, cur);
  return definePlan({
    id: entry.id,
    currency: cur,
    interval: entry.interval,
    flat: money(entry.flat),
    seats: entry.seats ? { unit: money(entry.seats.unit), min: entry.seats.min } : undefined,
    usage: entry.usage.map((u) => ({
      metric: u.metric,
      included: u.included !== undefined ? Quantity.fromDecimalString(u.included) : undefined,
      price:
        u.price.kind === 'flat'
          ? { kind: 'flat', rate: Rate.fromDecimalString(u.price.rate) }
          : {
              kind: 'tiered',
              mode: u.price.mode,
              tiers: u.price.tiers.map((t) => ({
                upTo: t.upTo === null ? null : Quantity.fromDecimalString(t.upTo),
                rate: Rate.fromDecimalString(t.rate),
                flat: t.flat !== undefined ? money(t.flat) : undefined,
              })),
            },
    })),
    trialDays: entry.trialDays,
  });
}

/** Validate an already-parsed catalogue value (from JSON or a module) into a catalogue. */
export function parseCatalogue(value: unknown, path: string): PlanCatalogue {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { plans?: unknown }).plans)
      ? (value as { plans: unknown[] }).plans
      : null;
  if (list === null) throw new Error(`plan catalogue ${path}: expected an array of plans or { plans: [...] }`);
  const parsed = catalogueSchema.safeParse(list);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`plan catalogue ${path}: ${first ? `${first.path.join('.')} ${first.message}` : 'invalid'}`);
  }
  const plans = new Map<string, Plan>();
  for (const entry of parsed.data) {
    if (plans.has(entry.id)) throw new Error(`plan catalogue ${path}: plan id "${entry.id}" appears twice`);
    plans.set(entry.id, hydratePlan(entry));
  }
  return { path, entries: parsed.data, plans };
}

/**
 * Load a catalogue file. `.json` is parsed; anything else (`.js`, `.mjs`,
 * `.ts` on a Node that strips types) is imported and its default export — or a
 * `plans` export — is taken.
 */
export async function loadPlanCatalogue(path: string): Promise<PlanCatalogue> {
  const abs = resolve(path);
  if (extname(abs) === '.json') {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(abs, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new Error(`plan catalogue ${abs}: not valid JSON — ${(err as Error).message}`);
    }
    return parseCatalogue(value, abs);
  }
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown; plans?: unknown };
  return parseCatalogue(mod.default ?? mod.plans, abs);
}
