import { describe, expect, it } from "vitest";
import { DiscoveryClient, repoDiscussionUrl } from "@roster-lock/discovery/client";

describe("discovery client", () => {
  it("builds server requests without the server package", async () => {
    const urls: string[] = [];
    const client = new DiscoveryClient({
      baseUrl: "https://discovery.test",
      userId: "alice",
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ repos: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await client.listRepos({ kind: "matchmaker", sort: "new" });
    expect(result.repos).toEqual([]);
    expect(urls[0]).toContain("/repos?kind=matchmaker&sort=new");
    expect(repoDiscussionUrl({ url: "github.com/example/repo", source: "github" })).toBe(
      "https://github.com/example/repo/issues",
    );
    expect(repoDiscussionUrl({ url: "gitlab.com/example/repo", source: "gitlab" })).toBe(
      "https://gitlab.com/example/repo/-/issues",
    );
  });
});
