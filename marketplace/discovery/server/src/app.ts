import { Hono, type Context } from "hono";
import type { DiscoveryApi } from "./api.js";
import type { DiscoveryUser, RepoKind } from "./types.js";

export interface DiscoveryAppOptions {
  /**
   * The worker supplies the authenticated user. Endpoints themselves never
   * read headers; this adapter is the only request-aware layer.
   */
  getUser?: (c: Context) => DiscoveryUser | undefined;
}

/**
 * Hono routes for discovery. The endpoint functions take a `DiscoveryUser`;
 * this adapter only parses HTTP and resolves that user.
 */
export function createDiscoveryApp(api: DiscoveryApi, options: DiscoveryAppOptions = {}): Hono {
  const app = new Hono();
  const getUser = options.getUser ?? defaultUser;

  app.get("/repos", async (c) => {
    const repos = await api.listRepos({
      kind: (c.req.query("kind") as RepoKind | undefined) ?? undefined,
      query: c.req.query("query"),
      sort: c.req.query("sort") === "new" ? "new" : "score",
      limit: Number(c.req.query("limit") ?? "50"),
    });
    return c.json({ repos });
  });

  app.post("/repos", async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: "authentication is required" }, 401);
    const body = await c.req.json<{
      url: string;
      kind: RepoKind;
      source?: "github" | "gitlab" | "other";
      externalId?: string;
    }>();
    const result = await api.postRepo(user, {
      url: body.url,
      kind: body.kind,
      source: body.source,
      externalId: body.externalId,
    });
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.post("/repos/:id/vote", async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: "authentication is required" }, 401);
    const body = await c.req.json<{ value: number }>();
    if (body.value !== 1 && body.value !== -1) {
      return c.json({ error: "value must be 1 or -1" }, 400);
    }
    const result = await api.voteRepo(user, {
      repoId: c.req.param("id"),
      value: body.value,
    });
    return c.json(result);
  });

  return app;
}

function defaultUser(c: Context): DiscoveryUser | undefined {
  const userId = c.req.header("x-user-id");
  if (!userId) return undefined;
  const login = c.req.header("x-github-login");
  return {
    userId,
    isAdmin: c.req.header("x-user-admin") === "true",
    githubConnection: login ? { login } : undefined,
  };
}
