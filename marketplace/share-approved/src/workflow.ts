import {
  disableCommit,
  getCommit,
  getRepo,
  linkReviewedVersion,
  notifyRepoUpdate,
  prepareCommit,
  recordUsage,
  type DiscoveryCommit,
  type DiscoveryRepo,
  type DiscoveryWorkflowDeps,
} from "@roster-lock/discovery";
import type {
  LivingRosterAdopter,
  LivingRosterDeployment,
} from "@roster-lock/living-roster-cloudflare";
import type {
  MatchMakerAdopter,
  MatchMakerDeployment,
} from "@roster-lock/match-making-cloudflare";
import {
  type AdoptableKind,
  type AdoptionRecord,
  type AdoptionRequest,
  type ReviewedKind,
  type ReviewedVersion,
  type ReviewedVersionService,
} from "@roster-lock/reviewed-versions";

export interface ShareApprovedAdopters {
  "living-roster": LivingRosterAdopter;
  "match-maker": MatchMakerAdopter;
}

export interface ShareApprovedDeps {
  discovery: DiscoveryWorkflowDeps;
  review: ReviewedVersionService;
  adopters: ShareApprovedAdopters;
}

export type SharedAdoption =
  | AdoptionRecord<LivingRosterDeployment>
  | AdoptionRecord<MatchMakerDeployment>;

export interface ApproveSharedCommitInput {
  repoUrl: string;
  commit: string;
  entry?: string;
  reviewer: string;
  reason?: string;
}

export interface ApproveSharedCommitResult {
  commit: DiscoveryCommit;
  version: ReviewedVersion;
}

export interface AdoptSharedCommitInput {
  rosterId: string;
  repoUrl: string;
  commit: string;
  entry?: string;
  dataNamespace?: string;
  config?: Record<string, unknown>;
}

export interface BanSharedCommitInput {
  commitId: string;
  reviewer: string;
  reason?: string;
  clearData?: boolean;
}

export interface BanSharedCommitResult {
  notified: string[];
}

export interface ShareApprovedWorkflow {
  approveCommit(input: ApproveSharedCommitInput): Promise<ApproveSharedCommitResult>;
  adoptCommit(input: AdoptSharedCommitInput): Promise<SharedAdoption>;
  banCommit(input: BanSharedCommitInput): Promise<BanSharedCommitResult>;
}

function reviewKindFor(repo: DiscoveryRepo): ReviewedKind {
  return repo.kind === "matchmaker" ? "matchmaker" : "roster-environment";
}

function adoptionKindFor(repo: DiscoveryRepo): AdoptableKind {
  return repo.kind === "matchmaker" ? "match-maker" : "living-roster";
}

/**
 * Approve one shared commit: build it, make the review record the authority,
 * link the commit to it, and notify rosters already using the repo.
 */
export async function approveSharedCommit(
  deps: ShareApprovedDeps,
  input: ApproveSharedCommitInput,
): Promise<ApproveSharedCommitResult> {
  const prepared = await prepareCommit(deps.discovery, {
    repoUrl: input.repoUrl,
    commit: input.commit,
    entry: input.entry,
  });
  const repo = await getRepo(deps.discovery.db, prepared.commit.repoId);
  if (!repo) throw new Error("repository not found");
  const sourceHash = prepared.commit.sourceHash;
  if (!sourceHash) throw new Error("commit did not produce a source hash");

  const kind = reviewKindFor(repo);
  let version =
    (await deps.review.findBySource({ kind, sourceHash })) ??
    (await deps.review.submit({
      kind,
      sourceHash,
      repoUrl: repo.url,
      commit: prepared.commit.commit,
      entry: prepared.commit.entry ?? input.entry ?? undefined,
      submittedBy: input.reviewer,
    }));
  if (version.status !== "approved") {
    version = await deps.review.approve(version.id, input.reviewer, input.reason);
  }

  const commit = await linkReviewedVersion(
    deps.discovery,
    prepared.commit.id,
    version.id,
  );
  await notifyRepoUpdate(deps.discovery, commit);
  return { commit, version };
}

/**
 * Adopt an approved version into a roster. The product adopter enforces the
 * approval gate; the marketplace records the usage projection afterwards.
 */
export async function adoptSharedCommit(
  deps: ShareApprovedDeps,
  input: AdoptSharedCommitInput,
): Promise<SharedAdoption> {
  const prepared = await prepareCommit(deps.discovery, {
    repoUrl: input.repoUrl,
    commit: input.commit,
    entry: input.entry,
  });
  const repo = await getRepo(deps.discovery.db, prepared.commit.repoId);
  if (!repo) throw new Error("repository not found");
  const sourceHash = prepared.commit.sourceHash;
  if (!sourceHash) throw new Error("commit did not produce a source hash");

  const kind = adoptionKindFor(repo);
  const request: AdoptionRequest = {
    rosterId: input.rosterId,
    kind,
    sourceHash,
    repo: repo.url,
    commit: prepared.commit.commit,
    entry: prepared.commit.entry ?? input.entry ?? "",
    ...(input.config ? { config: input.config } : {}),
  };
  const adoption =
    kind === "living-roster"
      ? await deps.adopters["living-roster"].adopt({
          ...request,
          kind: "living-roster",
        })
      : await deps.adopters["match-maker"].adopt({
          ...request,
          kind: "match-maker",
        });

  await recordUsage(deps.discovery, {
    rosterId: input.rosterId,
    commitId: prepared.commit.id,
    billing: "platform",
    ...(input.dataNamespace ? { dataNamespace: input.dataNamespace } : {}),
  });
  return adoption;
}

/**
 * Ban a commit: review records the ban, the product revokes the adoption, and
 * discovery removes the artifact, clears roster data and notifies.
 */
export async function banSharedCommit(
  deps: ShareApprovedDeps,
  input: BanSharedCommitInput,
): Promise<BanSharedCommitResult> {
  const commit = await getCommit(deps.discovery.db, input.commitId);
  if (!commit) throw new Error("commit not found");
  const repo = await getRepo(deps.discovery.db, commit.repoId);
  if (!repo) throw new Error("repository not found");
  const reason = input.reason ?? "banned by an administrator";

  const version = commit.reviewedVersionId
    ? await deps.review.get(commit.reviewedVersionId)
    : commit.sourceHash
      ? await deps.review.findBySource({
          kind: reviewKindFor(repo),
          sourceHash: commit.sourceHash,
        })
      : undefined;
  if (version && version.status !== "banned") {
    await deps.review.ban(version.id, input.reviewer, reason);
  }

  const disabled = await disableCommit(deps.discovery, {
    commitId: input.commitId,
    reason,
    clearData: input.clearData,
  });

  if (commit.sourceHash) {
    const kind = adoptionKindFor(repo);
    for (const rosterId of disabled.rosterIds) {
      if (kind === "living-roster") {
        await deps.adopters["living-roster"].revoke(rosterId, commit.sourceHash);
      } else {
        await deps.adopters["match-maker"].revoke(rosterId, commit.sourceHash);
      }
    }
  }
  return { notified: disabled.rosterIds };
}

export function createShareApprovedWorkflow(
  deps: ShareApprovedDeps,
): ShareApprovedWorkflow {
  return {
    approveCommit: (input) => approveSharedCommit(deps, input),
    adoptCommit: (input) => adoptSharedCommit(deps, input),
    banCommit: (input) => banSharedCommit(deps, input),
  };
}
