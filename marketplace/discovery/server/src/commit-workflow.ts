import { validateJavaScript } from "@roster-lock/smart-contract/validator";
import { getCommit, getRepo, normalizeRepoUrl, type DiscoveryWorkflowDeps } from "./workflow.js";
import type { BuildArtifact, DiscoveryCommit } from "./types.js";

/**
 * A step runner. In a Cloudflare Workflow this is `step.do(name, fn)`;
 * locally/tests it can be an immediate call.
 */
export type WorkflowStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface CommitWorkflowParams {
  repoUrl: string;
  commit: string;
  entry?: string;
}

export interface CommitWorkflowResult {
  commit: DiscoveryCommit;
  artifact: BuildArtifact;
}

/**
 * Durable commit pipeline: reserve → fetch/dearchive → build → validate → R2 →
 * complete. Approval and usage belong to the marketplace app, not this
 * pipeline; a ban during the build is still checked because `getCommit`
 * derives it from the review record.
 */
export async function runCommitWorkflow(
  deps: DiscoveryWorkflowDeps,
  params: CommitWorkflowParams,
  step: WorkflowStepRunner,
): Promise<CommitWorkflowResult> {
  const repo = await step("resolve-repo", async () => {
    const rows = await deps.db.query<{ id: string }>(
      `SELECT id FROM discovery_repo WHERE url = $1`,
      [normalizeRepoUrl(params.repoUrl)],
    );
    const id = rows.rows[0]?.id;
    return id ? await getRepo(deps.db, id) : undefined;
  });
  if (!repo) throw new Error("this repository is not registered in discovery");

  const reservation = await step("reserve-commit", async () => {
    const rows = await deps.db.query<{ id: string }>(
      `SELECT id FROM discovery_commit WHERE repo_id = $1 AND commit_sha = $2`,
      [repo.id, params.commit],
    );
    const existingId = rows.rows[0]?.id;
    const existing = existingId ? await getCommit(deps.db, existingId) : undefined;
    if (existing?.banned) throw new Error("this commit is banned");
    if (existing?.buildStatus === "ready" && existing.artifactKey) {
      return { id: existing.id, skip: true };
    }
    const id = existing?.id ?? crypto.randomUUID();
    const now = (deps.now ?? Date.now)();
    await deps.db.query(
      `INSERT INTO discovery_commit
         (id, repo_id, commit_sha, build_status, entry, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $5)
       ON CONFLICT (repo_id, commit_sha) DO UPDATE
         SET build_status = 'pending', error = NULL, updated_at = EXCLUDED.updated_at`,
      [id, repo.id, params.commit, params.entry ?? null, now],
    );
    await deps.db.query(
      `UPDATE discovery_commit SET build_status = 'building', updated_at = $2 WHERE id = $1`,
      [id, now],
    );
    return { id, skip: false };
  });

  if (reservation.skip) {
    const commit = await getCommit(deps.db, reservation.id);
    if (!commit) throw new Error("commit row disappeared");
    return {
      commit,
      artifact: {
        entry: commit.entry ?? "",
        code: "",
        sourceHash: commit.sourceHash ?? "",
      },
    };
  }

  try {
    const fetched = await step("fetch-dearchive", () =>
      deps.fetcher.fetch(repo.url, params.commit, params.entry),
    );
    const artifact = await step("build-rollup", () => deps.builder.build(fetched));
    await step("validate", async () => {
      const validation = validateJavaScript(artifact.code, { mode: "bundle" });
      if (!validation.ok) {
        throw new Error(
          `compiled source failed validation: ${validation.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => issue.code)
            .join(", ")}`,
        );
      }
      return true;
    });

    const artifactKey = await step("upload-r2", async () => {
      const key = `discovery/${reservation.id}.js`;
      const current = await getCommit(deps.db, reservation.id);
      if (current?.banned) throw new Error("this commit was banned during the build");
      await deps.artifacts.put(key, artifact.code, "text/javascript");
      return key;
    });

    const commit = await step("complete", async () => {
      const current = await getCommit(deps.db, reservation.id);
      if (!current) throw new Error("commit row disappeared");
      if (current.banned) throw new Error("this commit was banned during the build");
      const now = (deps.now ?? Date.now)();
      await deps.db.query(
        `UPDATE discovery_commit
         SET build_status = 'ready', entry = $2, source_hash = $3,
             artifact_key = $4, error = NULL, updated_at = $5
         WHERE id = $1`,
        [reservation.id, artifact.entry, artifact.sourceHash, artifactKey, now],
      );
      const updated = await getCommit(deps.db, reservation.id);
      if (!updated) throw new Error("commit row disappeared");
      return updated;
    });

    return { commit, artifact };
  } catch (error) {
    const current = await getCommit(deps.db, reservation.id);
    if (current?.artifactKey) {
      await deps.artifacts.delete?.(current.artifactKey);
    }
    await deps.db.query(
      `UPDATE discovery_commit
       SET build_status = 'failed', error = $2, artifact_key = NULL, updated_at = $3
       WHERE id = $1`,
      [
        reservation.id,
        error instanceof Error ? error.message : String(error),
        (deps.now ?? Date.now)(),
      ],
    );
    throw error;
  }
}
