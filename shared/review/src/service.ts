import type { ReviewedVersionRepository } from "./store.js";
import {
  ReviewError,
  normalizeReviewedKind,
  normalizeSourceHash,
  type ReviewGateInput,
  type ReviewListFilter,
  type ReviewedKind,
  type ReviewedVersion,
  type ReviewedVersionGate,
  type SubmitReviewedVersionInput,
} from "./types.js";

export interface ReviewedVersionServiceOptions {
  repository: ReviewedVersionRepository;
  now?: () => number;
}

/**
 * The website's authoritative reviewed-version allowlist.
 *
 * A review is bound to the immutable source hash. Any code change produces a
 * new hash and therefore a new pending version. Only `approved` may deploy;
 * missing, pending, rejected and banned versions fail closed.
 */
export class ReviewedVersionService implements ReviewedVersionGate {
  private readonly repository: ReviewedVersionRepository;
  private readonly now: () => number;

  constructor(options: ReviewedVersionServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
  }

  async submit(input: SubmitReviewedVersionInput): Promise<ReviewedVersion> {
    const kind = normalizeReviewedKind(input.kind);
    const sourceHash = normalizeSourceHash(input.sourceHash);
    const existing = await this.repository.findBySource(kind, sourceHash);
    if (existing) {
      if (existing.status === "banned") {
        throw new ReviewError(
          "review.banned",
          `version ${kind}@${sourceHash} is banned; a new source hash is required`,
        );
      }
      // Submission is idempotent and never resets an existing decision.
      return existing;
    }
    const now = this.now();
    const version: ReviewedVersion = {
      id: reviewedVersionId(kind, sourceHash),
      kind,
      sourceHash,
      status: "pending",
      ...(input.version ? { version: input.version } : {}),
      ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.entry ? { entry: input.entry } : {}),
      ...(input.artifactKey ? { artifactKey: input.artifactKey } : {}),
      ...(input.submittedBy ? { submittedBy: input.submittedBy } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.save(version);
    return version;
  }

  async approve(id: string, reviewedBy: string, reason?: string): Promise<ReviewedVersion> {
    const current = await this.get(id);
    if (current.status === "banned") {
      throw new ReviewError("review.banned", "a banned version cannot be approved");
    }
    if (current.status === "approved") return current;
    requireReviewer(reviewedBy);
    const now = this.now();
    const approved: ReviewedVersion = {
      ...current,
      status: "approved",
      reviewedBy,
      reviewedAt: now,
      ...(reason ? { reason } : {}),
      updatedAt: now,
    };
    await this.repository.save(approved);
    return approved;
  }

  async reject(id: string, reviewedBy: string, reason: string): Promise<ReviewedVersion> {
    const current = await this.get(id);
    if (current.status === "banned") {
      throw new ReviewError("review.banned", "a banned version cannot be reviewed");
    }
    if (current.status === "approved") {
      throw new ReviewError(
        "review.approved",
        "an approved version must be banned/delisted to revoke it; reject is for pending reviews",
      );
    }
    requireReviewer(reviewedBy);
    requireReason(reason);
    const now = this.now();
    const rejected: ReviewedVersion = {
      ...current,
      status: "rejected",
      reviewedBy,
      reviewedAt: now,
      reason,
      updatedAt: now,
    };
    await this.repository.save(rejected);
    return rejected;
  }

  async ban(id: string, actor: string, reason: string): Promise<ReviewedVersion> {
    const current = await this.get(id);
    if (current.status === "banned") return current;
    requireReviewer(actor);
    requireReason(reason);
    const now = this.now();
    const banned: ReviewedVersion = {
      ...current,
      status: "banned",
      reviewedBy: actor,
      reviewedAt: now,
      reason,
      updatedAt: now,
    };
    await this.repository.save(banned);
    return banned;
  }

  async get(id: string): Promise<ReviewedVersion> {
    const version = await this.repository.get(id);
    if (!version) throw new ReviewError("review.missing", `reviewed version ${id} was not found`);
    return version;
  }

  async list(filter: ReviewListFilter = {}): Promise<ReviewedVersion[]> {
    return this.repository.list(filter);
  }

  async findBySource(input: ReviewGateInput): Promise<ReviewedVersion | undefined> {
    return this.repository.findBySource(
      normalizeReviewedKind(input.kind),
      normalizeSourceHash(input.sourceHash),
    );
  }

  async isApproved(input: ReviewGateInput): Promise<boolean> {
    const version = await this.findBySource(input);
    return version?.status === "approved";
  }

  /** Fail closed unless this exact source hash has an approved review. */
  async requireApproved(input: ReviewGateInput): Promise<ReviewedVersion> {
    const kind = normalizeReviewedKind(input.kind);
    const sourceHash = normalizeSourceHash(input.sourceHash);
    const version = await this.repository.findBySource(kind, sourceHash);
    if (!version) {
      throw new ReviewError(
        "review.missing",
        `${kind} source ${sourceHash} has not been reviewed; no deployment is allowed`,
      );
    }
    if (version.status === "approved") return version;
    if (version.status === "pending") {
      throw new ReviewError(
        "review.pending",
        `${kind} source ${sourceHash} is awaiting review; no deployment is allowed`,
      );
    }
    if (version.status === "rejected") {
      throw new ReviewError(
        "review.rejected",
        `${kind} source ${sourceHash} was rejected; no deployment is allowed`,
      );
    }
    throw new ReviewError(
      "review.banned",
      `${kind} source ${sourceHash} is banned; no deployment is allowed`,
    );
  }
}

/**
 * Hash a contract/matchmaker source exactly like the runtime does: SHA-256 of
 * the UTF-8 source, lowercase hex, no `sha256:` prefix.
 */
export async function hashReviewedSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Gate a source string and deploy only when its computed hash is approved. */
export async function deployReviewedSource<T>(
  gate: ReviewedVersionGate,
  input: { kind: ReviewGateInput["kind"]; source: string },
  deploy: (version: ReviewedVersion, sourceHash: string) => Promise<T>,
): Promise<T> {
  const sourceHash = await hashReviewedSource(input.source);
  const version = await gate.requireApproved({ kind: input.kind, sourceHash });
  return deploy(version, sourceHash);
}

export function reviewedVersionId(kind: ReviewedKind, sourceHash: string): string {
  // Browser/Worker-safe deterministic id. The source hash remains the unique
  // identity in the database; this id only makes re-submission ergonomic.
  return `rv_${stableHash(`${kind}\0${sourceHash}`)}`;
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (const byte of new TextEncoder().encode(value)) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second + byte, 0x85ebca6b) >>> 0;
  }
  return [first, second, first ^ second, Math.imul(first, second) >>> 0]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}

export async function assertDeployableVersion(
  gate: ReviewedVersionGate,
  input: ReviewGateInput,
): Promise<ReviewedVersion> {
  return gate.requireApproved(input);
}

/**
 * Run a deployment only after the exact source hash is approved. Keeping the
 * check and the deploy in one helper makes it harder for a route to forget the
 * gate.
 */
export async function deployReviewedVersion<T>(
  gate: ReviewedVersionGate,
  input: ReviewGateInput,
  deploy: (version: ReviewedVersion) => Promise<T>,
): Promise<T> {
  const version = await gate.requireApproved(input);
  return deploy(version);
}

function requireReviewer(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new ReviewError("review.invalid", "reviewer id must be a non-empty string");
  }
}

function requireReason(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_000) {
    throw new ReviewError("review.invalid", "a reason is required (at most 2000 characters)");
  }
}
