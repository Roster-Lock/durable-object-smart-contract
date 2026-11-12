import { beforeEach, describe, expect, it } from "vitest";
import {
  disableCommit,
  getCommit,
  linkReviewedVersion,
  listRepos,
  migrateDiscovery,
  postRepo,
  prepareCommit,
  recordUsage,
  runCommitWorkflow,
  voteRepo,
  type DiscoveryWorkflowDeps,
} from "../server/src/index.js";
import {
  PostgresReviewedVersionRepository,
  ReviewedVersionService,
} from "@roster-lock/reviewed-versions";
import { freshTestDatabase, type TestDatabase } from "@roster-lock/smart-contract-test-client";

let db: TestDatabase;
let deps: DiscoveryWorkflowDeps;
let banned: string[] = [];
let cleared: string[] = [];

beforeEach(async () => {
  db = await freshTestDatabase();
  await migrateDiscovery(db);
  banned = [];
  cleared = [];
  deps = {
    db,
    now: () => 1_000,
    fetcher: {
      async fetch(repoUrl, commit, entry) {
        return {
          repoUrl,
          commit,
          entry: entry ?? "contract.js",
          files: { "contract.js": "defineContract({ endpoints: {} });" },
          license: "MIT",
        };
      },
    },
    builder: {
      async build(source) {
        return {
          entry: source.entry,
          code: "defineContract({ endpoints: { ping: { run: async () => 'pong' } } });",
          sourceHash: "abc123",
        };
      },
    },
    artifacts: {
      async put() {},
      async delete() {},
    },
    dataCleaner: {
      async clear(namespace) {
        cleared.push(namespace);
      },
    },
    notifier: {
      async commitBanned(commit, rosterIds) {
        banned.push(commit.id, ...rosterIds);
      },
    },
  };
});

describe("discovery catalog", () => {
  it("posts a repo and returns duplicates with the existing row", async () => {
    const first = await postRepo(deps, {
      url: "https://github.com/example/living-roster",
      kind: "roster-environment",
      createdBy: "alice",
    });
    expect(first.duplicate).toBe(false);
    const second = await postRepo(deps, {
      url: "http://www.github.com/example/living-roster.git",
      kind: "roster-environment",
      createdBy: "bob",
    });
    expect(second.duplicate).toBe(true);
    expect(second.repo.id).toBe(first.repo.id);
  });

  it("builds a commit and derives approval from the review record", async () => {
    const { repo } = await postRepo(deps, {
      url: "github.com/example/env",
      kind: "roster-environment",
      createdBy: "alice",
    });
    const prepared = await prepareCommit(deps, {
      repoUrl: repo.url,
      commit: "abc",
    });
    expect(prepared.commit.buildStatus).toBe("ready");
    expect(prepared.commit.artifactKey).toBe(`discovery/${prepared.commit.id}.js`);
    expect(prepared.artifact.sourceHash).toBe("abc123");
    expect(prepared.commit.approved).toBe(false);

    const reviews = new ReviewedVersionService({
      repository: new PostgresReviewedVersionRepository(db),
      now: () => 1_000,
    });
    const submitted = await reviews.submit({
      kind: "roster-environment",
      sourceHash: "abc123",
      repoUrl: repo.url,
      commit: "abc",
    });
    await reviews.approve(submitted.id, "admin", "reviewed");

    const linked = await linkReviewedVersion(deps, prepared.commit.id, submitted.id);
    expect(linked.reviewedVersionId).toBe(submitted.id);
    expect(linked.approved).toBe(true);
    expect(linked.approvedBy).toBe("admin");
  });

  it("records usage as a projection and disables a commit", async () => {
    const { repo } = await postRepo(deps, {
      url: "github.com/example/env",
      kind: "matchmaker",
      createdBy: "alice",
    });
    const prepared = await prepareCommit(deps, {
      repoUrl: repo.url,
      commit: "abc",
    });
    await recordUsage(deps, {
      rosterId: "r1",
      commitId: prepared.commit.id,
      billing: "platform",
      dataNamespace: "matchmaker:r1:abc",
    });

    const disabled = await disableCommit(deps, {
      commitId: prepared.commit.id,
      reason: "bad",
      clearData: true,
    });
    expect(disabled.rosterIds).toEqual(["r1"]);
    expect(banned).toContain(prepared.commit.id);
    expect(banned).toContain("r1");
    expect(cleared).toEqual(["matchmaker:r1:abc"]);

    const usage = await db.query<{ status: string }>(
      `SELECT status FROM discovery_usage WHERE commit_id = $1`,
      [prepared.commit.id],
    );
    expect(usage.rows[0]?.status).toBe("banned");
    const after = await getCommit(db, prepared.commit.id);
    expect(after?.dataClearedAt).toBe(1_000);
  });

  it("runs the stepwise fetch/build/upload workflow", async () => {
    const { repo } = await postRepo(deps, {
      url: "github.com/example/workflow",
      kind: "matchmaker",
      createdBy: "alice",
    });
    const steps: string[] = [];
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      steps.push(name);
      return fn();
    };
    const result = await runCommitWorkflow(
      deps,
      {
        repoUrl: repo.url,
        commit: "wf",
      },
      step,
    );
    expect(steps).toEqual([
      "resolve-repo",
      "reserve-commit",
      "fetch-dearchive",
      "build-rollup",
      "validate",
      "upload-r2",
      "complete",
    ]);
    expect(result.commit.buildStatus).toBe("ready");
  });

  it("lists and votes on repos", async () => {
    const { repo } = await postRepo(deps, {
      url: "github.com/example/env",
      kind: "roster-environment",
      createdBy: "alice",
    });
    await voteRepo(db, { repoId: repo.id, userId: "alice", value: 1 });
    const repos = await listRepos(db);
    expect(repos[0].score).toBe(1);
    expect(repos[0].votes).toBe(1);
  });
});
