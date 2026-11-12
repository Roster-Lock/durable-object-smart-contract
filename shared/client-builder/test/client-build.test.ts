import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_BUDGETS } from "@roster-lock/smart-contract-client-builder";
import { manifest } from "@roster-lock/smart-contract-test-client/client";
import {
  buildClientZip,
  makeClientZip,
  memoryDeps,
  StaticPackageProvider,
} from "@roster-lock/smart-contract-test-client/client";

describe("client build pipeline", () => {
  it("builds and validates a TSX/React client", async () => {
    const zip = makeClientZip(
      {
        "src/client.tsx": `
          import { createRoot } from "react-dom/client";
          export default function createClient(api: { session: { userId?: string } }) {
            const root = document.createElement("div");
            createRoot(root).render(<div>hello {api.session.userId ?? "guest"}</div>);
            return root;
          }
        `,
      },
      { framework: "react", dependencies: { react: "18.3.1", "react-dom": "18.3.1" } },
    );
    const result = await buildClientZip(zip);
    expect(result.published.manifest.framework).toBe("react");
    expect(result.published.manifest.bundleBytes).toBeGreaterThan(0);
    expect(result.published.bundle).toContain("__rosterClientFactory");
    expect(result.published.bundle).not.toMatch(/\bimport\s/);
    expect(result.published.bundle).not.toMatch(/\bexport\s/);
    expect(result.published.manifest.preOptimizationBytes).toBeGreaterThan(
      result.published.manifest.bundleBytes,
    );
    expect(result.published.record.status).toBe("ready");
  });

  it("builds a Vue SFC through the framework adapter", async () => {
    const zip = makeClientZip(
      {
        "src/client.vue": `
          <script setup lang="ts">
          import { ref } from "vue";
          const message = ref("hello");
          </script>
          <template><div>{{ message }}</div></template>
        `,
      },
      {
        entry: "src/client.vue",
        framework: "vue",
        dependencies: { vue: "3.5.44" },
      },
    );
    const result = await buildClientZip(zip);
    expect(result.published.bundle).toContain("__rosterClientFactory");
    expect(result.published.manifest.framework).toBe("vue");
  });

  it("tree-shakes unused package exports", async () => {
    const provider = new StaticPackageProvider({
      heavy: {
        version: "1.0.0",
        files: {
          "index.js": `
            export const used = "USED_VALUE";
            export const unused = "UNUSED_MARKER_SHOULD_DISAPPEAR";
            export function reallyUnused() { return "UNUSED_FUNCTION_MARKER"; }
          `,
          "package.json": JSON.stringify({ name: "heavy", version: "1.0.0", main: "index.js" }),
        },
      },
    });
    const zip = makeClientZip(
      {
        "src/client.js": `
          import { used } from "heavy";
          export default function createClient() {
            const node = document.createElement("div");
            node.textContent = used;
            return node;
          }
        `,
      },
      { entry: "src/client.js", framework: "vanilla", dependencies: { heavy: "1.0.0" } },
    );
    const result = await buildClientZip(zip, { provider });
    expect(result.published.bundle).not.toContain("UNUSED_MARKER_SHOULD_DISAPPEAR");
    expect(result.published.bundle).not.toContain("UNUSED_FUNCTION_MARKER");
    expect(result.published.manifest.bundleBytes).toBeLessThan(
      result.published.manifest.preOptimizationBytes,
    );
  });

  it("enforces the default raw-byte budgets and both overrides", async () => {
    expect(DEFAULT_CLIENT_BUDGETS.maxPreOptimizationBytes).toBe(2_500_000);
    expect(DEFAULT_CLIENT_BUDGETS.maxBundleBytes).toBe(1_000_000);
    const zip = makeClientZip({
      "src/client.js": `
        export default function createClient() {
          const node = document.createElement("div");
          node.textContent = "${"x".repeat(500)}";
          return node;
        }
      `,
    }, { entry: "src/client.js", framework: "vanilla" });

    await expect(
      buildClientZip(zip, { budgets: { maxPreOptimizationBytes: 100 } }),
    ).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: "budget.pre_optimization" })] });
    await expect(
      buildClientZip(zip, { budgets: { maxBundleBytes: 50 } }),
    ).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: "budget.bundle" })] });
  });

  it("lets a manifest lower its own budgets", async () => {
    const zip = makeClientZip(
      {
        "src/client.js": `
          export default function createClient() {
            return document.createElement("div");
          }
        `,
      },
      { entry: "src/client.js", framework: "vanilla" },
      {
        ...manifest({
          entry: "src/client.js",
          framework: "vanilla",
          budgets: { maxBundleBytes: 10 },
        }),
      },
    );
    await expect(buildClientZip(zip)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "budget.bundle" })],
    });
  });

  it("rejects innerHTML in authored source even though library bundles may use it", async () => {
    const zip = makeClientZip(
      {
        "src/client.js": `
          export default function createClient() {
            const node = document.createElement("div");
            node.innerHTML = "<b>unsafe</b>";
            return node;
          }
        `,
      },
      { entry: "src/client.js", framework: "vanilla" },
    );
    await expect(buildClientZip(zip)).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "client.inner_html" }),
      ]),
    });
  });

  it("rejects forbidden post-bundle APIs", async () => {
    const zip = makeClientZip(
      {
        "src/client.js": `
          export default function createClient() {
            fetch("https://example.com");
            return document.createElement("div");
          }
        `,
      },
      { entry: "src/client.js", framework: "vanilla" },
    );
    await expect(buildClientZip(zip)).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "client.forbidden_api" }),
      ]),
    });
  });
});
