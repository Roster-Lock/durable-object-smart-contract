import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  MemoryReviewedVersionRepository,
  PostgresReviewedVersionRepository,
  ReviewError,
  ReviewedVersionService,
  deployReviewedSource,
  deployReviewedVersion,
  hashReviewedSource,
  reviewedVersionId,
} from "@roster-lock/reviewed-versions";
import { freshTestDatabase } from "@roster-lock/smart-contract-test-client";

function service(now = 1_000) {
  return new ReviewedVersionService({
    repository: new MemoryReviewedVersionRepository(),
    now: () => now,
  });
}

describe("reviewed versions", () => {
  it("fails closed for missing, pending, rejected and banned versions", async () => {
    const reviews = service();
    const input = {
      kind: "living-roster" as const,
      sourceHash: "sha256:one",
      version: "1.0.0",
      repoUrl: "github.com/example/roster",
      commit: "abc",
      submittedBy: "alice",
    };
    const pending = await reviews.submit(input);
    expect(pending).toMatchObject({
      kind: "roster-environment",
      status: "pending",
      id: reviewedVersionId("roster-environment", "sha256:one"),
    });

    await expect(
      reviews.requireApproved({ kind: "roster-environment", sourceHash: "sha256:one" }),
    ).rejects.toMatchObject({ code: "review.pending" });
    await expect(
      reviews.requireApproved({ kind: "matchmaker", sourceHash: "sha256:one" }),
    ).rejects.toMatchObject({ code: "review.missing" });

    const approved = await reviews.approve(pending.id, "admin");
    expect(approved.status).toBe("approved");
    await expect(
      reviews.requireApproved({ kind: "roster-environment", sourceHash: "sha256:one" }),
    ).resolves.toMatchObject({ id: pending.id, status: "approved" });

    const rejected = await reviews.reject(
      (await reviews.submit({ kind: "matchmaker", sourceHash: "sha256:two" })).id,
      "admin",
      "unsafe loop",
    );
    expect(rejected.status).toBe("rejected");
    await expect(
      reviews.requireApproved({ kind: "matchmaker", sourceHash: "sha256:two" }),
    ).rejects.toMatchObject({ code: "review.rejected" });

    await reviews.ban(approved.id, "admin", "delisted");
    await expect(
      reviews.requireApproved({ kind: "roster-environment", sourceHash: "sha256:one" }),
    ).rejects.toMatchObject({ code: "review.banned" });
  });

  it("never resets an existing decision on resubmission and binds to the source hash", async () => {
    const reviews = service();
    const first = await reviews.submit({ kind: "roster-environment", sourceHash: "sha256:one" });
    await reviews.approve(first.id, "admin");
    const again = await reviews.submit({ kind: "living-roster", sourceHash: "sha256:one" });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("approved");
    expect(again.reviewedBy).toBe("admin");

    const second = await reviews.submit({ kind: "roster-environment", sourceHash: "sha256:two" });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
  });

  it("enforces review transitions", async () => {
    const reviews = service();
    const pending = await reviews.submit({ kind: "matchmaker", sourceHash: "sha256:m" });
    const approved = await reviews.approve(pending.id, "admin", "looks good");
    expect(approved.reason).toBe("looks good");
    await expect(reviews.reject(approved.id, "admin", "no")).rejects.toMatchObject({
      code: "review.approved",
    });
    await reviews.ban(approved.id, "admin", "delisted");
    await expect(reviews.approve(approved.id, "admin")).rejects.toMatchObject({
      code: "review.banned",
    });
    await expect(
      reviews.submit({ kind: "matchmaker", sourceHash: "sha256:m" }),
    ).rejects.toMatchObject({ code: "review.banned" });
    await expect(reviews.approve("missing", "admin")).rejects.toBeInstanceOf(ReviewError);
  });

  it("validates kind, source hash and reviewer input", async () => {
    const reviews = service();
    await expect(reviews.submit({ kind: "other" as never, sourceHash: "x" })).rejects.toMatchObject({
      code: "review.invalid",
    });
    await expect(
      reviews.submit({ kind: "matchmaker", sourceHash: "   " }),
    ).rejects.toMatchObject({ code: "review.invalid" });
    const pending = await reviews.submit({ kind: "matchmaker", sourceHash: "sha256:x" });
    await expect(reviews.approve(pending.id, "")).rejects.toMatchObject({
      code: "review.invalid",
    });
    await expect(reviews.reject(pending.id, "admin", "")).rejects.toMatchObject({
      code: "review.invalid",
    });
  });

  it("does not call the deploy function before approval", async () => {
    const reviews = service();
    const pending = await reviews.submit({ kind: "roster-environment", sourceHash: "sha256:gate" });
    let deployed = false;
    await expect(
      deployReviewedVersion(
        reviews,
        { kind: "roster-environment", sourceHash: "sha256:gate" },
        async () => {
          deployed = true;
        },
      ),
    ).rejects.toMatchObject({ code: "review.pending" });
    expect(deployed).toBe(false);

    await reviews.approve(pending.id, "admin");
    await deployReviewedVersion(
      reviews,
      { kind: "roster-environment", sourceHash: "sha256:gate" },
      async (version) => {
        deployed = true;
        expect(version.id).toBe(pending.id);
      },
    );
    expect(deployed).toBe(true);
  });

  it("hashes source like the runtime and offers a string-based deploy gate", async () => {
    const source = "defineContract({});";
    const expected = createHash("sha256").update(source).digest("hex");
    expect(await hashReviewedSource(source)).toBe(expected);

    const reviews = service();
    const pending = await reviews.submit({ kind: "matchmaker", sourceHash: expected });
    await expect(
      deployReviewedSource(
        reviews,
        { kind: "matchmaker", source },
        async () => "deployed",
      ),
    ).rejects.toMatchObject({ code: "review.pending" });
    await reviews.approve(pending.id, "admin");
    const result = await deployReviewedSource(
      reviews,
      { kind: "matchmaker", source },
      async (version, sourceHash) => ({
        id: version.id,
        sourceHash,
      }),
    );
    expect(result).toEqual({ id: pending.id, sourceHash: expected });
  });

  it("lists by kind and status", async () => {
    const reviews = service();
    const a = await reviews.submit({ kind: "roster-environment", sourceHash: "a" });
    await reviews.submit({ kind: "roster-environment", sourceHash: "b" });
    await reviews.submit({ kind: "matchmaker", sourceHash: "c" });
    await reviews.approve(a.id, "admin");
    expect(await reviews.list({ kind: "roster-environment", status: "approved" })).toHaveLength(1);
    expect(await reviews.list({ status: "pending" })).toHaveLength(2);
    expect(await reviews.list({ kind: "matchmaker" })).toHaveLength(1);
  });

  it("round-trips through Postgres", async () => {
    const db = await freshTestDatabase();
    const repository = new PostgresReviewedVersionRepository(db);
    await repository.migrate();
    const reviews = new ReviewedVersionService({ repository, now: () => 5_000 });
    const pending = await reviews.submit({
      kind: "matchmaker",
      sourceHash: "sha256:db",
      version: "1.2.3",
      repoUrl: "github.com/example/mm",
      commit: "deadbeef",
      metadata: { license: "MIT" },
    });
    await reviews.approve(pending.id, "admin", "reviewed");
    const loaded = await repository.findBySource("matchmaker", "sha256:db");
    expect(loaded).toMatchObject({
      id: pending.id,
      status: "approved",
      version: "1.2.3",
      commit: "deadbeef",
      reviewedBy: "admin",
      metadata: { license: "MIT" },
    });
    expect(await repository.list({ kind: "matchmaker", status: "approved" })).toHaveLength(1);
  });
});
