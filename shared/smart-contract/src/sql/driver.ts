/**
 * The Postgres surface the contract engine needs.
 *
 * This is deliberately the same shape as `@roster-lock/website-db`'s `Db`:
 * one connection, parameterised queries, a `rowCount` that tells a guarded
 * UPDATE whether it matched. Production backs it with `pg` over Hyperdrive;
 * tests back it with PGlite (Postgres compiled to WASM).
 *
 * `transaction` is a real `BEGIN`/`COMMIT` held across awaits. With Postgres
 * that is possible for the whole guest execution, which is what replaces the
 * old synchronous SQLite transaction.
 */

export type SqlValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | readonly SqlValue[];

export interface QueryResult<T> {
  rows: T[];
  /** Rows inserted/updated/deleted. Always 0 for a plain SELECT. */
  rowCount: number;
}

export interface Db {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly SqlValue[],
  ): Promise<QueryResult<T>>;
}

export interface DbConnection {
  db: Db;
  close(): Promise<void>;
}

/** Opens one connection. In tests this returns the shared PGlite instance. */
export type OpenDb = () => Promise<DbConnection>;

export class SqlError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SqlError";
  }
}

/**
 * Run `fn` in a transaction that is always rolled back.
 *
 * Used for the deploy-time dry run: the sandbox already refuses writes, and
 * this makes that guarantee structural rather than a property of one guard.
 */
export async function readOnlyTransaction<T>(
  db: Db,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    return await fn(db);
  } finally {
    try {
      await db.query("ROLLBACK");
    } catch {
      // The connection may already be gone.
    }
  }
}

/**
 * Run `fn` in a transaction on one connection.
 *
 * Everything `fn` does on `db` is inside it - including, for a contract call,
 * the entire QuickJS execution. Throwing rolls the whole thing back. Never run
 * another query on the same `Db` concurrently while this is open.
 */
export async function transaction<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // The connection may already be gone; the original error is more useful.
    }
    throw error;
  }
}
