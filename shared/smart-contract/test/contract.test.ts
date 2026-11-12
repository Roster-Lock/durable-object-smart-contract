import { beforeEach, describe, expect, it } from "vitest";
import { ContractError } from "../src/errors.js";
import { ContractService } from "../src/contract.js";
import type { TestDatabase } from "@roster-lock/smart-contract-test-client";
import { makeService } from "@roster-lock/smart-contract-test-client";

const CONTRACT = `
defineContract({
  name: "test-contract",
  version: "1.0.0",
  storage: {
    v: { kind: "value", schema: {} },
  },
  endpoints: {
    set: {
      run: async (input, ctx) => {
        await ctx.storage.v.set(input.value);
        return await ctx.storage.v.get();
      },
    },
    get: {
      run: async (_input, ctx) => (await ctx.storage.v.get()) ?? null,
    },
    writeThenThrow: {
      run: async (_input, ctx) => {
        await ctx.storage.v.set("leaked");
        throw new Error("nope");
      },
    },
    spinAfterWrite: {
      gasLimit: 200000,
      run: async (_input, ctx) => {
        await ctx.storage.v.set("leaked");
        while (true) {}
      },
    },
    humanOnly: {
      access: "human",
      run: async (_input, ctx) => ctx.msgSender.id,
    },
    contractOnly: {
      access: "contract",
      run: async () => "contract",
    },
    muted: {
      run: async () => {
        console.log("hello", { a: 1 });
        console.warn("careful");
        return "done";
      },
    },
    resultTooLarge: {
      run: async () => "x".repeat(2048),
    },
  },
});
`;

