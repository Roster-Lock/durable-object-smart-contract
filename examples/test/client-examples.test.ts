import { describe, expect, it } from "vitest";
import { createClientDocument, createClientCsp } from "@roster-lock/smart-contract-client-host";
import { buildClientZip, exampleZip } from "@roster-lock/smart-contract-test-client/client";

describe("example clients build and integrate with the runtime", () => {
  it("builds examples/matchmaker-pool/client.tsx to an import-free artifact", async () => {
    const zip = exampleZip("examples/matchmaker-pool", "examples/matchmaker-pool/client.json", [
      "client.tsx",
    ]);
    const result = await buildClientZip(zip);
    expect(result.published.manifest.name).toBe("matchmaker-pool-client");
    expect(result.published.bundle).toContain("__rosterClientFactory");
    expect(result.published.bundle).not.toMatch(/\bimport\s/);
    expect(result.published.bundle).not.toMatch(/\bexport\s/);
    expect(result.published.manifest.assets).toEqual([]);
  });

  it("builds examples/living-roster/client.tsx (React + RJSF) under the default budgets", async () => {
    const zip = exampleZip("examples/living-roster", "examples/living-roster/client.json", [
      "client.tsx",
    ]);
    const result = await buildClientZip(zip);
    expect(result.published.manifest.name).toBe("living-roster-client");
    expect(result.published.manifest.bundleBytes).toBeLessThanOrEqual(1_000_000);
    expect(result.published.manifest.preOptimizationBytes).toBeLessThanOrEqual(2_500_000);
    expect(result.published.manifest.packages.map((pkg) => pkg.name)).toContain("@rjsf/core");
  });

  it("produces a static CSP document for the immutable artifact", async () => {
    const zip = exampleZip("examples/matchmaker-pool", "examples/matchmaker-pool/client.json", [
      "client.tsx",
    ]);
    const result = await buildClientZip(zip);
    const buildId = result.published.manifest.buildId;
    const base = `https://client-artifacts.test/client-builds/${buildId}`;
    const styles = result.published.manifest.assets
      .filter((asset) => asset.contentType === "text/css")
      .map((asset) => `${base}/${asset.key}`);
    const html = createClientDocument({
      bundleUrl: `${base}/bundle.js`,
      runtimeScriptUrl: "https://client-artifacts.test/client-runtime.js",
      styles,
      csp: createClientCsp(),
    });
    expect(html).toContain(`${base}/bundle.js`);
    expect(html).not.toMatch(/<script>[^<]/);
    expect(html).toContain("connect-src &#39;none&#39;");
  });
});
