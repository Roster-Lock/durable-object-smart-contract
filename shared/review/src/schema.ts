import type { Db } from "@roster-lock/smart-contract";

export const REVIEWED_VERSIONS_SCHEMA_VERSION = 1;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS reviewed_version (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     source_hash TEXT NOT NULL,
     status TEXT NOT NULL,
     version TEXT,
     repo_url TEXT,
     commit_sha TEXT,
     entry TEXT,
     artifact_key TEXT,
     submitted_by TEXT,
     reviewed_by TEXT,
     reviewed_at BIGINT,
     reason TEXT,
     metadata_json TEXT NOT NULL DEFAULT '{}',
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL,
     UNIQUE (kind, source_hash)
   )`,
  `CREATE INDEX IF NOT EXISTS reviewed_version_status
     ON reviewed_version (status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS reviewed_version_kind
     ON reviewed_version (kind, status)`,
  `CREATE TABLE IF NOT EXISTS reviewed_version_schema_meta (
     id INTEGER PRIMARY KEY,
     version INTEGER NOT NULL
   )`,
];

export async function migrateReviewedVersions(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.query(statement);
  }
  await db.query(
    `INSERT INTO reviewed_version_schema_meta (id, version) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`,
    [REVIEWED_VERSIONS_SCHEMA_VERSION],
  );
}

export const REVIEWED_VERSIONS_SCHEMA = STATEMENTS;
