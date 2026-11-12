import { beforeEach, describe, expect, it } from "vitest";
import type { ContractService } from "../src/contract.js";
import { makeService } from "@roster-lock/smart-contract-test-client";

const ARRAYS = `
defineContract({
  name: "arrays",
  storage: {
    big: { kind: "array", maxItems: 1000, item: { type: "string" } },
    small: { kind: "array", maxItems: 2, item: { type: "string" } },
  },
  endpoints: {
    addBig: {
      run: async (input, ctx) => {
        await ctx.storage.big.addToBottom(input.items);
        return await ctx.storage.big.length();
      },
    },
    insertBig: {
      run: async (input, ctx) => {
        await ctx.storage.big.insert(input.index, input.items);
        return ctx.storage.big.slice(0, 200);
      },
    },
    big: { run: async (_i, ctx) => ctx.storage.big.slice(0, 200) },
    addSmall: {
      run: async (input, ctx) => {
        await ctx.storage.small.addToTop(input.items);
        return await ctx.storage.small.length();
      },
    },
    small: { run: async (_i, ctx) => ctx.storage.small.slice(0, 10) },
    renumber: {
      gasLimit: 2000000,
      run: async (_i, ctx) => {
        const big = ctx.storage.big;
        await big.addToBottom(["start", "end"]);
        for (let index = 0; index < 80; index++) {
          await big.insert(1, [String(index)]);
        }
        return big.slice(0, 200);
      },
    },
  },
});
`;

const INIT = (value: string) => `
defineContract({
  name: "init-test",
  storage: { v: { kind: "value", schema: { type: "string" } } },
  init: async (ctx) => { await ctx.storage.v.set(${JSON.stringify(value)}); },
  endpoints: {
    get: { run: async (_i, ctx) => (await ctx.storage.v.get()) ?? null },
  },
});
`;

const SCHEMA = (schema: unknown, version: number) => `
defineContract({
  name: "schema-test",
  storage: {
    config: {
      kind: "value",
      version: ${version},
      schema: ${JSON.stringify(schema)},
    },
  },
  endpoints: {
    get: { run: async (_i, ctx) => (await ctx.storage.config.get()) ?? null },
  },
});
`;

const SEED = `
defineContract({
  name: "seed-test",
  storage: {
    rounds: {
      kind: "array",
      item: { kind: "array", item: { type: "string" } },
      initial: [["a"], ["b", "c"]],
    },
    groups: {
      kind: "map",
      key: { type: "string" },
      value: { kind: "array", item: { type: "string" } },
      initial: { g1: ["x", "y"] },
    },
  },
  endpoints: {
    rounds: {
      run: async (_i, ctx) => {
        const out = [];
        for await (const round of ctx.storage.rounds) out.push(await round.slice(0, 10));
        return out;
      },
    },
    groups: {
      run: async (_i, ctx) => {
        const out = {};
        for await (const [key, items] of ctx.storage.groups) {
          out[key] = await items.slice(0, 10);
        }
        return out;
      },
    },
  },
});
`;

const READ_VALIDATION = (
  schema: unknown,
  version: number,
  validateReads: boolean,
) => `
defineContract({
  name: "read-validation",
  storage: {
    v: {
      kind: "value",
      version: ${version},
      validateReads: ${validateReads},
      schema: ${JSON.stringify(schema)},
    },
  },
  endpoints: {
    set: {
      run: async (input, ctx) => {
        await ctx.storage.v.set(input.value);
        return true;
      },
    },
    get: { run: async (_i, ctx) => (await ctx.storage.v.get()) ?? null },
  },
});
`;

describe("array behaviour", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({
      config: { gasPricePerMillion: 0, hardTimeoutMs: 15_000 },
    }));
    await service.credit("alice", 1_000_000);
    await service.deploy({ ownerId: "alice", name: "arrays", version: "1", source: ARRAYS });
  });

  it("enforces maxItems and rolls the whole add back", async () => {
    await service.call({ callerId: "alice", endpoint: "addSmall", input: { items: ["a", "b"] } });
    await expect(
      service.call({ callerId: "alice", endpoint: "addSmall", input: { items: ["c"] } }),
    ).rejects.toMatchObject({ code: "execution_failed" });
    expect((await service.call({ callerId: "alice", endpoint: "small" })).result).toEqual([
      "a",
      "b",
    ]);
  });

  it("bulk-inserts a large batch in one call", async () => {
    const items = Array.from({ length: 300 }, (_, index) => `p${index}`);
    const length = await service.call({
      callerId: "alice",
      endpoint: "addBig",
      input: { items },
    });
    expect(length.result).toBe(300);
    const first = (await service.call({ callerId: "alice", endpoint: "big" })).result as string[];
    expect(first).toHaveLength(200);
    expect(first[0]).toBe("p0");
    expect(first[199]).toBe("p199");
  });

  it("renumbers positions when midpoint precision runs out", async () => {
    const result = await service.call({ callerId: "alice", endpoint: "renumber" });
    const values = result.result as string[];
    expect(values[0]).toBe("start");
    expect(values[values.length - 1]).toBe("end");
    expect(values).toHaveLength(82);
    expect(values[1]).toBe("79");
    expect(values[80]).toBe("0");
  });
});

