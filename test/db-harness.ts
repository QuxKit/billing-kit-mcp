// The Postgres harness for the DB-backed tool tests.
//
// It rebuilds billing-kit's schema from the SQL files billing-kit ships
// (`@quxkit/billing-kit/sql/*.sql`, applied in file order) into the local
// `billing_kit_test` database, hands back a WRITABLE executor for seeding via
// billing-kit's own API, and a READ-ONLY one opened exactly the way the bin
// opens it (`openDatabase`), so the tests prove both that the tools read what
// billing-kit wrote and that the connection they read through cannot write.
//
// Skip/require follows the family convention: without a reachable database the
// suite skips with a reason; with REQUIRE_DB=1 (CI) an unreachable database is
// a hard failure, so a misconfigured service cannot produce a green run that
// exercised none of the SQL.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlExecutor } from '@quxkit/billing-kit';
import { pgExecutor } from '@quxkit/billing-kit/pg';
import pg from 'pg';
import { openDatabase } from '../src/db.ts';

export const TEST_DATABASE_URL =
  process.env.BILLING_KIT_TEST_DATABASE_URL ?? 'postgres://localhost:5432/billing_kit_test';

export const SKIP_REASON =
  `no database at ${TEST_DATABASE_URL} — set BILLING_KIT_TEST_DATABASE_URL or ` +
  'run `createdb billing_kit_test` to exercise the DB-backed tools';

export const REQUIRE_DB = process.env.REQUIRE_DB !== undefined && process.env.REQUIRE_DB !== '';

/** Where billing-kit's shipped SQL lives, resolved through its package exports. */
export function billingKitSqlDir(): string {
  const pkg = fileURLToPath(import.meta.resolve('@quxkit/billing-kit/package.json'));
  return join(dirname(pkg), 'sql');
}

export interface DbHarness {
  /** Writable, for seeding through billing-kit's API. */
  seed: SqlExecutor;
  /** Read-only, opened as the bin opens it. What the server under test reads through. */
  db: SqlExecutor;
  close(): Promise<void>;
}

/**
 * Connect, drop and rebuild `billing.*` from billing-kit's SQL, and return
 * both executors. Null (or a throw under REQUIRE_DB) when unreachable.
 */
export async function setupDatabase(): Promise<DbHarness | null> {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  try {
    await admin.query('SELECT 1');
  } catch (error) {
    await admin.end().catch(() => undefined);
    if (REQUIRE_DB) {
      throw new Error(`REQUIRE_DB is set and the test database is unreachable: ${SKIP_REASON}`, { cause: error });
    }
    return null;
  }

  const dir = billingKitSqlDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  await admin.query('DROP SCHEMA IF EXISTS billing CASCADE');
  for (const f of files) {
    await admin.query(await readFile(join(dir, f), 'utf8'));
  }
  await admin.query('SELECT billing.ensure_core_partitions(2, $1)', [new Date()]);
  await admin.query('SELECT billing.ensure_partitions()');

  const ro = openDatabase(TEST_DATABASE_URL, { max: 2 });
  return {
    seed: pgExecutor(admin),
    db: ro.db,
    close: async () => {
      await ro.close();
      await admin.end();
    },
  };
}
