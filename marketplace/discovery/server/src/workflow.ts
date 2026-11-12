import { validateJavaScript } from "@roster-lock/smart-contract/validator";
import type { Db, SqlValue } from "@roster-lock/smart-contract";
import type {
  ArtifactStore,
  BuildArtifact,
  CommitBuilder,
  DiscoveryCommit,
  DiscoveryNotifier,
  DiscoveryRepo,
  FetchedCommit,
  MatchmakerDataCleaner,
  RepoKind,
  RepoSource,
  RepoSourceFetcher,
  UsageStatus,
} from "./types.js";

export interface DiscoveryWorkflowDeps {
  db: Db;
  fetcher: RepoSourceFetcher;
  builder: CommitBuilder;
  artifacts: ArtifactStore;
  dataCleaner?: MatchmakerDataCleaner;
  notifier?: DiscoveryNotifier;
  now?: () => number;
}

export interface PostRepoInput {
  url: string;
  kind: RepoKind;
  source?: RepoSource;
  externalId?: string;
  createdBy: string;
}

export interface PostRepoResult {
  repo: DiscoveryRepo;
  duplicate: boolean;
}

/** Register a repository. A duplicate returns the existing row and link. */
export async function postRepo(
  deps: DiscoveryWorkflowDeps,
  input: PostRepoInput,
): Promise<PostRepoResult> {
  const url = normalizeRepoUrl(input.url);
  const source = input.source ?? "github";
  const existing =
    (input.externalId
      ? await getRepoByExternal(deps.db, source, input.externalId)
      : undefined) ?? (await getRepoByUrl(deps.db, url));
  if (existing) return { repo: existing, duplicate: true };

  const now = (deps.now ?? Date.now)();
  const id = crypto.randomUUID();
  await deps.db.query(
    `INSERT INTO discovery_repo (id, url, kind, source, external_id, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, url, input.kind, source, input.externalId ?? null, input.createdBy, now],
  );
  const repo = await getRepo(deps.db, id);
  if (!repo) throw new Error("repo insert failed");
  return { repo, duplicate: false };
}

export async function listRepos(
  db: Db,
  filter: { kind?: RepoKind; query?: string; limit?: number; sort?: "new" | "score" } = {},
): Promise<DiscoveryRepo[]> {
  const params: SqlValue[] = [];
  const clauses: string[] = [];
  if (filter.kind) {
    params.push(filter.kind);
    clauses.push(`r.kind = $${params.length}`);
  }
  if (filter.query) {
    params.push(`%${filter.query}%`);
    clauses.push(`r.url ILIKE $${params.length}`);
  }
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 50), 1), 200);
  params.push(limit);
  const order =
    filter.sort === "new"
      ? "r.created_at DESC"
      : "COALESCE(SUM(v.value), 0) DESC, r.created_at DESC";
  const rows = await db.query<{
    id: string;
    url: string;
    kind: RepoKind;
    source: RepoSource;
    external_id: string | null;
    created_by: string;
    created_at: string | number;
    score: string | number | null;
    votes: string | number | null;
  }>(
    `SELECT r.id, r.url, r.kind, r.source, r.external_id, r.created_by, r.created_at,
            COALESCE(SUM(v.value), 0) AS score,
            COUNT(v.user_id) AS votes
     FROM discovery_repo r
     LEFT JOIN discovery_vote v ON v.repo_id = r.id
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     GROUP BY r.id
     ORDER BY ${order}
     LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    url: row.url,
    kind: row.kind,
    source: row.source,
    externalId: row.external_id,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    score: Number(row.score ?? 0),
    votes: Number(row.votes ?? 0),
  }));
}

