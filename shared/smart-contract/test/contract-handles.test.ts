import { describe, expect, it } from "vitest";
import { ContractService } from "../src/contract.js";
import type { ContractConfig } from "../src/types.js";
import { freshTestDatabase } from "@roster-lock/smart-contract-test-client";

const MMR = `
defineContract({
  name: "mmr",
  version: "1.0.0",
  storage: {
    ratings: {
      kind: "map",
      key: { type: "string" },
      value: { kind: "value", schema: { type: "integer" } },
    },
  },
  endpoints: {
    set: {
      run: async (input, ctx) => {
        await ctx.storage.ratings.set(input.player, input.rating);
        return input.rating;
      },
    },
    getRating: {
      run: async (input, ctx) => (await ctx.storage.ratings.get(input.player)) ?? null,
    },
    contractOnly: {
      access: "contract",
      run: async () => "contract-ok",
    },
    humanOnly: {
      access: "human",
      run: async () => "human-ok",
    },
  },
});
`;

const VIEWER = `
defineContract({
  name: "viewer",
  version: "1.0.0",
  endpoints: {
    read: {
      run: async (_input, ctx) => {
        return (await ctx.contracts.mmr.storage.ratings.get("alice")) ?? null;
      },
    },
    write: {
      run: async (_input, ctx) => {
        await ctx.contracts.mmr.storage.ratings.set("alice", 1);
      },
    },
    callRead: {
      run: async (_input, ctx) => {
        return await ctx.contracts.mmr.call("getRating", { player: "alice" });
      },
    },
    callWrite: {
      run: async (_input, ctx) => {
        return await ctx.contracts.mmr.call("set", { player: "alice", rating: 1600 });
      },
    },
    callHumanOnly: {
      run: async (_input, ctx) => {
        return await ctx.contracts.mmr.call("humanOnly", {});
      },
    },
    callContractOnly: {
      run: async (_input, ctx) => {
        return await ctx.contracts.mmr.call("contractOnly", {});
      },
    },
    readCallWrite: {
      mutates: false,
      run: async (_input, ctx) => {
        await ctx.contracts.mmr.call("set", { player: "alice", rating: 1700 });
      },
    },
  },
});
`;

const config: Partial<ContractConfig> = {
  defaultGasLimit: 1_000_000,
  maxGasPerCall: 2_000_000,
  minGasLimit: 10_000,
  deployGasLimit: 5_000_000,
  hardTimeoutMs: 2_000,
};

describe("named contract handles", () => {
  it("reads sibling storage read-only and rejects writes", async () => {
    const db = await freshTestDatabase();
    const make = (contractId: string) =>
      new ContractService({
        contractId,
        rosterId: "roster-1",
        openDb: db.open,
        config,
      });
    const mmr = make("mmr");
    const viewer = make("viewer");
    await mmr.initialize();
    await viewer.initialize();
    await mmr.credit("alice", 100_000);
    await viewer.credit("alice", 100_000);

    await mmr.deploy({
      ownerId: "alice",
      name: "MMR",
      handle: "mmr",
      version: "1.0.0",
      source: MMR,
    });
    await mmr.call({
      callerId: "alice",
      endpoint: "set",
      input: { player: "alice", rating: 1500 },
    });

    await viewer.deploy({
      ownerId: "alice",
      name: "Viewer",
      handle: "viewer",
      version: "1.0.0",
      source: VIEWER,
    });

    const read = await viewer.call({ callerId: "alice", endpoint: "read" });
    expect(read.result).toBe(1500);

    const called = await viewer.call({ callerId: "alice", endpoint: "callRead" });
    expect(called.result).toBe(1500);

    const written = await viewer.call({ callerId: "alice", endpoint: "callWrite" });
    expect(written.result).toBe(1600);
    const afterWrite = await mmr.call({
      callerId: "alice",
      endpoint: "getRating",
      input: { player: "alice" },
    });
    expect(afterWrite.result).toBe(1600);

    const contractOnly = await viewer.call({
      callerId: "alice",
      endpoint: "callContractOnly",
    });
    expect(contractOnly.result).toBe("contract-ok");

    await expect(
      viewer.call({ callerId: "alice", endpoint: "write" }),
    ).rejects.toThrow(/read-only/);
    await expect(
      viewer.call({ callerId: "alice", endpoint: "callHumanOnly" }),
    ).rejects.toThrow(/human/);
    await expect(
      viewer.call({ callerId: "alice", endpoint: "readCallWrite" }),
    ).rejects.toThrow(/read-only/);
  });

  it("rejects duplicate handles in a roster", async () => {
    const db = await freshTestDatabase();
    const make = (contractId: string) =>
      new ContractService({
        contractId,
        rosterId: "roster-1",
        openDb: db.open,
        config,
      });
    const a = make("a");
    const b = make("b");
    await a.initialize();
    await b.initialize();
    await a.deploy({
      ownerId: "alice",
      name: "A",
      handle: "shared",
      version: "1.0.0",
      source: MMR,
    });
    await expect(
      b.deploy({
        ownerId: "alice",
        name: "B",
        handle: "shared",
          version: "1.0.0",
        source: VIEWER,
      }),
    ).rejects.toThrow(/handle/);
  });
});
