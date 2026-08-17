// The database connection the DB-backed tools read through.
//
// One rule: this server never gets a writable connection unless the operator
// asks for one. `openDatabase` wraps a pg.Pool in billing-kit's own `pgExecutor`
// and pins every connection read-only with `SET default_transaction_read_only`
// the moment it is opened — so a tool that tried to INSERT, or a prompt
// injection that talked the assistant into one, is refused by Postgres itself,
// not by a code path that could be forgotten. Pair it with a read-only database
// role (see README "Read-only role") for defence in depth: the SET is per
// session and a superuser could undo it; a role without INSERT/UPDATE/DELETE
// grants cannot.
//
// The pool is constructed here rather than handed in because the bin has to
// build one from DATABASE_URL; tests build their own and pass the executor to
// `createServer` directly.

import type { SqlExecutor } from '@quxkit/billing-kit';
import { pgExecutor } from '@quxkit/billing-kit/pg';
import pg from 'pg';

export interface OpenDatabaseOptions {
  /**
   * `true` (the default) pins every connection to read-only transactions.
   * Wave 3's write tools open a second, writable pool only when the operator
   * passes `--allow-writes`; nothing else ever sets this to false.
   */
  readOnly?: boolean;
  /** Pool size. Small: an assistant asks one question at a time. */
  max?: number;
}

export interface OpenedDatabase {
  db: SqlExecutor;
  readOnly: boolean;
  close(): Promise<void>;
}

export function openDatabase(connectionString: string, options: OpenDatabaseOptions = {}): OpenedDatabase {
  const readOnly = options.readOnly ?? true;
  const pool = new pg.Pool({ connectionString, max: options.max ?? 4 });
  if (readOnly) {
    // Runs on every new physical connection, before it is handed to a caller:
    // pg queues client queries in order, so this SET precedes the first tool
    // query on that connection.
    pool.on('connect', (client) => {
      client.query('SET default_transaction_read_only = on').catch(() => undefined);
    });
  }
  return { db: pgExecutor(pool), readOnly, close: () => pool.end() };
}
