export type ReviewedKind = "roster-environment" | "matchmaker";
export type ReviewedKindInput = ReviewedKind | "living-roster" | "living_roster";
export type ReviewStatus = "pending" | "approved" | "rejected" | "banned";

export interface ReviewedVersion {
  id: string;
  kind: ReviewedKind;
  /** Immutable identity of the exact code/artifact. A new hash is a new review. */
  sourceHash: string;
  status: ReviewStatus;
  version?: string;
  repoUrl?: string;
  commit?: string;
  entry?: string;
  artifactKey?: string;
  submittedBy?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SubmitReviewedVersionInput {
  kind: ReviewedKindInput;
  sourceHash: string;
  version?: string;
  repoUrl?: string;
  commit?: string;
  entry?: string;
  artifactKey?: string;
  submittedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewListFilter {
  kind?: ReviewedKind;
  status?: ReviewStatus;
  limit?: number;
}

export interface ReviewGateInput {
  kind: ReviewedKindInput;
  sourceHash: string;
}

export interface ReviewedVersionGate {
  requireApproved(input: ReviewGateInput): Promise<ReviewedVersion>;
}

export type ReviewErrorCode =
  | "review.missing"
  | "review.pending"
  | "review.rejected"
  | "review.banned"
  | "review.approved"
  | "review.invalid"
  | "review.conflict";

export class ReviewError extends Error {
  readonly code: ReviewErrorCode;
  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
  }
}

export function normalizeReviewedKind(kind: ReviewedKindInput): ReviewedKind {
  if (kind === "roster-environment" || kind === "matchmaker") return kind;
  if (kind === "living-roster" || kind === "living_roster") return "roster-environment";
  throw new ReviewError("review.invalid", `unknown reviewed kind ${JSON.stringify(kind)}`);
}

export function normalizeSourceHash(value: string): string {
  if (typeof value !== "string") {
    throw new ReviewError("review.invalid", "sourceHash must be a string");
  }
  const sourceHash = value.trim();
  if (!sourceHash || sourceHash.length > 256) {
    throw new ReviewError("review.invalid", "sourceHash must be a non-empty string of at most 256 characters");
  }
  return sourceHash;
}
