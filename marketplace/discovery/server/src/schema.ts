import type { Db } from "@roster-lock/smart-contract";
import { migrateReviewedVersions } from "@roster-lock/reviewed-versions";

export const DISCOVERY_SCHEMA_VERSION = 3;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS discovery_repo (
     id TEXT PRIMARY KEY,
     url TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'github',
     external_id TEXT,
     created_by TEXT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS discovery_repo_external
     ON discovery_repo (source, external_id)
     WHERE external_id IS NOT NULL`,
  // Approval is not stored here: `reviewed_version_id` points at the review
  // record, which is the single source of truth for approved/banned state.
  `CREATE TABLE IF NOT EXISTS discovery_commit (
     id TEXT PRIMARY KEY,
     repo_id TEXT NOT NULL REFERENCES discovery_repo(id) ON DELETE CASCADE,
     commit_sha TEXT NOT NULL,
     build_status TEXT NOT NULL,
     reviewed_version_id TEXT,
     data_cleared_at BIGINT,
     entry TEXT,
     source_hash TEXT,
     artifact_key TEXT,
     error TEXT,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL,
     UNIQUE (repo_id, commit_sha)
   )`,
  `CREATE TABLE IF NOT EXISTS discovery_vote (
     repo_id TEXT NOT NULL REFERENCES discovery_repo(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL,
     value INTEGER NOT NULL CHECK (value IN (-1, 1)),
     created_at BIGINT NOT NULL,
     PRIMARY KEY (repo_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS discovery_usage (
     roster_id TEXT NOT NULL,
     commit_id TEXT NOT NULL REFERENCES discovery_commit(id) ON DELETE CASCADE,
     status TEXT NOT NULL,
     billing TEXT NOT NULL,
     data_namespace TEXT,
     created_at BIGINT NOT NULL,
     PRIMARY KEY (roster_id, commit_id)
   )`,
  `CREATE INDEX IF NOT EXISTS discovery_commit_repo
     ON discovery_commit (repo_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS discovery_repo_kind
     ON discovery_repo (kind)`,
  `CREATE TABLE IF NOT EXISTS discovery_schema_meta (
     id INTEGER PRIMARY KEY,
     version INTEGER NOT NULL
   )`,
  // Upgrade path from schema v2, where approval lived on the commit row.
  `ALTER TABLE discovery_commit DROP COLUMN IF EXISTS approved_by`,
  `ALTER TABLE discovery_commit DROP COLUMN IF EXISTS approved_at`,
  `ALTER TABLE discovery_commit DROP COLUMN IF EXISTS banned_by`,
  `ALTER TABLE discovery_commit DROP COLUMN IF EXISTS banned_at`,
  `ALTER TABLE discovery_commit DROP COLUMN IF EXISTS ban_reason`,
  `ALTER TABLE discovery_commit ADD COLUMN IF NOT EXISTS reviewed_version_id TEXT`,
];

export async function migrateDiscovery(db: Db): Promise<void> {
  // The commit view joins the review table, so make sure it exists first.
  await migrateReviewedVersions(db);
  for (const statement of TABLES) {
    await db.query(statement);
  }
  await db.query(
    `INSERT INTO discovery_schema_meta (id, version) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`,
    [DISCOVERY_SCHEMA_VERSION],
  );
}
