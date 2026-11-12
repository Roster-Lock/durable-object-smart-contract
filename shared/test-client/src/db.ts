import { PGlite } from "@electric-sql/pglite";
import type { Db, OpenDb, QueryResult, SqlValue } from "@roster-lock/smart-contract";
import { migrate } from "@roster-lock/smart-contract";

/**
 * An in-process Postgres for tests: PGlite is Postgres compiled to WASM, so
 * the tests run the real `BEGIN`/`COMMIT`, `ON CONFLICT`, advisory locks and
 * `DOUBLE PRECISION` positions, not a hand-written fake.
 *
 * One PGlite instance has one connection. Tests are sequential and the Durable
 * Object serialises requests, so nothing here needs a second connection -
 * which is also why true cross-connection contention is not exercised.
 */
export class TestDatabase implements Db {
  private constructor(private readonly pg: PGlite) {}

  static async create(): Promise<TestDatabase> {
    const pg = new PGlite();
    const db = new TestDatabase(pg);
    await migrate(db);
    return db;
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly SqlValue[],
  ): Promise<QueryResult<T>> {
    const result = await this.pg.query(
      text,
      params ? [...params] : undefined,
    );
    return {
      rows: result.rows as T[],
      rowCount: result.affectedRows ?? 0,
    };
  }

  /** Empty every contract table, keeping the schema. */
  async reset(): Promise<void> {
    await this.pg.exec(
      `TRUNCATE dsc_contract, dsc_wallet, dsc_gas_escrow, dsc_call_log,
                dsc_state_value, dsc_state_map, dsc_state_array, dsc_state_size,
                dsc_event`,
    );
  }

  /** Hands the shared database to a service; closing is a no-op. */
  readonly open: OpenDb = async () => ({ db: this, close: async () => {} });

  async close(): Promise<void> {
    await this.pg.close();
  }
}

// One database per test file (vitest isolates modules per file), reset on
// every freshTestDatabase() so each test starts clean.
let shared: Promise<TestDatabase> | null = null;

function sharedTestDatabase(): Promise<TestDatabase> {
  shared ??= TestDatabase.create();
  return shared;
}

export async function freshTestDatabase(): Promise<TestDatabase> {
  const db = await sharedTestDatabase();
  await db.reset();
  return db;
}
