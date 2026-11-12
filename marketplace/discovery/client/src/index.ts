import type { DiscoveryRepo, PostRepoResult, RepoKind, RepoSource } from "./types.js";

export type { DiscoveryRepo, PostRepoResult, RepoKind, RepoSource } from "./types.js";

export interface DiscoveryClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  userId?: string;
}

/** Small HTTP client shared by the website and the local tools. */
export class DiscoveryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: DiscoveryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.userId = options.userId;
  }

  private readonly userId?: string;

  async listRepos(filter: { kind?: RepoKind; query?: string; sort?: "new" | "score" } = {}) {
    const params = new URLSearchParams();
    if (filter.kind) params.set("kind", filter.kind);
    if (filter.query) params.set("query", filter.query);
    if (filter.sort) params.set("sort", filter.sort);
    const response = await this.fetchImpl(`${this.baseUrl}/repos?${params}`);
    return (await response.json()) as { repos: DiscoveryRepo[] };
  }

  async postRepo(input: {
    url: string;
    kind: RepoKind;
    source?: RepoSource;
    externalId?: string;
  }): Promise<PostRepoResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/repos`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    return (await response.json()) as PostRepoResult;
  }

  async vote(repoId: string, value: -1 | 1): Promise<{ score: number }> {
    const response = await this.fetchImpl(`${this.baseUrl}/repos/${repoId}/vote`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ value }),
    });
    return (await response.json()) as { score: number };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.userId) headers["x-user-id"] = this.userId;
    return headers;
  }
}

/**
 * Where discussions/issues live for a repo. The client exposes this so the UI
 * can link users to the project instead of hosting comments itself.
 */
export function repoDiscussionUrl(repo: Pick<DiscoveryRepo, "url" | "source">): string {
  const base = repo.url.startsWith("http") ? repo.url : `https://${repo.url}`;
  if (repo.source === "gitlab") return `${base.replace(/\.git$/, "")}/-/issues`;
  return `${base.replace(/\.git$/, "")}/issues`;
}
