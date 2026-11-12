import { describe, expect, it, vi } from "vitest";
import { createShareApprovedApp } from "@roster-lock/share-approved";
import type {
  ShareApprovedWorkflow,
  SharedAdoption,
} from "@roster-lock/share-approved";
import type { DiscoveryApi, DiscoveryRepo } from "@roster-lock/discovery";

const repo: DiscoveryRepo = {
  id: "r1",
  url: "github.com/example/env",
  kind: "roster-environment",
  source: "github",
  externalId: null,
  createdBy: "alice",
  createdAt: 1,
};

function discoveryApi(): DiscoveryApi {
  return {
    async postRepo(user, input) {
      return {
        repo: { ...repo, url: input.url, kind: input.kind, createdBy: user.userId },
        duplicate: false,
      };
    },
    async listRepos() {
      return [repo];
    },
    async voteRepo() {
      return { score: 1 };
    },
  };
}

function workflow(): ShareApprovedWorkflow {
  const adoption = { kind: "living-roster", result: {} } as unknown as SharedAdoption;
  return {
    approveCommit: vi.fn(async () => ({
      commit: {
        id: "c1",
        repoId: "r1",
        commit: "abc",
        buildStatus: "ready" as const,
        reviewedVersionId: "rv1",
        approved: true,
        approvedBy: "admin",
        approvedAt: 2,
        banned: false,
        bannedBy: null,
        bannedAt: null,
        banReason: null,
        dataClearedAt: null,
        entry: "contract.js",
        sourceHash: "hash",
        artifactKey: "discovery/c1.js",
        error: null,
        createdAt: 1,
        updatedAt: 2,
      },
      version: {
        id: "rv1",
        kind: "roster-environment" as const,
        sourceHash: "hash",
        status: "approved" as const,
        createdAt: 1,
        updatedAt: 2,
      },
    })),
    adoptCommit: vi.fn(async () => adoption),
    banCommit: vi.fn(async () => ({ notified: ["r1"] })),
  };
}

describe("share-approved app", () => {
  it("requires a user to adopt and an admin to approve", async () => {
    const wf = workflow();
    const app = createShareApprovedApp(wf, discoveryApi());

    const unauth = await app.request("/rosters/r1/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: repo.url, commit: "abc" }),
    });
    expect(unauth.status).toBe(401);

    const notAdmin = await app.request("/commits/approve", {
      method: "POST",
      headers: { "x-user-id": "alice", "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: repo.url, commit: "abc" }),
    });
    expect(notAdmin.status).toBe(403);

    const admin = await app.request("/commits/approve", {
      method: "POST",
      headers: {
        "x-user-id": "admin",
        "x-user-admin": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({ repoUrl: repo.url, commit: "abc" }),
    });
    expect(admin.status).toBe(200);
    expect(wf.approveCommit).toHaveBeenCalledTimes(1);
  });

  it("adopts for an authenticated user", async () => {
    const wf = workflow();
    const app = createShareApprovedApp(wf, discoveryApi());

    const adopted = await app.request("/rosters/r1/adopt", {
      method: "POST",
      headers: { "x-user-id": "alice", "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: repo.url, commit: "abc" }),
    });
    expect(adopted.status).toBe(201);
    expect(wf.adoptCommit).toHaveBeenCalledWith({
      rosterId: "r1",
      repoUrl: repo.url,
      commit: "abc",
      entry: undefined,
      dataNamespace: undefined,
      config: undefined,
    });
  });
});
