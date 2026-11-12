import type { Db } from "./driver.js";
import { transaction } from "./driver.js";

/**
 * The smart-contract tables inside the website's Postgres database.
 *
 * Everything is namespaced by `contract_id` because one database holds every
 * contract (and the wallet, which is shared across them). The `dsc_` prefix
 * keeps these out of the way of the website's own tables.
 *
 * State is a tree:
 *
 *   - `dsc_state_value` holds one value per declared value collection.
 *   - `dsc_state_map` holds map entries. `path` is the encoded ancestry of
 *     nested nodes; a `NULL` value marks a key whose value is a child node
 *     (a nested map or array).
 *   - `dsc_state_array` holds array items. `item_id` is a stable identity, not
 *     a position: a nested array or map is addressed by its parent item's id,
 *     so moving or inserting items never makes a child handle point at the
 *     wrong subtree.
 *   - `dsc_state_size` caches each node's entry count, so `length()`/`size()`
 *     are O(1) and `maxItems` can be enforced atomically.
 */

export const SCHEMA_VERSION = 4;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS dsc_contract (
     contract_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     name TEXT NOT NULL,
     version TEXT NOT NULL,
     roster_id TEXT,
     init_args TEXT,
     source TEXT NOT NULL,
     source_hash TEXT NOT NULL,
     manifest TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS dsc_wallet (
     user_id TEXT PRIMARY KEY,
     balance BIGINT NOT NULL CHECK (balance >= 0)
   )`,
  `CREATE TABLE IF NOT EXISTS dsc_gas_escrow (
     id TEXT PRIMARY KEY,
     contract_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     amount BIGINT NOT NULL CHECK (amount >= 0),
     created_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS dsc_gas_escrow_expires
     ON dsc_gas_escrow (contract_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS dsc_call_log (
     id TEXT PRIMARY KEY,
     contract_id TEXT NOT NULL,
     caller_id TEXT NOT NULL,
     endpoint TEXT NOT NULL,
     status TEXT NOT NULL,
     gas_used BIGINT NOT NULL,
     gas_charged BIGINT NOT NULL,
     error TEXT,
     created_at BIGINT NOT NULL,
     delegate TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS dsc_call_log_recent
     ON dsc_call_log (contract_id, created_at DESC)`,
  `ALTER TABLE dsc_call_log ADD COLUMN IF NOT EXISTS delegate TEXT`,
  `ALTER TABLE dsc_contract ADD COLUMN IF NOT EXISTS roster_id TEXT`,
  `ALTER TABLE dsc_contract ADD COLUMN IF NOT EXISTS init_args TEXT`,
  `ALTER TABLE dsc_contract ADD COLUMN IF NOT EXISTS handle TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dsc_contract_handle
     ON dsc_contract (roster_id, handle)
     WHERE roster_id IS NOT NULL AND handle IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS dsc_contract_roster ON dsc_contract (roster_id)`,
  `CREATE TABLE IF NOT EXISTS dsc_match_history (
     id TEXT PRIMARY KEY,
     roster_id TEXT NOT NULL,
     deployment_id TEXT,
     finished_at BIGINT NOT NULL,
     participants TEXT[] NOT NULL DEFAULT '{}',
     result TEXT NOT NULL
   )`,
  `ALTER TABLE dsc_match_history ADD COLUMN IF NOT EXISTS participants TEXT[] NOT NULL DEFAULT '{}'`,
  `CREATE INDEX IF NOT EXISTS dsc_match_history_roster
     ON dsc_match_history (roster_id, finished_at DESC)`,
  `CREATE INDEX IF NOT EXISTS dsc_match_history_participants
     ON dsc_match_history USING GIN (participants)`,
  `CREATE TABLE IF NOT EXISTS dsc_event (
     id BIGSERIAL PRIMARY KEY,
     contract_id TEXT NOT NULL,
     name TEXT NOT NULL,
     payload TEXT NOT NULL,
     caller_id TEXT NOT NULL,
     call_id TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     delegate TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS dsc_event_contract
     ON dsc_event (contract_id, id)`,
  `ALTER TABLE dsc_event ADD COLUMN IF NOT EXISTS delegate TEXT`,
  `CREATE TABLE IF NOT EXISTS dsc_state_value (
     contract_id TEXT NOT NULL,
     collection TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (contract_id, collection)
   )`,
  `CREATE TABLE IF NOT EXISTS dsc_state_map (
     contract_id TEXT NOT NULL,
     collection TEXT NOT NULL,
     path TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (contract_id, collection, path, key)
   )`,
  `CREATE INDEX IF NOT EXISTS dsc_state_map_path
     ON dsc_state_map (contract_id, collection, path)`,
  `CREATE TABLE IF NOT EXISTS dsc_state_array (
     contract_id TEXT NOT NULL,
     collection TEXT NOT NULL,
     path TEXT NOT NULL,
     item_id BIGSERIAL NOT NULL,
     position DOUBLE PRECISION NOT NULL,
     value TEXT,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (contract_id, collection, path, position),
     UNIQUE (item_id)
   )`,
  `CREATE INDEX IF NOT EXISTS dsc_state_array_path
     ON dsc_state_array (contract_id, collection, path)`,
  `CREATE TABLE IF NOT EXISTS dsc_state_size (
     contract_id TEXT NOT NULL,
     collection TEXT NOT NULL,
     path TEXT NOT NULL,
     item_count BIGINT NOT NULL CHECK (item_count >= 0),
     PRIMARY KEY (contract_id, collection, path)
   )`,
] as const;

export async function migrate(db: Db): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(
      `CREATE TABLE IF NOT EXISTS dsc_schema_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         version INTEGER NOT NULL
       )`,
    );

    const meta = await tx.query<{ version: number }>(
      `SELECT version FROM dsc_schema_meta WHERE id = 1`,
    );
    const version = Number(meta.rows[0]?.version ?? 0);
    const legacy = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'dsc_contract'
       ) AS exists`,
    );
    const hasLegacyTables = legacy.rows[0]?.exists === true;

    if (version < 2 && (version > 0 || hasLegacyTables)) {
      // Upgrading from the pre-storage-declaration layout. There is no
      // meaningful mapping between the old flat rows and the new tree, so the
      // contract state is dropped. Outstanding gas is refunded first.
      await tx.query(
        `UPDATE dsc_wallet AS w
         SET balance = w.balance + e.amount
         FROM dsc_gas_escrow AS e
         WHERE e.user_id = w.user_id`,
      );
      await tx.query(`DELETE FROM dsc_gas_escrow`);
      await tx.query(
        `DROP TABLE IF EXISTS dsc_state_value, dsc_state_map, dsc_state_array,
           dsc_state_size, dsc_call_log, dsc_event, dsc_contract`,
      );
    }

    for (const statement of TABLES) {
      await tx.query(statement);
    }

    await tx.query(
      `INSERT INTO dsc_schema_meta (id, version) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`,
      [SCHEMA_VERSION],
    );
  });
}
