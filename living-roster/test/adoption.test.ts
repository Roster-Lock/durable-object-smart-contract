import { describe, expect, it, vi } from "vitest";
import {
  MemoryAdoptionStore,
  MemoryReviewedVersionRepository,
  ReviewedVersionService,
  type AdoptionRequest,
  type ReviewedKindInput,
} from "@roster-lock/reviewed-versions";
import { createLivingRosterAdopter } from "@roster-lock/living-roster-cloudflare";

function request(overrides: Partial<AdoptionRequest> = {}): AdoptionRequest {
  return {
    rosterId: "roster:1",
    kind: "living-roster",
    sourceHash: "hash:a",
    repo: "github.com/example/roster",
    commit: "abc123",
    entry: "contracts/governance.ts",
    ...overrides,
  };
}

async function approvedReviews(kind: ReviewedKindInput, sourceHash: string) {
  const reviews = new ReviewedVersionService({
    repository: new MemoryReviewedVersionRepository(),
    now: () => 100,
  });
  const submitted = await reviews.submit({ kind, sourceHash });
  await reviews.approve(submitted.id, "admin", "reviewed");
  return reviews;
}

describe("living-roster adoption", () => {
  it("deploys and records an approved environment", async () => {
    const gate = await approvedReviews("living-roster", "hash:a");
    const store = new MemoryAdoptionStore();
    const deploy = vi.fn(async () => ({ contractId: "contract:1" }));
    const adopter = createLivingRosterAdopter({
      gate,
      store,
      deploy,
      now: () => 42,
    });

    const adoption = await adopter.adopt(request());

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(adoption.status).toBe("active");
    expect(adoption.adoptedAt).toBe(42);
    expect(adoption.result.contractId).toBe("contract:1");
    expect(await adopter.list("roster:1")).toHaveLength(1);
    expect(await adopter.list("roster:2")).toHaveLength(0);
  });

  it("fails closed when the version is only pending", async () => {
    const reviews = new ReviewedVersionService({
      repository: new MemoryReviewedVersionRepository(),
      now: () => 1,
    });
    await reviews.submit({ kind: "living-roster", sourceHash: "hash:pending" });
    const deploy = vi.fn(async () => ({ contractId: "contract:1" }));
    const adopter = createLivingRosterAdopter({
      gate: reviews,
      store: new MemoryAdoptionStore(),
      deploy,
    });

    await expect(
      adopter.adopt(request({ sourceHash: "hash:pending" })),
    ).rejects.toMatchObject({ code: "review.pending" });
    expect(deploy).not.toHaveBeenCalled();
  });

  it("rejects adopting a match maker through the roster adopter", async () => {
    const gate = await approvedReviews("living-roster", "hash:a");
    const deploy = vi.fn(async () => ({ contractId: "contract:1" }));
    const adopter = createLivingRosterAdopter({
      gate,
      store: new MemoryAdoptionStore(),
      deploy,
    });

    await expect(
      adopter.adopt(request({ kind: "match-maker" })),
    ).rejects.toMatchObject({ code: "review.invalid" });
    expect(deploy).not.toHaveBeenCalled();
  });

  it("is idempotent while the adoption is active", async () => {
    const gate = await approvedReviews("living-roster", "hash:a");
    const deploy = vi.fn(async () => ({ contractId: "contract:1" }));
    const adopter = createLivingRosterAdopter({
      gate,
      store: new MemoryAdoptionStore(),
      deploy,
    });

    await adopter.adopt(request());
    const second = await adopter.adopt(request());

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("active");
  });

  it("revokes an adoption and runs the teardown", async () => {
    const gate = await approvedReviews("living-roster", "hash:a");
    const deploy = vi.fn(async () => ({ contractId: "contract:1" }));
    const revert = vi.fn(async () => {});
    const adopter = createLivingRosterAdopter({
      gate,
      store: new MemoryAdoptionStore(),
      deploy,
      revert,
      now: () => 7,
    });

    await adopter.adopt(request());
    const revoked = await adopter.revoke("roster:1", "hash:a");

    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).toBe(7);
    expect(revert).toHaveBeenCalledTimes(1);
    expect(await adopter.list("roster:1")).toHaveLength(1);
  });
});
