import type { Db } from "@roster-lock/smart-contract";

export const CLIENT_BUILD_SCHEMA_VERSION = 1;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_build (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     source_ref TEXT,
     commit_sha TEXT,
     name TEXT NOT NULL,
     version TEXT NOT NULL,
     entry TEXT NOT NULL,
     framework TEXT NOT NULL,
     source_hash TEXT,
     lockfile_hash TEXT,
     manifest_hash TEXT,
     bundle_hash TEXT,
     archive_bytes BIGINT NOT NULL DEFAULT 0,
     unpacked_bytes BIGINT NOT NULL DEFAULT 0,
     pre_optimization_bytes BIGINT NOT NULL DEFAULT 0,
     bundle_bytes BIGINT NOT NULL DEFAULT 0,
     asset_bytes BIGINT NOT NULL DEFAULT 0,
     source_key TEXT,
     lockfile_key TEXT,
     manifest_key TEXT,
     bundle_key TEXT,
     keys_json TEXT NOT NULL DEFAULT '{}',
     urls_json TEXT NOT NULL DEFAULT '{}',
     assets_json TEXT NOT NULL DEFAULT '[]',
     packages_json TEXT NOT NULL DEFAULT '[]',
     diagnostics_json TEXT NOT NULL DEFAULT '[]',
     warnings_json TEXT NOT NULL DEFAULT '[]',
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL,
     ready_at BIGINT,
     banned_at BIGINT,
     banned_by TEXT,
     ban_reason TEXT,
     deleted_at BIGINT
   )`,
  `ALTER TABLE client_build ADD COLUMN IF NOT EXISTS assets_json TEXT NOT NULL DEFAULT '[]'`,
  `CREATE INDEX IF NOT EXISTS client_build_status ON client_build (status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS client_build_source ON client_build (source_ref)`,
  `CREATE TABLE IF NOT EXISTS client_build_asset (
     build_id TEXT NOT NULL REFERENCES client_build(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     key TEXT NOT NULL,
     hash TEXT NOT NULL,
     bytes BIGINT NOT NULL,
     content_type TEXT NOT NULL,
     PRIMARY KEY (build_id, path)
   )`,
  `CREATE TABLE IF NOT EXISTS client_build_package (
     build_id TEXT NOT NULL REFERENCES client_build(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     version TEXT NOT NULL,
     integrity TEXT,
     tarball_hash TEXT,
     dependencies_json TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (build_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS client_build_usage (
     roster_id TEXT NOT NULL,
     build_id TEXT NOT NULL REFERENCES client_build(id) ON DELETE CASCADE,
     status TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     revoked_at BIGINT,
     PRIMARY KEY (roster_id, build_id)
   )`,
  `CREATE INDEX IF NOT EXISTS client_build_usage_build ON client_build_usage (build_id)`,
  `CREATE TABLE IF NOT EXISTS client_build_pin (
     roster_id TEXT PRIMARY KEY,
     build_id TEXT NOT NULL REFERENCES client_build(id) ON DELETE CASCADE,
     source_ref TEXT,
     commit_sha TEXT,
     pinned_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS client_build_schema_meta (
     id INTEGER PRIMARY KEY,
     version INTEGER NOT NULL
   )`,
];

export async function migrateClientBuilds(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.query(statement);
  }
  await db.query(
    `INSERT INTO client_build_schema_meta (id, version) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`,
    [CLIENT_BUILD_SCHEMA_VERSION],
  );
}

export const CLIENT_BUILD_SCHEMA = STATEMENTS;
