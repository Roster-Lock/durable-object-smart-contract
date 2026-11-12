export type RepoKind = "roster-environment" | "matchmaker";
export type RepoSource = "github" | "gitlab" | "other";

/** The authenticated user passed into discovery endpoints by the Hono adapter. */
export interface DiscoveryUser {
  userId: string;
  isAdmin: boolean;
  githubConnection?: {
    login: string;
    id?: number;
  };
}

export type BuildStatus = "pending" | "building" | "ready" | "failed";

export type UsageStatus = "active" | "revoked" | "banned";

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

export interface DiscoveryCommit {
  id: string;
  repoId: string;
  commit: string;
  buildStatus: BuildStatus;
  /** Link to the review record; approval state is derived from it, not stored. */
  reviewedVersionId: string | null;
  /** Derived from the review record. */
  approved: boolean;
  approvedBy: string | null;
  approvedAt: number | null;
  /** Derived from the review record. */
  banned: boolean;
  bannedBy: string | null;
  bannedAt: number | null;
  banReason: string | null;
  dataClearedAt: number | null;
  entry: string | null;
  sourceHash: string | null;
  artifactKey: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CommitSource {
  /** Entry file → contents, for every file needed to build. */
  files: Record<string, string>;
  license?: string;
}

export interface FetchedCommit extends CommitSource {
  repoUrl: string;
  commit: string;
  entry: string;
}

export interface BuildArtifact {
  entry: string;
  code: string;
  sourceHash: string;
  warnings?: string[];
}

export interface RepoSourceFetcher {
  fetch(repoUrl: string, commit: string, entry?: string): Promise<FetchedCommit>;
}

export interface CommitBuilder {
  build(source: FetchedCommit): Promise<BuildArtifact>;
}

export interface ArtifactStore {
  put(key: string, body: string, contentType?: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface MatchmakerDataCleaner {
  clear(namespace: string): Promise<void>;
}

export interface DiscoveryNotifier {
  commitBanned(commit: DiscoveryCommit, rosterIds: string[]): Promise<void>;
  /** Optional: a newer commit is available for a repo already in use. */
  repoUpdated?(
    repo: DiscoveryRepo,
    commit: DiscoveryCommit,
    rosterIds: string[],
  ): Promise<void>;
}
