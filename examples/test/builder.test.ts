import { describe, expect, it } from "vitest";
import { buildJavaScript } from "@roster-lock/smart-contract/builder";
import { buildLivingRoster } from "../../living-roster/tools/src/build.js";
import { buildMatchmaker } from "../../match-making/tools/src/build.js";

describe("TypeScript builder", () => {
  it("compiles a typed contract to one validated script", async () => {
    const result = await buildLivingRoster({
      source: `
        import type { ContractDefinition } from "@roster-lock/living-roster";
        type Input = { name: string };
        defineContract({
          endpoints: {
            greet: {
              input: { type: "object", required: ["name"] },
              run: async (input: Input) => "hello " + input.name,
            },
          },
        });
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("defineContract");
    expect(result.bundleValidation?.ok).toBe(true);
  });

  it("compiles a typed matchmaker", async () => {
    const result = await buildMatchmaker({
      source: `
        import type { MatchmakerDefinition } from "@roster-lock/match-making";
        defineMatchmaker({
          name: "elo",
          handleMatchResult: async () => {},
          findOtherPlayers: async () => [],
        });
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("defineMatchmaker");
  });

  it("resolves runtime defineContract imports through the shim", async () => {
    const result = await buildLivingRoster({
      source: `
        import { defineContract } from "@roster-lock/living-roster";
        defineContract({ endpoints: { ping: { run: async () => "pong" } } });
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("__rosterDefineContract");
  });

  it("resolves runtime defineMatchmaker imports through the shim", async () => {
    const result = await buildMatchmaker({
      source: `
        import { defineMatchmaker } from "@roster-lock/match-making";
        defineMatchmaker({
          name: "elo",
          handleMatchResult: async () => {},
          findOtherPlayers: async () => [],
        });
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("__rosterDefineMatchmaker");
  });

  it("allows TypeScript decorators in the authoring source", async () => {
    const result = await buildLivingRoster({
      source: `
        function marker() {
          return (value: unknown) => value;
        }
        @marker()
        class Placeholder {}
        defineContract({ endpoints: { ping: { run: async () => new Placeholder() } } });
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("Placeholder");
  });

  it("rejects forbidden source before bundling", async () => {
    const result = await buildJavaScript({
      source: `fetch("https://example.com");`,
    });
    expect(result.ok).toBe(false);
    expect(result.sourceValidation.issues.map((issue) => issue.code)).toContain(
      "global.forbidden",
    );
  });
});
