export type RepoKind = "roster-environment" | "matchmaker";
export type RepoSource = "github" | "gitlab" | "other";

export interface DiscoveryRepo {
  id: string;
  url: string;
  kind: RepoKind;
  source: RepoSource;
  externalId: string | null;
  createdBy: string;
  createdAt: number;
  score?: number;
  votes?: number;
}

export interface PostRepoResult {
  repo: DiscoveryRepo;
  duplicate: boolean;
}