export async function voteRepo(
  db: Db,
  input: { repoId: string; userId: string; value: -1 | 1 },
  now = Date.now,
): Promise<{ score: number }> {
  await db.query(
    `INSERT INTO discovery_vote (repo_id, user_id, value, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (repo_id, user_id) DO UPDATE SET value = EXCLUDED.value`,
    [input.repoId, input.userId, input.value, now()],
  );
  const row = await db.query<{ score: string | number | null }>(
    `SELECT COALESCE(SUM(value), 0) AS score FROM discovery_vote WHERE repo_id = $1`,
    [input.repoId],
  );
  return { score: Number(row.rows[0]?.score ?? 0) };
}

export interface PrepareResult {
  commit: DiscoveryCommit;
  artifact: BuildArtifact;
}

export interface RecordUsageInput {
  rosterId: string;
  commitId: string;
  billing: "platform" | "roster";
  dataNamespace?: string;
}

export interface DisableCommitInput {
  commitId: string;
  reason?: string;
  clearData?: boolean;
}

export interface DisableCommitResult {
  commit: DiscoveryCommit;
  rosterIds: string[];
}

/** Build (or reuse) the compiled artifact for a commit and store it. */
export async function prepareCommit(
  deps: DiscoveryWorkflowDeps,
  input: { repoUrl: string; commit: string; entry?: string },
): Promise<PrepareResult> {
  return prepareAndStore(deps, input);
}

/** Point a commit at its review record. Review is the approval authority. */
export async function linkReviewedVersion(
  deps: DiscoveryWorkflowDeps,
  commitId: string,
  reviewedVersionId: string,
): Promise<DiscoveryCommit> {
  const now = (deps.now ?? Date.now)();
  const result = await deps.db.query(
    `UPDATE discovery_commit
     SET reviewed_version_id = $2, updated_at = $3
     WHERE id = $1`,
    [commitId, reviewedVersionId, now],
  );
  if ((result.rowCount ?? 0) === 0) throw new Error("commit not found");
  const commit = await getCommit(deps.db, commitId);
  if (!commit) throw new Error("commit row disappeared");
  return commit;
}

/** Record (or refresh) the projection of a roster's adoption. */
export async function recordUsage(
  deps: DiscoveryWorkflowDeps,
  input: RecordUsageInput,
): Promise<void> {
  await deps.db.query(
    `INSERT INTO discovery_usage
       (roster_id, commit_id, status, billing, data_namespace, created_at)
     VALUES ($1, $2, 'active', $3, $4, $5)
     ON CONFLICT (roster_id, commit_id) DO UPDATE SET
       status = EXCLUDED.status,
       billing = EXCLUDED.billing,
       data_namespace = EXCLUDED.data_namespace`,
    [
      input.rosterId,
      input.commitId,
      input.billing,
      input.dataNamespace ?? null,
      (deps.now ?? Date.now)(),
    ],
  );
}

export async function setUsageStatus(
  db: Db,
  commitId: string,
  status: UsageStatus,
): Promise<void> {
  await db.query(`UPDATE discovery_usage SET status = $2 WHERE commit_id = $1`, [
    commitId,
    status,
  ]);
}

/**
 * Operational side of a ban: delete the artifact, optionally clear roster
 * data, mark the usage projection, and notify the rosters. The review record
 * itself is banned by the caller.
 */
