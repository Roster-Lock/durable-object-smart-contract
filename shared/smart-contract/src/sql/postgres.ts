import { Client } from "pg";
import type { Db, DbConnection, SqlValue } from "./driver.js";

/**
 * One `pg` client for the duration of a single contract call.
 *
 * Cloudflare's Hyperdrive pools the underlying connections, so opening a
 * client per call is the documented pattern (the same one the website's
 * services use). The client is also the transaction: every query on it is part
 * of the same session, which is what lets a call hold a transaction open while
 * the guest awaits.
 */
export async function openPostgres(connectionString: string): Promise<DbConnection> {
  if (!connectionString) {
    throw new Error("Postgres connection string is required");
  }
  const client = new Client({ connectionString });
  await client.connect();

  const db: Db = {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: readonly SqlValue[],
    ) {
      const result = await client.query(text, params ? [...params] : undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
  };

  return {
    db,
    async close() {
      await client.end();
    },
  };
}
