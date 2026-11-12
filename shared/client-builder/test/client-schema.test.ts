import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { validateClientBuildManifest } from "@roster-lock/smart-contract-client-builder";
import { buildClientZip, makeClientZip, manifest } from "@roster-lock/smart-contract-test-client/client";

function schema(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("client manifest schemas", () => {
  it("accepts a valid submission and rejects unknown/unsafe fields", () => {
    const validator = new Validator(
      schema("shared/client-builder/schema/client-submission.schema.json"),
      "2020-12",
      false,
    );
    expect(validator.validate(manifest()).valid).toBe(true);
    expect(
      validator.validate({ ...manifest(), scripts: { postinstall: "x" } }).valid,
    ).toBe(false);
    expect(
      validator.validate({ ...manifest(), dependencies: { x: "workspace:*" } }).valid,
    ).toBe(false);
  });

  it("accepts the build manifest produced by the pipeline", async () => {
    const zip = makeClientZip({
      "src/client.js": `
        export default function createClient() {
          const root = document.createElement("div");
          root.textContent = "hello";
          return root;
        }
      `,
    }, { entry: "src/client.js", framework: "vanilla" });
    const result = await buildClientZip(zip);
    const validator = new Validator(
      schema("shared/client-builder/schema/client-build-manifest.schema.json"),
      "2020-12",
      false,
    );
    const validation = validator.validate(result.published.manifest);
    expect(validation.valid).toBe(true);
    expect(validateClientBuildManifest(result.published.manifest)).toBe(
      result.published.manifest,
    );
    expect(result.published.manifest.buildId).toMatch(/^b_[a-f0-9]{32}$/);
  });
});