export async function disableCommit(
  deps: DiscoveryWorkflowDeps,
  input: DisableCommitInput,
): Promise<DisableCommitResult> {
  const now = (deps.now ?? Date.now)();
  const commit = await getCommit(deps.db, input.commitId);
  if (!commit) throw new Error("commit not found");

  const usages = await deps.db.query<{ roster_id: string; data_namespace: string | null }>(
    `SELECT roster_id, data_namespace FROM discovery_usage WHERE commit_id = $1`,
    [input.commitId],
  );
  if (input.clearData) {
    if (!deps.dataCleaner) throw new Error("data cleaner is not configured");
    const namespaces = new Set(
      usages.rows
        .map((row) => row.data_namespace)
        .filter((value): value is string => Boolean(value)),
    );
    for (const namespace of namespaces) {
      await deps.dataCleaner.clear(namespace);
    }
  }

  await deps.db.query(
    `UPDATE discovery_commit
     SET data_cleared_at = CASE WHEN $2 THEN $3 ELSE data_cleared_at END,
         updated_at = $3
     WHERE id = $1`,
    [input.commitId, input.clearData === true, now],
  );
  await setUsageStatus(deps.db, input.commitId, "banned");
  if (commit.artifactKey) {
    await deps.artifacts.delete?.(commit.artifactKey);
  }

  const rosterIds = usages.rows.map((row) => row.roster_id);
  const current = await getCommit(deps.db, input.commitId);
  await deps.notifier?.commitBanned(current ?? commit, rosterIds);
  return { commit: current ?? commit, rosterIds };
}

async function prepareAndStore(
  deps: DiscoveryWorkflowDeps,
  input: { repoUrl: string; commit: string; entry?: string },
): Promise<PrepareResult> {
  const now = deps.now ?? Date.now;
  const repo = await getRepoByUrl(deps.db, normalizeRepoUrl(input.repoUrl));
  if (!repo) throw new Error("this repository is not registered in discovery");

  const existing = await getCommitBySha(deps.db, repo.id, input.commit);
  if (existing?.buildStatus === "ready" && existing.artifactKey) {
    return {
      commit: existing,
      artifact: {
        entry: existing.entry ?? "",
        code: "",
        sourceHash: existing.sourceHash ?? "",
      },
    };
  }

  const id = existing?.id ?? crypto.randomUUID();
  const timestamp = now();
  await deps.db.query(
    `INSERT INTO discovery_commit
       (id, repo_id, commit_sha, build_status, entry, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', $4, $5, $5)
     ON CONFLICT (repo_id, commit_sha) DO UPDATE
       SET build_status = 'pending', error = NULL, updated_at = EXCLUDED.updated_at`,
    [id, repo.id, input.commit, input.entry ?? null, timestamp],
  );

  try {
    await deps.db.query(
      `UPDATE discovery_commit SET build_status = 'building', updated_at = $2 WHERE id = $1`,
      [id, now()],
    );
    const fetched = await deps.fetcher.fetch(repo.url, input.commit, input.entry);
    const artifact = await deps.builder.build(fetched);
    const validation = validateJavaScript(artifact.code, { mode: "bundle" });
    if (!validation.ok) {
      throw new Error(
        `compiled source failed validation: ${validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.code)
          .join(", ")}`,
      );
    }
    const artifactKey = `discovery/${id}.js`;
    await deps.artifacts.put(artifactKey, artifact.code, "text/javascript");
    await deps.db.query(
      `UPDATE discovery_commit
       SET build_status = 'ready', entry = $2, source_hash = $3,
           artifact_key = $4, error = NULL, updated_at = $5
       WHERE id = $1`,
      [id, artifact.entry, artifact.sourceHash, artifactKey, now()],
    );
    const commit = await getCommit(deps.db, id);
    if (!commit) throw new Error("commit row disappeared");
    return { commit, artifact };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await getCommit(deps.db, id);
    if (current?.artifactKey) {
      await deps.artifacts.delete?.(current.artifactKey);
    }
    await deps.db.query(
      `UPDATE discovery_commit
       SET build_status = 'failed', error = $2, artifact_key = NULL, updated_at = $3
       WHERE id = $1`,
      [id, message, now()],
    );
    throw error;
  }
}

