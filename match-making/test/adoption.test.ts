import { describe, expect, it, vi } from "vitest";
import {
  MemoryAdoptionStore,
  MemoryReviewedVersionRepository,
  ReviewedVersionService,
  type AdoptionRequest,
} from "@roster-lock/reviewed-versions";
import { createMatchMakerAdopter } from "@roster-lock/match-making-cloudflare";

function request(overrides: Partial<AdoptionRequest> = {}): AdoptionRequest {
  return {
    rosterId: "roster:1",
    kind: "match-maker",
    sourceHash: "hash:m",
    repo: "github.com/example/matchmaker",
    commit: "def456",
    entry: "matchmaker.ts",
    ...overrides,
  };
}

async function approvedMatchmaker(sourceHash: string) {
  const reviews = new ReviewedVersionService({
    repository: new MemoryReviewedVersionRepository(),
    now: () => 100,
  });
  const submitted = await reviews.submit({ kind: "matchmaker", sourceHash });
  await reviews.approve(submitted.id, "admin", "reviewed");
  return reviews;
}

describe("match-maker adoption", () => {
  it("attaches and records an approved match maker", async () => {
    const gate = await approvedMatchmaker("hash:m");
    const store = new MemoryAdoptionStore();
    const attach = vi.fn(async () => ({ deploymentId: "mm:1" }));
    const adopter = createMatchMakerAdopter({
      gate,
      store,
      attach,
      now: () => 11,
    });

    const adoption = await adopter.adopt(request());

    expect(attach).toHaveBeenCalledTimes(1);
    expect(adoption.kind).toBe("match-maker");
    expect(adoption.adoptedAt).toBe(11);
    expect(adoption.result.deploymentId).toBe("mm:1");
    expect(await adopter.list("roster:1")).toHaveLength(1);
  });

  it("fails closed for a rejected version", async () => {
    const reviews = new ReviewedVersionService({
      repository: new MemoryReviewedVersionRepository(),
      now: () => 1,
    });
    const submitted = await reviews.submit({
      kind: "matchmaker",
      sourceHash: "hash:rejected",
    });
    await reviews.reject(submitted.id, "admin", "not safe");
    const attach = vi.fn(async () => ({ deploymentId: "mm:1" }));
    const adopter = createMatchMakerAdopter({
      gate: reviews,
      store: new MemoryAdoptionStore(),
      attach,
    });

    await expect(
      adopter.adopt(request({ sourceHash: "hash:rejected" })),
    ).rejects.toMatchObject({ code: "review.rejected" });
    expect(attach).not.toHaveBeenCalled();
  });

  it("revokes with the match-maker teardown", async () => {
    const gate = await approvedMatchmaker("hash:m");
    const attach = vi.fn(async () => ({ deploymentId: "mm:1" }));
    const revert = vi.fn(async () => {});
    const adopter = createMatchMakerAdopter({
      gate,
      store: new MemoryAdoptionStore(),
      attach,
      revert,
    });

    await adopter.adopt(request());
    const revoked = await adopter.revoke("roster:1", "hash:m");

    expect(revoked?.status).toBe("revoked");
    expect(revert).toHaveBeenCalledTimes(1);
  });
});