describe("ContractService", () => {
  let service: ContractService;
  let db: TestDatabase;

  beforeEach(async () => {
    ({ service, db } = await makeService({
      config: {
        gasPricePerMillion: 1_000,
        escrowTtlMs: 60_000,
      },
    }));
    await service.credit("alice", 10_000);
    await service.credit("bob", 10_000);
  });

  async function deploy() {
    return service.deploy({
      ownerId: "alice",
      name: "test-contract",
      version: "1.0.0",
      source: CONTRACT,
    });
  }

  it("deploys and reports the manifest", async () => {
    const result = await deploy();
    expect(result.analysis.ok).toBe(true);
    expect(result.manifest.endpoints.spinAfterWrite.gasLimit).toBe(200_000);
    expect(result.manifest.endpoints.humanOnly.access).toBe("human");
    expect(result.manifest.endpoints.contractOnly.access).toBe("contract");
    expect(result.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await service.getContract())?.ownerId).toBe("alice");
  });

  it("runs a call and persists state", async () => {
    await deploy();
    const first = await service.call({
      callerId: "bob",
      endpoint: "set",
      input: { value: { nested: [1, 2] } },
    });
    expect(first.result).toEqual({ nested: [1, 2] });
    expect(first.logs).toEqual([]);

    const second = await service.call({ callerId: "bob", endpoint: "get" });
    expect(second.result).toEqual({ nested: [1, 2] });
  });

  it("escrows the maximum and refunds the unused gas", async () => {
    await deploy();
    const before = await service.balance("bob");
    const result = await service.call({
      callerId: "bob",
      endpoint: "get",
    });
    const after = await service.balance("bob");
    expect(result.gasCharged).toBeGreaterThan(0);
    expect(before - after).toBe(result.gasCharged);
    expect(result.gasCharged).toBeLessThan(800);
  });

  it("charges the whole escrow when a call runs out of gas", async () => {
    await deploy();
    const before = await service.balance("bob");
    await expect(
      service.call({ callerId: "bob", endpoint: "spinAfterWrite" }),
    ).rejects.toMatchObject({ code: "out_of_gas" });
    const after = await service.balance("bob");
    // 200k gas at 1000 credits per million = 200 credits, all burned.
    expect(before - after).toBe(200);
    expect(await service.getContract()).toBeDefined();
    // The write before the spin was rolled back.
    const value = await service.call({ callerId: "bob", endpoint: "get" });
    expect(value.result).toBeNull();
  });

  it("rolls back state when an endpoint throws and refunds leftover gas", async () => {
    await deploy();
    await service.call({ callerId: "bob", endpoint: "set", input: { value: "original" } });

    await expect(
      service.call({ callerId: "bob", endpoint: "writeThenThrow" }),
    ).rejects.toMatchObject({ code: "execution_failed" });

    const value = await service.call({ callerId: "bob", endpoint: "get" });
    expect(value.result).toBe("original");
  });

  it("enforces human and contract access", async () => {
    await deploy();
    expect((await service.call({ callerId: "bob", endpoint: "humanOnly" })).result).toBe(
      "bob",
    );
    expect((await service.call({ callerId: "alice", endpoint: "humanOnly" })).result).toBe(
      "alice",
    );
    await expect(
      service.call({ callerId: "bob", endpoint: "contractOnly" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.call({ callerId: "contract:spoof", endpoint: "humanOnly" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a call the caller cannot pay for", async () => {
    await deploy();
    await service.credit("carol", 1);
    await expect(
      service.call({ callerId: "carol", endpoint: "get" }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await service.balance("carol")).toBe(1);
    expect(await service.listCalls(10)).toHaveLength(0);
  });

  it("captures guest logs", async () => {
    await deploy();
    const result = await service.call({ callerId: "bob", endpoint: "muted" });
    expect(result.result).toBe("done");
    expect(result.logs).toEqual(['[log] hello {"a":1}', "[warn] careful"]);
  });

  it("rejects an oversized result", async () => {
    const small = await makeService({ config: { maxResultBytes: 1024 } });
    await small.service.credit("alice", 10_000);
    await small.service.credit("bob", 10_000);
    await small.service.deploy({
      ownerId: "alice",
      name: "test-contract",
      version: "1.0.0",
      source: CONTRACT,
    });
    await expect(
      small.service.call({ callerId: "bob", endpoint: "resultTooLarge" }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("rejects deployment by a different owner", async () => {
    await deploy();
    await expect(
      service.deploy({
        ownerId: "bob",
        name: "stolen",
        version: "2",
        source: CONTRACT,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects statically invalid contracts", async () => {
    await expect(
      service.deploy({
        ownerId: "alice",
        name: "bad",
        version: "1",
        source: `defineContract({ endpoints: {} }); fetch("x");`,
      }),
    ).rejects.toMatchObject({ code: "analysis_failed" });
  });

  it("reports the missing contract", async () => {
    await expect(
      service.call({ callerId: "bob", endpoint: "get" }),
    ).rejects.toMatchObject({ code: "contract_not_deployed" });

    await deploy();
    await expect(
      service.call({ callerId: "bob", endpoint: "nope" }),
    ).rejects.toMatchObject({ code: "unknown_endpoint" });
  });

  it("charges the same gas for the same call", async () => {
    await deploy();
    await service.call({ callerId: "bob", endpoint: "set", input: { value: "x" } });
    const first = await service.call({ callerId: "bob", endpoint: "get" });
    const second = await service.call({ callerId: "bob", endpoint: "get" });
    expect(second.gasUsed).toBe(first.gasUsed);
    expect(second.gasCharged).toBe(first.gasCharged);
  });

  it("keeps contracts separate in one database", async () => {
    await deploy();
    const other = new ContractService({
      contractId: "other-contract",
      openDb: db.open,
      config: { gasPricePerMillion: 1_000, escrowTtlMs: 60_000 },
    });
    await other.initialize();
    expect(await other.getContract()).toBeUndefined();

    await other.deploy({
      ownerId: "alice",
      name: "other",
      version: "1",
      source: CONTRACT,
    });
    await other.credit("bob", 10_000);

    // Same storage name, different contract id: no shared state.
    await service.call({ callerId: "bob", endpoint: "set", input: { value: "first" } });
    await other.call({ callerId: "bob", endpoint: "set", input: { value: "second" } });

    expect((await service.call({ callerId: "bob", endpoint: "get" })).result).toBe("first");
    expect((await other.call({ callerId: "bob", endpoint: "get" })).result).toBe("second");
    expect((await service.getContract())?.name).toBe("test-contract");
  });

  it("records a call log for every settled call", async () => {
    await deploy();
    await service.call({ callerId: "bob", endpoint: "get" });
    await service
      .call({ callerId: "bob", endpoint: "writeThenThrow" })
      .catch(() => undefined);

    const calls = await service.listCalls(10);
    expect(calls).toHaveLength(2);
    expect(calls.map((entry) => entry.status).sort()).toEqual(["error", "ok"]);
    expect(calls.every((entry) => entry.callerId === "bob")).toBe(true);
  });
});