export async function getRepo(db: Db, id: string): Promise<DiscoveryRepo | undefined> {
  const rows = await db.query<{
    id: string;
    url: string;
    kind: RepoKind;
    source: RepoSource;
    external_id: string | null;
    created_by: string;
    created_at: string | number;
  }>(`SELECT * FROM discovery_repo WHERE id = $1`, [id]);
  const row = rows.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    url: row.url,
    kind: row.kind,
    source: row.source,
    externalId: row.external_id,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

export async function getCommit(
  db: Db,
  id: string,
): Promise<DiscoveryCommit | undefined> {
  const rows = await db.query<{
    id: string;
    repo_id: string;
    commit_sha: string;
    build_status: DiscoveryCommit["buildStatus"];
    reviewed_version_id: string | null;
    data_cleared_at: string | number | null;
    entry: string | null;
    source_hash: string | null;
    artifact_key: string | null;
    error: string | null;
    created_at: string | number;
    updated_at: string | number;
    review_status: string | null;
    review_reviewed_by: string | null;
    review_reviewed_at: string | number | null;
    review_reason: string | null;
  }>(
    `SELECT c.*,
            rv.status AS review_status,
            rv.reviewed_by AS review_reviewed_by,
            rv.reviewed_at AS review_reviewed_at,
            rv.reason AS review_reason
     FROM discovery_commit c
     LEFT JOIN reviewed_version rv ON rv.id = c.reviewed_version_id
     WHERE c.id = $1`,
    [id],
  );
  const row = rows.rows[0];
  if (!row) return undefined;
  const approved = row.review_status === "approved";
  const banned = row.review_status === "banned";
  return {
    id: row.id,
    repoId: row.repo_id,
    commit: row.commit_sha,
    buildStatus: row.build_status,
    reviewedVersionId: row.reviewed_version_id,
    approved,
    approvedBy: approved ? row.review_reviewed_by : null,
    approvedAt:
      approved && row.review_reviewed_at !== null
        ? Number(row.review_reviewed_at)
        : null,
    banned,
    bannedBy: banned ? row.review_reviewed_by : null,
    bannedAt:
      banned && row.review_reviewed_at !== null
        ? Number(row.review_reviewed_at)
        : null,
    banReason: banned ? row.review_reason : null,
    dataClearedAt: row.data_cleared_at === null ? null : Number(row.data_cleared_at),
    entry: row.entry,
    sourceHash: row.source_hash,
    artifactKey: row.artifact_key,
    error: row.error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function getRepoByUrl(db: Db, url: string): Promise<DiscoveryRepo | undefined> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM discovery_repo WHERE url = $1`,
    [url],
  );
  const id = rows.rows[0]?.id;
  return id ? getRepo(db, id) : undefined;
}

async function getRepoByExternal(
  db: Db,
  source: RepoSource,
  externalId: string,
): Promise<DiscoveryRepo | undefined> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM discovery_repo WHERE source = $1 AND external_id = $2`,
    [source, externalId],
  );
  const id = rows.rows[0]?.id;
  return id ? getRepo(db, id) : undefined;
}

export async function getCommitBySha(
  db: Db,
  repoId: string,
  sha: string,
): Promise<DiscoveryCommit | undefined> {
  if (!repoId) return undefined;
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM discovery_commit WHERE repo_id = $1 AND commit_sha = $2`,
    [repoId, sha],
  );
  const id = rows.rows[0]?.id;
  return id ? getCommit(db, id) : undefined;
}

export function normalizeRepoUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export async function notifyRepoUpdate(
  deps: DiscoveryWorkflowDeps,
  commit: DiscoveryCommit,
): Promise<void> {
  if (!deps.notifier?.repoUpdated) return;
  const repo = await getRepo(deps.db, commit.repoId);
  if (!repo) return;
  const rows = await deps.db.query<{ roster_id: string }>(
    `SELECT DISTINCT u.roster_id
     FROM discovery_usage u
     JOIN discovery_commit c ON c.id = u.commit_id
     WHERE c.repo_id = $1 AND c.id <> $2`,
    [commit.repoId, commit.id],
  );
  const rosterIds = rows.rows.map((row) => row.roster_id);
  if (rosterIds.length > 0) {
    await deps.notifier.repoUpdated(repo, commit, rosterIds);
  }
}
