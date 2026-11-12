import { Hono, type Context } from "hono";
import {
  createDiscoveryApp,
  type DiscoveryApi,
  type DiscoveryAppOptions,
  type DiscoveryUser,
} from "@roster-lock/discovery";
import type { ShareApprovedWorkflow } from "./workflow.js";

export type ShareApprovedAppOptions = DiscoveryAppOptions;

/**
 * The example marketplace app: discovery's catalog routes plus admin review
 * and roster adoption. The workflow is injected so the app can be tested with
 * fakes and mounted with real adapters in production.
 */
export function createShareApprovedApp(
  workflow: ShareApprovedWorkflow,
  discovery: DiscoveryApi,
  options: ShareApprovedAppOptions = {},
): Hono {
  const app = createDiscoveryApp(discovery, options);
  const getUser = options.getUser ?? defaultUser;

  app.post("/commits/approve", async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: "authentication is required" }, 401);
    if (!user.isAdmin) return c.json({ error: "admin permission is required" }, 403);
    const body = await c.req.json<{
      repoUrl: string;
      commit: string;
      entry?: string;
      reason?: string;
    }>();
    const result = await workflow.approveCommit({
      repoUrl: body.repoUrl,
      commit: body.commit,
      entry: body.entry,
      reason: body.reason,
      reviewer: user.userId,
    });
    return c.json(result);
  });

  app.post("/commits/:id/ban", async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: "authentication is required" }, 401);
    if (!user.isAdmin) return c.json({ error: "admin permission is required" }, 403);
    const body = await c
      .req.json<{ reason?: string; clearData?: boolean }>()
      .catch(() => ({ reason: undefined, clearData: undefined }));
    const result = await workflow.banCommit({
      commitId: c.req.param("id"),
      reviewer: user.userId,
      reason: body.reason,
      clearData: body.clearData,
    });
    return c.json(result);
  });

  app.post("/rosters/:rosterId/adopt", async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: "authentication is required" }, 401);
    const body = await c.req.json<{
      repoUrl: string;
      commit: string;
      entry?: string;
      dataNamespace?: string;
      config?: Record<string, unknown>;
    }>();
    const result = await workflow.adoptCommit({
      rosterId: c.req.param("rosterId"),
      repoUrl: body.repoUrl,
      commit: body.commit,
      entry: body.entry,
      dataNamespace: body.dataNamespace,
      config: body.config,
    });
    return c.json(result, 201);
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
