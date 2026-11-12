import {
  listRepos,
  postRepo,
  voteRepo,
  type DiscoveryWorkflowDeps,
  type PostRepoInput,
  type PostRepoResult,
} from "./workflow.js";
import type { DiscoveryRepo, DiscoveryUser, RepoKind } from "./types.js";

/**
 * Catalog API: posting, listing and voting. Approval, adoption and banning
 * live in the marketplace app, which composes this API with the review store
 * and the product adopters.
 */
export interface DiscoveryApi {
  postRepo(
    user: DiscoveryUser,
    input: Omit<PostRepoInput, "createdBy">,
  ): Promise<PostRepoResult>;
  listRepos(filter: {
    kind?: RepoKind;
    query?: string;
    limit?: number;
    sort?: "new" | "score";
  }): Promise<DiscoveryRepo[]>;
  voteRepo(
    user: DiscoveryUser,
    input: { repoId: string; value: -1 | 1 },
  ): Promise<{ score: number }>;
}

/** Bind the catalog to its Postgres dependencies. */
export function createDiscoveryApi(deps: DiscoveryWorkflowDeps): DiscoveryApi {
  return {
    postRepo: (user, input) =>
      postRepo(deps, { ...input, createdBy: user.userId }),
    listRepos: (filter) => listRepos(deps.db, filter),
    voteRepo: (user, input) =>
      voteRepo(deps.db, { ...input, userId: user.userId }),
  };
}
