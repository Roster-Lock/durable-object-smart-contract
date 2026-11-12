import type { Db, SqlValue } from "@roster-lock/smart-contract";
import type { ReviewListFilter, ReviewedKind, ReviewedVersion, ReviewStatus } from "./types.js";
import { migrateReviewedVersions } from "./schema.js";

export interface ReviewedVersionRepository {
  save(version: ReviewedVersion): Promise<void>;
  get(id: string): Promise<ReviewedVersion | undefined>;
  findBySource(kind: ReviewedKind, sourceHash: string): Promise<ReviewedVersion | undefined>;
  list(filter?: ReviewListFilter): Promise<ReviewedVersion[]>;
  delete?(id: string): Promise<void>;
}

export class MemoryReviewedVersionRepository implements ReviewedVersionRepository {
  private readonly versions = new Map<string, ReviewedVersion>();

  async save(version: ReviewedVersion): Promise<void> {
    this.versions.set(version.id, structuredClone(version));
  }

  async get(id: string): Promise<ReviewedVersion | undefined> {
    const version = this.versions.get(id);
    return version ? structuredClone(version) : undefined;
  }

  async findBySource(kind: ReviewedKind, sourceHash: string): Promise<ReviewedVersion | undefined> {
    for (const version of this.versions.values()) {
      if (version.kind === kind && version.sourceHash === sourceHash) {
        return structuredClone(version);
      }
    }
    return undefined;
  }

  async list(filter: ReviewListFilter = {}): Promise<ReviewedVersion[]> {
    return [...this.versions.values()]
      .filter((version) => !filter.kind || version.kind === filter.kind)
      .filter((version) => !filter.status || version.status === filter.status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 500))
      .map((version) => structuredClone(version));
  }

  async delete(id: string): Promise<void> {
    this.versions.delete(id);
  }
}

interface ReviewRow {
  id: string;
  kind: ReviewedKind;
  source_hash: string;
  status: ReviewStatus;
  version: string | null;
  repo_url: string | null;
  commit_sha: string | null;
  entry: string | null;
  artifact_key: string | null;
  submitted_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | number | null;
  reason: string | null;
  metadata_json: string;
  created_at: string | number;
  updated_at: string | number;
}

export class PostgresReviewedVersionRepository implements ReviewedVersionRepository {
  constructor(private readonly db: Db) {}

  async migrate(): Promise<void> {
    await migrateReviewedVersions(this.db);
  }

  async save(version: ReviewedVersion): Promise<void> {
    await this.db.query(
      `INSERT INTO reviewed_version (
         id, kind, source_hash, status, version, repo_url, commit_sha, entry,
         artifact_key, submitted_by, reviewed_by, reviewed_at, reason,
         metadata_json, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         repo_url = EXCLUDED.repo_url,
         commit_sha = EXCLUDED.commit_sha,
         entry = EXCLUDED.entry,
         artifact_key = EXCLUDED.artifact_key,
         submitted_by = EXCLUDED.submitted_by,
         reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = EXCLUDED.reviewed_at,
         reason = EXCLUDED.reason,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
      [
        version.id,
        version.kind,
        version.sourceHash,
        version.status,
        version.version ?? null,
        version.repoUrl ?? null,
        version.commit ?? null,
        version.entry ?? null,
        version.artifactKey ?? null,
        version.submittedBy ?? null,
        version.reviewedBy ?? null,
        version.reviewedAt ?? null,
        version.reason ?? null,
        JSON.stringify(version.metadata ?? {}),
        version.createdAt,
        version.updatedAt,
      ],
    );
  }

  async get(id: string): Promise<ReviewedVersion | undefined> {
    const result = await this.db.query<ReviewRow>(`SELECT * FROM reviewed_version WHERE id = $1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async findBySource(kind: ReviewedKind, sourceHash: string): Promise<ReviewedVersion | undefined> {
    const result = await this.db.query<ReviewRow>(
      `SELECT * FROM reviewed_version WHERE kind = $1 AND source_hash = $2`,
      [kind, sourceHash],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async list(filter: ReviewListFilter = {}): Promise<ReviewedVersion[]> {
    const params: SqlValue[] = [];
    const clauses: string[] = [];
    if (filter.kind) {
      params.push(filter.kind);
      clauses.push(`kind = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    params.push(Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 500));
    const result = await this.db.query<ReviewRow>(
      `SELECT * FROM reviewed_version
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapRow);
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM reviewed_version WHERE id = $1`, [id]);
  }
}

function mapRow(row: ReviewRow): ReviewedVersion {
  return {
    id: row.id,
    kind: row.kind,
    sourceHash: row.source_hash,
    status: row.status,
    ...(row.version ? { version: row.version } : {}),
    ...(row.repo_url ? { repoUrl: row.repo_url } : {}),
    ...(row.commit_sha ? { commit: row.commit_sha } : {}),
    ...(row.entry ? { entry: row.entry } : {}),
    ...(row.artifact_key ? { artifactKey: row.artifact_key } : {}),
    ...(row.submitted_by ? { submittedBy: row.submitted_by } : {}),
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at === null ? {} : { reviewedAt: Number(row.reviewed_at) }),
    ...(row.reason ? { reason: row.reason } : {}),
    metadata: JSON.parse(row.metadata_json || "{}") as Record<string, unknown>,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
