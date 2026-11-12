import { describe, expect, it } from "vitest";
import { createDiscoveryApp } from "@roster-lock/discovery/server";
import type { DiscoveryApi } from "@roster-lock/discovery/server";
import type { DiscoveryRepo } from "@roster-lock/discovery/server";

const repo: DiscoveryRepo = {
  id: "r1",
  url: "github.com/example/env",
  kind: "roster-environment",
  source: "github",
  externalId: null,
  createdBy: "alice",
  createdAt: 1,
};

function api(): DiscoveryApi {
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
      return { score: 3 };
    },
  };
}

describe("discovery Hono app", () => {
  it("requires a user and creates a repo", async () => {
    const app = createDiscoveryApp(api());
    const unauth = await app.request("/repos", {
      method: "POST",
      body: JSON.stringify({ url: repo.url, kind: repo.kind }),
    });
    expect(unauth.status).toBe(401);

    const created = await app.request("/repos", {
      method: "POST",
      headers: { "x-user-id": "alice", "content-type": "application/json" },
      body: JSON.stringify({ url: repo.url, kind: repo.kind }),
    });
    expect(created.status).toBe(201);
  });

  it("validates vote values", async () => {
    const app = createDiscoveryApp(api());
    const bad = await app.request("/repos/r1/vote", {
      method: "POST",
      headers: { "x-user-id": "alice", "content-type": "application/json" },
      body: JSON.stringify({ value: 2 }),
    });
    expect(bad.status).toBe(400);
  });
});
