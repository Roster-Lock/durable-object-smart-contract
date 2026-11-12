import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_BUDGETS,
  readClientArchive,
  validateSubmissionManifest,
  type ClientBudgetConfig,
} from "@roster-lock/smart-contract-client-builder";
import { createZip } from "@roster-lock/smart-contract-client-builder";
import { makeClientZip, manifest } from "@roster-lock/smart-contract-test-client/client";

function budgets(overrides: Partial<ClientBudgetConfig>): ClientBudgetConfig {
  return { ...DEFAULT_CLIENT_BUDGETS, ...overrides };
}

function codes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    const diagnostics = (error as { diagnostics?: Array<{ code: string }> }).diagnostics ?? [];
    return diagnostics.map((item) => item.code);
  }
  return [];
}

describe("custom client archive validation", () => {
  it("accepts one manifest, one entrypoint and source/assets", () => {
    const zip = makeClientZip({
      "src/client.tsx": "export default () => document.createElement('div');",
      "assets/logo.svg": "<svg></svg>",
    });
    const archive = readClientArchive(zip);
    expect(archive.entry).toBe("src/client.tsx");
    expect(archive.manifest.name).toBe("test-client");
    expect(archive.files.has("src/client.tsx")).toBe(true);
    expect(archive.assets.has("assets/logo.svg")).toBe(true);
    expect(archive.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects traversal, symlinks, too many files and oversized archives", () => {
    const traversal = createZip(
      [
        { name: "../evil.ts", data: "export default 1" },
        { name: "client.json", data: JSON.stringify(manifest()) },
      ],
      { unsafeNames: true },
    );
    expect(codes(() => readClientArchive(traversal))).toContain("archive.path_traversal");

    const symlink = createZip([
      { name: "src/client.tsx", data: "export default 1", mode: 0o120777 },
      { name: "client.json", data: JSON.stringify(manifest()) },
    ]);
    expect(codes(() => readClientArchive(symlink))).toContain("archive.symlink");

    const three = makeClientZip({
      "src/client.tsx": "export default 1",
      "src/extra.ts": "export const x = 1",
    });
    expect(
      codes(() => readClientArchive(three, budgets({ maxArchiveFiles: 1 }))),
    ).toContain("archive.too_many_files");

    expect(
      codes(() => readClientArchive(three, budgets({ maxArchiveBytes: 8 }))),
    ).toContain("archive.too_large");

    expect(
      codes(() => readClientArchive(three, budgets({ maxArchiveFileBytes: 4 }))),
    ).toContain("archive.file_too_large");
  });

  it("reads deflated entries", () => {
    const zip = createZip([
      { name: "client.json", data: JSON.stringify(manifest()), compress: true },
      { name: "src/client.tsx", data: "export default 1;", compress: true },
    ]);
    expect(readClientArchive(zip).entry).toBe("src/client.tsx");
  });

  it("accepts manifest.json as an alias for the single root manifest", () => {
    const zip = createZip([
      { name: "manifest.json", data: JSON.stringify(manifest()) },
      { name: "src/client.tsx", data: "export default 1" },
    ]);
    expect(readClientArchive(zip).manifest.name).toBe("test-client");
  });

  it("rejects multiple manifests, package scripts and unsupported extensions", () => {
    const twoManifests = createZip([
      { name: "client.json", data: JSON.stringify(manifest()) },
      { name: "nested/client.json", data: JSON.stringify(manifest()) },
      { name: "src/client.tsx", data: "export default 1" },
    ]);
    expect(codes(() => readClientArchive(twoManifests))).toContain("archive.multiple_manifests");

    const withPackage = createZip([
      { name: "client.json", data: JSON.stringify(manifest()) },
      { name: "src/client.tsx", data: "export default 1" },
      { name: "package.json", data: "{}" },
    ]);
    expect(codes(() => readClientArchive(withPackage))).toContain("archive.build_scripts");

    const html = createZip([
      { name: "client.json", data: JSON.stringify(manifest()) },
      { name: "src/client.tsx", data: "export default 1" },
      { name: "index.html", data: "<html></html>" },
    ]);
    expect(codes(() => readClientArchive(html))).toContain("archive.extension");

    const missingEntry = createZip([
      { name: "client.json", data: JSON.stringify(manifest({ entry: "src/nope.tsx" })) },
      { name: "src/client.tsx", data: "export default 1" },
    ]);
    expect(codes(() => readClientArchive(missingEntry))).toContain("archive.entry_missing");
  });

  it("validates the submission manifest and dependency specifiers", () => {
    expect(() =>
      validateSubmissionManifest({
        ...manifest(),
        dependencies: { "@scope/pkg": "workspace:*" },
      }),
    ).toThrow();

    expect(() =>
      validateSubmissionManifest({
        ...manifest(),
        schemaVersion: 2,
        framework: "flutter",
      }),
    ).toThrow();

    const valid = validateSubmissionManifest({
      ...manifest(),
      dependencies: { react: "^18.3.1", "@scope/pkg": "1.2.3" },
    });
    expect(valid.dependencies).toEqual({ "@scope/pkg": "1.2.3", react: "^18.3.1" });
  });
});