describe("init and schemas", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.credit("alice", 1_000_000);
  });

  it("runs init once, on the first deploy only", async () => {
    await service.deploy({ ownerId: "alice", name: "init-test", version: "1", source: INIT("first") });
    expect((await service.call({ callerId: "alice", endpoint: "get" })).result).toBe("first");

    await service.deploy({ ownerId: "alice", name: "init-test", version: "2", source: INIT("second") });
    expect((await service.call({ callerId: "alice", endpoint: "get" })).result).toBe("first");
  });

  it("requires a version bump when a schema changes", async () => {
    const first = { type: "object", properties: { a: { type: "string" } } };
    const second = { type: "object", properties: { b: { type: "string" } } };

    await service.deploy({ ownerId: "alice", name: "schema-test", version: "1", source: SCHEMA(first, 1) });
    await expect(
      service.deploy({ ownerId: "alice", name: "schema-test", version: "2", source: SCHEMA(second, 1) }),
    ).rejects.toMatchObject({ code: "schema_changed" });

    await service.deploy({ ownerId: "alice", name: "schema-test", version: "4", source: SCHEMA(second, 2) });
    expect((await service.getContract())?.manifest.storage.config).toMatchObject({ version: 2 });
  });

  it("seeds nested initial values", async () => {
    await service.deploy({ ownerId: "alice", name: "seed-test", version: "1", source: SEED });
    expect((await service.call({ callerId: "alice", endpoint: "rounds" })).result).toEqual([
      ["a"],
      ["b", "c"],
    ]);
    expect((await service.call({ callerId: "alice", endpoint: "groups" })).result).toEqual({
      g1: ["x", "y"],
    });
  });

  it("rejects schemas with references and reserved collection names", async () => {
    await expect(
      service.deploy({
        ownerId: "alice",
        name: "bad-ref",
        version: "1",
        source: `defineContract({
          storage: { v: { kind: "value", schema: { $ref: "#/nope" } } },
          endpoints: { get: { run: async () => 1 } },
        });`,
      }),
    ).rejects.toMatchObject({ code: "analysis_failed" });

    await expect(
      service.deploy({
        ownerId: "alice",
        name: "bad-name",
        version: "1",
        source: `defineContract({
          storage: { constructor: { kind: "value", schema: {} } },
          endpoints: { get: { run: async () => 1 } },
        });`,
      }),
    ).rejects.toMatchObject({ code: "analysis_failed" });
  });

  it("re-validates old values on read when asked", async () => {
    const stringSchema = { type: "object", properties: { a: { type: "string" } } };
    const numberSchema = { type: "object", properties: { a: { type: "number" } } };

    await service.deploy({
      ownerId: "alice",
      name: "read-validation",
      version: "1",
      source: READ_VALIDATION(stringSchema, 1, false),
    });
    await service.call({ callerId: "alice", endpoint: "set", input: { value: { a: "x" } } });

    await service.deploy({
      ownerId: "alice",
      name: "read-validation",
      version: "2",
      source: READ_VALIDATION(numberSchema, 2, true),
    });
    await expect(
      service.call({ callerId: "alice", endpoint: "get" }),
    ).rejects.toMatchObject({ code: "execution_failed" });

    await service.deploy({
      ownerId: "alice",
      name: "read-validation",
      version: "3",
      source: READ_VALIDATION(numberSchema, 3, false),
    });
    expect((await service.call({ callerId: "alice", endpoint: "get" })).result).toEqual({
      a: "x",
    });
  });

  it("rejects an undeclared collection at runtime", async () => {
    await service.deploy({
      ownerId: "alice",
      name: "missing",
      version: "1",
      source: `defineContract({
        storage: { v: { kind: "value", schema: {} } },
        endpoints: { get: { run: async (_i, ctx) => await ctx.storage.nope.get() } },
      });`,
    });
    await expect(
      service.call({ callerId: "alice", endpoint: "get" }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });
});
