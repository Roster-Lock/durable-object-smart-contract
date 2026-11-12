import { beforeEach, describe, expect, it } from "vitest";
import type { ContractService } from "../src/contract.js";
import { makeService } from "@roster-lock/smart-contract-test-client";

const SOURCE = `
defineContract({
  name: "storage-test",
  version: "1.0.0",
  storage: {
    config: {
      kind: "value",
      schema: {
        type: "object",
        required: ["quorum"],
        properties: { quorum: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
      initial: { quorum: 3 },
    },
    roster: {
      kind: "array",
      maxItems: 10,
      item: { type: "string", minLength: 1 },
    },
    weights: {
      kind: "map",
      key: { type: "string" },
      value: { type: "integer", minimum: 0 },
    },
    votes: {
      kind: "map",
      key: { type: "string" },
      value: {
        kind: "map",
        key: { type: "string" },
        value: {
          kind: "value",
          schema: {
            type: "object",
            required: ["support"],
            properties: { support: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
    },
    rounds: {
      kind: "array",
      item: { kind: "array", item: { type: "string" } },
    },
  },
  endpoints: {
    config: { run: async (_i, ctx) => (await ctx.storage.config.get()) ?? null },
    setConfig: {
      run: async (input, ctx) => {
        await ctx.storage.config.set(input);
        return await ctx.storage.config.get();
      },
    },
    roster: { run: async (_i, ctx) => ctx.storage.roster.slice(0, 100) },
    addTop: {
      run: async (input, ctx) => {
        await ctx.storage.roster.addToTop(input.items);
        return await ctx.storage.roster.length();
      },
    },
    addBottom: {
      run: async (input, ctx) => {
        await ctx.storage.roster.addToBottom(input.items);
        return await ctx.storage.roster.length();
      },
    },
    insert: {
      run: async (input, ctx) => {
        await ctx.storage.roster.insert(input.index, input.items);
        return ctx.storage.roster.slice(0, 100);
      },
    },
    remove: { run: async (input, ctx) => ctx.storage.roster.removeAt(input.index, input.count) },
    set: {
      run: async (input, ctx) => {
        await ctx.storage.roster.set(input.index, input.value);
        return ctx.storage.roster.slice(0, 100);
      },
    },
    move: {
      run: async (input, ctx) => {
        await ctx.storage.roster.move(input.from, input.to);
        return ctx.storage.roster.slice(0, 100);
      },
    },
    vote: {
      run: async (input, ctx) => {
        const votes = await ctx.storage.votes.get(input.proposal);
        await votes.set(input.voter, input.vote);
        return await votes.size();
      },
    },
    votes: {
      run: async (input, ctx) => {
        const votes = await ctx.storage.votes.get(input.proposal);
        const out = [];
        for await (const [voter, value] of votes) out.push([voter, value]);
        return out;
      },
    },
    newRound: {
      run: async (_i, ctx) => {
        const round = await ctx.storage.rounds.push();
        await round.push("a", "b");
        return await round.slice(0, 10);
      },
    },
    rounds: {
      run: async (_i, ctx) => {
        const out = [];
        for await (const round of ctx.storage.rounds) out.push(await round.slice(0, 10));
        return out;
      },
    },
    deleteProposal: {
      run: async (input, ctx) => {
        await ctx.storage.votes.delete(input.proposal);
        const votes = await ctx.storage.votes.get(input.proposal);
        return await votes.size();
      },
    },
    stableHandle: {
      run: async (_i, ctx) => {
        const rounds = ctx.storage.rounds;
        const first = await rounds.push();
        await first.push("a");
        const second = await rounds.push();
        await second.push("b");

        const held = await rounds.get(0);
        await rounds.move(0, 1);
        await held.push("a2");

        const all = [];
        for await (const round of rounds) all.push(await round.slice(0, 10));
        return { held: await held.slice(0, 10), all };
      },
    },
    native: {
      run: async function (_i, ctx) {
        const map = new Map();
        map.set("a", 1);
        const list = new Array(1, 2, 3).map((value) => value * 2);
        await this.storage.weights.set("native", 7);
        return { map: map.get("a"), list, weight: await this.storage.weights.get("native") };
      },
    },
    missing: {
      run: async (_i, ctx) => (ctx.storage.nope ? 1 : 0),
    },
    weights: { run: async (_i, ctx) => (await ctx.storage.weights.size()) },
    setWeight: {
      run: async (input, ctx) => {
        await ctx.storage.weights.set(input.user, input.weight);
        return await ctx.storage.weights.get(input.user);
      },
    },
  },
});
`;

