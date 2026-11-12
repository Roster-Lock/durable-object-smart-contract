import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCommit,
  migrateDiscovery,
  postRepo,
  type DiscoveryWorkflowDeps,
} from "@roster-lock/discovery";
import {
  MemoryAdoptionStore,
  PostgresReviewedVersionRepository,
  ReviewedVersionService,
} from "@roster-lock/reviewed-versions";
import { createLivingRosterAdopter } from "@roster-lock/living-roster-cloudflare";
import { createMatchMakerAdopter } from "@roster-lock/match-making-cloudflare";
import { TestDatabase } from "@roster-lock/smart-contract-test-client";
import {
  createShareApprovedWorkflow,
  type ShareApprovedWorkflow,
} from "@roster-lock/share-approved";

let db: TestDatabase;
let deps: DiscoveryWorkflowDeps;
let workflow: ShareApprovedWorkflow;
let notified: string[] = [];
let cleared: string[] = [];
let deploy: ReturnType<typeof vi.fn>;
let attach: ReturnType<typeof vi.fn>;
let revertRoster: ReturnType<typeof vi.fn>;
let revertMatch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db = await TestDatabase.create();
  await migrateDiscovery(db);
  notified = [];
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
    artifacts: { async put() {}, async delete() {} },
    dataCleaner: {
      async clear(namespace) {
        cleared.push(namespace);
      },
    },
    notifier: {
      async commitBanned(commit, rosterIds) {
        notified.push(commit.id, ...rosterIds);
      },
    },
  };

  const review = new ReviewedVersionService({
    repository: new PostgresReviewedVersionRepository(db),
    now: () => 2_000,
  });
  deploy = vi.fn(async () => ({ contractId: "contract:1" }));
  attach = vi.fn(async () => ({ deploymentId: "matchmaker:1" }));
  revertRoster = vi.fn(async () => {});
  revertMatch = vi.fn(async () => {});
  workflow = createShareApprovedWorkflow({
    discovery: deps,
    review,
    adopters: {
      "living-roster": createLivingRosterAdopter({
        gate: review,
        store: new MemoryAdoptionStore(),
        deploy,
        revert: revertRoster,
      }),
      "match-maker": createMatchMakerAdopter({
        gate: review,
        store: new MemoryAdoptionStore(),
        attach,
        revert: revertMatch,
      }),
    },
  });
});

async function post(kind: "roster-environment" | "matchmaker", url: string) {
  const { repo } = await postRepo(deps, { url, kind, createdBy: "alice" });
  return repo;
}

afterEach(async () => {
  await db.close();
});

describe("share-approved workflow", () => {
  it("approves a commit through review and adopts it into a roster", async () => {
    const repo = await post("roster-environment", "github.com/example/env");
    const approved = await workflow.approveCommit({
      repoUrl: repo.url,
      commit: "abc",
      reviewer: "admin",
    });
    expect(approved.commit.buildStatus).toBe("ready");
    expect(approved.commit.approved).toBe(true);
    expect(approved.commit.reviewedVersionId).toBe(approved.version.id);
    expect(approved.version.status).toBe("approved");

    const again = await workflow.approveCommit({
      repoUrl: repo.url,
      commit: "abc",
      reviewer: "admin",
    });
    expect(again.version.id).toBe(approved.version.id);

    const adoption = await workflow.adoptCommit({
      rosterId: "r1",
      repoUrl: repo.url,
      commit: "abc",
    });
    expect(adoption.kind).toBe("living-roster");
    expect(adoption.result).toMatchObject({ contractId: "contract:1" });
    expect(deploy).toHaveBeenCalledTimes(1);

    const usage = await db.query<{ status: string; billing: string }>(
      `SELECT status, billing FROM discovery_usage WHERE roster_id = $1`,
      ["r1"],
    );
    expect(usage.rows[0]).toEqual({ status: "active", billing: "platform" });
  });

  it("refuses to adopt before the version is approved", async () => {
    const repo = await post("roster-environment", "github.com/example/env");
    await expect(
      workflow.adoptCommit({ rosterId: "r1", repoUrl: repo.url, commit: "abc" }),
    ).rejects.toMatchObject({ code: "review.missing" });
    expect(deploy).not.toHaveBeenCalled();
  });

  it("bans a match maker, revokes the adoption and clears data", async () => {
    const repo = await post("matchmaker", "github.com/example/mm");
    const approved = await workflow.approveCommit({
      repoUrl: repo.url,
      commit: "mm1",
      reviewer: "admin",
    });
    const adoption = await workflow.adoptCommit({
      rosterId: "r1",
      repoUrl: repo.url,
      commit: "mm1",
      dataNamespace: "matchmaker:r1:mm1",
    });
    expect(adoption.kind).toBe("match-maker");
    expect(attach).toHaveBeenCalledTimes(1);

    const result = await workflow.banCommit({
      commitId: approved.commit.id,
      reviewer: "admin",
      reason: "unsafe",
      clearData: true,
    });
    expect(result.notified).toEqual(["r1"]);
    expect(revertMatch).toHaveBeenCalledTimes(1);
    expect(notified).toContain(approved.commit.id);
    expect(cleared).toEqual(["matchmaker:r1:mm1"]);

    const after = await getCommit(db, approved.commit.id);
    expect(after?.banned).toBe(true);
    const usage = await db.query<{ status: string }>(
      `SELECT status FROM discovery_usage WHERE roster_id = $1`,
      ["r1"],
    );
    expect(usage.rows[0]?.status).toBe("banned");
  });
});
