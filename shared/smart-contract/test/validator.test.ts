import { describe, expect, it } from "vitest";
import { validateJavaScript } from "@roster-lock/smart-contract/validator";

const codes = (source: string, mode: "source" | "bundle" = "source") =>
  validateJavaScript(source, { mode }).issues.map((issue) => issue.code);

describe("shared JavaScript validator", () => {
  it("allows the platform imports in source mode", () => {
    const source = `
      import { ContractDefinition } from "@roster-lock/living-roster";
      import { MatchResult } from "@roster-lock/deployed-types";
      defineContract({ endpoints: {} });
    `;
    expect(validateJavaScript(source).ok).toBe(true);
  });

  it("rejects unknown imports and relative imports in bundle mode", () => {
    expect(codes(`import fs from "node:fs";`)).toContain("import.forbidden");
    expect(codes(`import x from "./other.js";`, "source")).not.toContain("import.forbidden");
    expect(codes(`import x from "./other.js";`, "bundle")).toContain("source.parse_error");
  });

  it("rejects dynamic import, require and eval", () => {
    expect(codes(`import("node:fs")`)).toContain("import.dynamic");
    expect(codes(`require("fs")`)).toContain("import.require");
    expect(codes(`eval("1")`)).toContain("eval.dynamic");
    expect(codes(`new Function("return 1")`)).toContain("eval.constructor");
  });

  it("blacklists network and runtime globals", () => {
    const source = `fetch("https://example.com"); setTimeout(() => {}, 1); process.exit(1);`;
    const result = validateJavaScript(source);
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.code === "global.forbidden").length).toBe(3);
  });

  it("accepts a clean final bundle", () => {
    const source = `defineContract({ endpoints: { ping: { run: async () => "pong" } } });`;
    expect(validateJavaScript(source, { mode: "bundle" }).ok).toBe(true);
  });
});
