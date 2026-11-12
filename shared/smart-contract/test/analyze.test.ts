import { describe, expect, it } from "vitest";
import { analyzeContract } from "../src/analyze.js";

function codes(source: string): string[] {
  return analyzeContract(source).issues.map((issue) => issue.code);
}

const VALID = `
defineContract({
  name: "roster",
  storage: {
    roster: { kind: "array", item: { type: "string" } },
  },
  endpoints: {
    add: {
      gasLimit: 100000,
      run: async (input, ctx) => {
        await ctx.storage.roster.addToTop([input.pieceId]);
        return await ctx.storage.roster.length();
      },
    },
  },
});
`;

describe("analyzeContract", () => {
  it("accepts a normal contract", () => {
    const result = analyzeContract(VALID);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.nodes).toBeGreaterThan(10);
  });

  it("rejects network globals", () => {
    const result = analyzeContract(`fetch("https://example.com");`);
    expect(result.ok).toBe(false);
    expect(codes(`fetch("x")`)).toContain("global.forbidden");
    expect(codes(`new WebSocket("ws://x")`)).toContain("global.forbidden");
    expect(codes(`new XMLHttpRequest()`)).toContain("global.forbidden");
    expect(codes(`globalThis.fetch("x")`)).toContain("global.forbidden");
    expect(result.issues[0]?.severity).toBe("error");
  });

  it("does not flag a member property with a forbidden name", () => {
    expect(codes(`const api = { fetch: 1 }; api.fetch;`)).not.toContain(
      "global.forbidden",
    );
  });

  it("rejects dynamic import and sandbox internals", () => {
    expect(codes(`import("x")`)).toContain("module.dynamic_import");
    expect(codes(`__ds_host.valueGet("x")`)).toContain("global.reserved");
  });

  it("rejects timers", () => {
    expect(codes(`setTimeout(() => {}, 10)`)).toContain("global.unavailable");
  });

  it("warns about unconditional loops but only blocks nothing", () => {
    const spin = analyzeContract(`while (true) {}`);
    expect(spin.ok).toBe(true);
    expect(spin.issues.map((issue) => issue.code)).toContain("loop.unbounded");

    const forEver = analyzeContract(`for (;;) { }`);
    expect(forEver.issues.map((issue) => issue.code)).toContain("loop.unbounded");

    const withBreak = analyzeContract(`while (true) { break; }`);
    expect(withBreak.issues.map((issue) => issue.code)).not.toContain("loop.unbounded");

    const withAwait = analyzeContract(`async function go() { while (true) { await x(); } }`);
    expect(withAwait.issues.map((issue) => issue.code)).not.toContain("loop.unbounded");

    const nestedBreak = analyzeContract(
      `while (true) { for (;;) { break; } }`,
    );
    expect(nestedBreak.issues.map((issue) => issue.code)).toContain("loop.unbounded");
  });

  it("warns about non-determinism", () => {
    expect(codes(`Math.random()`)).toContain("nondeterminism.random");
    expect(codes(`Date.now()`)).toContain("nondeterminism.clock");
    expect(codes(`new Date()`)).toContain("nondeterminism.clock");
    expect(codes(`eval("1")`)).toContain("eval.dynamic");
  });

  it("requires async handlers and awaited effects", () => {
    const source = (body: string, options: { asyncRun?: boolean } = {}) => `
      defineContract({
        storage: { roster: { kind: "array", item: { type: "string" } } },
        endpoints: {
          add: {
            run: ${options.asyncRun === false ? "" : "async "}(_i, ctx) => {
              ${body}
            },
          },
        },
      });
    `;

    const unawaited = analyzeContract(source(`ctx.storage.roster.addToTop(["x"]);`));
    expect(unawaited.ok).toBe(false);
    expect(unawaited.issues.map((issue) => issue.code)).toContain(
      "promise.unawaited_effect",
    );

    const viaHandle = analyzeContract(
      source(`const roster = ctx.storage.roster; roster.length();`),
    );
    expect(viaHandle.issues.map((issue) => issue.code)).toContain(
      "promise.unawaited_effect",
    );

    const viaAlias = analyzeContract(
      source(`const storage = ctx.storage; storage.roster.length();`),
    );
    expect(viaAlias.issues.map((issue) => issue.code)).toContain(
      "promise.unawaited_effect",
    );

    const viaThis = analyzeContract(
      source(`this.storage.roster.length();`),
    );
    expect(viaThis.issues.map((issue) => issue.code)).toContain(
      "promise.unawaited_effect",
    );

    const emit = analyzeContract(source(`ctx.emit("Ping", {});`));
    expect(emit.issues.map((issue) => issue.code)).toContain(
      "promise.unawaited_effect",
    );

    const awaited = analyzeContract(
      source(
        `await ctx.storage.roster.addToTop(["x"]); return await ctx.storage.roster.length();`,
      ),
    );
    expect(awaited.ok).toBe(true);

    const returned = analyzeContract(source(`return ctx.storage.roster.length();`));
    expect(returned.ok).toBe(true);

    const parallel = analyzeContract(
      source(`await Promise.all([ctx.storage.roster.length(), ctx.storage.roster.length()]);`),
    );
    expect(parallel.ok).toBe(true);

    const chained = analyzeContract(
      source(`await ctx.storage.roster.length().then((n) => n);`),
    );
    expect(chained.ok).toBe(false);
    expect(chained.issues.map((issue) => issue.code)).toContain(
      "promise.chained_effect",
    );

    const sync = analyzeContract(source(`return null;`, { asyncRun: false }));
    expect(sync.ok).toBe(false);
    expect(sync.issues.map((issue) => issue.code)).toContain("function.not_async");
  });

  it("reports parse errors with a location", () => {
    const result = analyzeContract(`defineContract({`);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((entry) => entry.code === "source.parse_error");
    expect(issue?.line).toBeGreaterThan(0);
    expect(issue?.column).toBeGreaterThan(0);
  });

  it("rejects oversized and empty sources", () => {
    expect(analyzeContract("   ").ok).toBe(false);
    expect(analyzeContract("x".repeat(300_000)).issues[0]?.code).toBe("source.too_large");
  });
});