describe("declared storage", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.credit("alice", 1_000_000);
    await service.deploy({
      ownerId: "alice",
      name: "storage-test",
      version: "1.0.0",
      source: SOURCE,
    });
  });

  it("seeds initial values and validates writes", async () => {
    const config = await service.call({ callerId: "alice", endpoint: "config" });
    expect(config.result).toEqual({ quorum: 3 });

    await expect(
      service.call({ callerId: "alice", endpoint: "setConfig", input: { quorum: 0 } }),
    ).rejects.toMatchObject({ code: "execution_failed" });

    const after = await service.call({ callerId: "alice", endpoint: "config" });
    expect(after.result).toEqual({ quorum: 3 });
  });

  it("inserts, pages, removes and moves array items", async () => {
    await service.call({
      callerId: "alice",
      endpoint: "addTop",
      input: { items: ["a", "b"] },
    });
    const top = await service.call({ callerId: "alice", endpoint: "roster" });
    expect(top.result).toEqual(["a", "b"]);

    await service.call({
      callerId: "alice",
      endpoint: "addBottom",
      input: { items: ["c"] },
    });
    expect((await service.call({ callerId: "alice", endpoint: "roster" })).result).toEqual([
      "a",
      "b",
      "c",
    ]);

    const inserted = await service.call({
      callerId: "alice",
      endpoint: "insert",
      input: { index: 1, items: ["x", "y"] },
    });
    expect(inserted.result).toEqual(["a", "x", "y", "b", "c"]);

    const removed = await service.call({
      callerId: "alice",
      endpoint: "remove",
      input: { index: 1, count: 2 },
    });
    expect(removed.result).toEqual(["x", "y"]);
    expect((await service.call({ callerId: "alice", endpoint: "roster" })).result).toEqual([
      "a",
      "b",
      "c",
    ]);

    const moved = await service.call({
      callerId: "alice",
      endpoint: "move",
      input: { from: 0, to: 2 },
    });
    expect(moved.result).toEqual(["b", "c", "a"]);

    await service.call({ callerId: "alice", endpoint: "set", input: { index: 0, value: "z" } });
    expect((await service.call({ callerId: "alice", endpoint: "roster" })).result).toEqual([
      "z",
      "c",
      "a",
    ]);
  });

  it("nests maps and keeps independent counters", async () => {
    await service.call({
      callerId: "alice",
      endpoint: "vote",
      input: { proposal: "p1", voter: "bob", vote: { support: true } },
    });
    await service.call({
      callerId: "alice",
      endpoint: "vote",
      input: { proposal: "p1", voter: "carol", vote: { support: false } },
    });
    await service.call({
      callerId: "alice",
      endpoint: "vote",
      input: { proposal: "p2", voter: "bob", vote: { support: true } },
    });

    const p1 = await service.call({ callerId: "alice", endpoint: "votes", input: { proposal: "p1" } });
    expect(p1.result).toEqual([
      ["bob", { support: true }],
      ["carol", { support: false }],
    ]);
    const p2 = await service.call({ callerId: "alice", endpoint: "votes", input: { proposal: "p2" } });
    expect(p2.result).toEqual([["bob", { support: true }]]);
  });

  it("round-trips nested arrays with stable handles", async () => {
    const round = await service.call({ callerId: "alice", endpoint: "newRound" });
    expect(round.result).toEqual(["a", "b"]);
    await service.call({ callerId: "alice", endpoint: "newRound" });
    const rounds = await service.call({ callerId: "alice", endpoint: "rounds" });
    expect(rounds.result).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  it("deletes a nested subtree without touching its siblings", async () => {
    for (const [proposal, voter] of [
      ["p1", "bob"],
      ["p1", "carol"],
      ["p2", "bob"],
    ]) {
      await service.call({
        callerId: "alice",
        endpoint: "vote",
        input: { proposal, voter, vote: { support: true } },
      });
    }
    const size = await service.call({
      callerId: "alice",
      endpoint: "deleteProposal",
      input: { proposal: "p1" },
    });
    expect(size.result).toBe(0);

    const p1 = await service.call({ callerId: "alice", endpoint: "votes", input: { proposal: "p1" } });
    expect(p1.result).toEqual([]);
    const p2 = await service.call({ callerId: "alice", endpoint: "votes", input: { proposal: "p2" } });
    expect(p2.result).toEqual([["bob", { support: true }]]);
  });

  it("keeps a nested array handle stable when its item moves", async () => {
    const result = await service.call({ callerId: "alice", endpoint: "stableHandle" });
    expect(result.result).toEqual({
      held: ["a", "a2"],
      all: [["b"], ["a", "a2"]],
    });
  });

  it("restores native Map and Array and binds this.storage", async () => {
    const result = await service.call({ callerId: "alice", endpoint: "native" });
    expect(result.result).toEqual({ map: 1, list: [2, 4, 6], weight: 7 });
  });

  it("rejects an unknown collection", async () => {
    await expect(
      service.call({ callerId: "alice", endpoint: "missing" }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("counts map entries", async () => {
    expect((await service.call({ callerId: "alice", endpoint: "weights" })).result).toBe(0);
    await service.call({
      callerId: "alice",
      endpoint: "setWeight",
      input: { user: "bob", weight: 5 },
    });
    expect((await service.call({ callerId: "alice", endpoint: "weights" })).result).toBe(1);
  });
});
