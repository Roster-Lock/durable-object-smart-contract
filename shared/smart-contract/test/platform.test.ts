import { beforeEach, describe, expect, it } from "vitest";
import { ContractService } from "../src/contract.js";
import { makeService } from "@roster-lock/smart-contract-test-client";
import type { TestDatabase } from "@roster-lock/smart-contract-test-client";

const INIT_ARGS = `
defineContract({
  name: "init-args",
  storage: { v: { kind: "value", schema: { type: "object" } } },
  init: async (ctx, args) => {
    await ctx.storage.v.set(args);
  },
  endpoints: {
    get: { run: async (_i, ctx) => (await ctx.storage.v.get()) ?? null },
  },
});
`;

const VIEWS = `
defineContract({
  name: "views",
  storage: { v: { kind: "value", schema: { type: "string" } } },
  endpoints: {
    read: {
      mutates: false,
      run: async (_i, ctx) => (await ctx.storage.v.get()) ?? null,
    },
    write: {
      run: async (input, ctx) => {
        await ctx.storage.v.set(input.value);
        return true;
      },
    },
    badView: {
      mutates: false,
      run: async (input, ctx) => {
        await ctx.storage.v.set(input.value);
        return true;
      },
    },
    emitView: {
      mutates: false,
      run: async (_i, ctx) => {
        await ctx.emit("Nope", {});
        return true;
      },
    },
  },
});
`;

const EVENTS = `
defineContract({
  name: "events",
  events: {
    Changed: {
      schema: {
        type: "object",
        required: ["x"],
        properties: { x: { type: "number" } },
        additionalProperties: false,
      },
    },
    Other: {
      schema: {
        type: "object",
        required: ["n"],
        properties: { n: { type: "number" } },
        additionalProperties: false,
      },
    },
    Nope: { schema: {} },
  },
  storage: { v: { kind: "value", schema: {} } },
  endpoints: {
    emit: {
      run: async (input, ctx) => {
        await ctx.emit("Changed", input);
        await ctx.emit("Other", { n: 1 });
        return true;
      },
    },
    rollback: {
      run: async (_i, ctx) => {
        await ctx.emit("Nope", {});
        throw new Error("nope");
      },
    },
    badSchema: {
      run: async (_i, ctx) => {
        await ctx.emit("Changed", { x: "not a number" });
        return true;
      },
    },
    unknown: {
      run: async (_i, ctx) => {
        await ctx.emit("Missing", {});
        return true;
      },
    },
  },
});
`;

describe("deploy and registry", () => {
  let service: ContractService;
  let db: TestDatabase;

  beforeEach(async () => {
    ({ service, db } = await makeService({
      rosterId: "roster-1",
      config: { gasPricePerMillion: 0 },
    }));
    await service.credit("alice", 1_000_000);
  });

  it("previews a contract without storing it", async () => {
    const preview = await service.preview({
      ownerId: "alice",
      name: "init-args",
      source: INIT_ARGS,
    });
    expect(preview.contractId).toBe("test-contract");
    expect(preview.manifest.storage.v).toMatchObject({ kind: "value" });
    expect(preview.analysis.ok).toBe(true);
    expect(await service.getContract()).toBeUndefined();
  });

  it("passes initArgs and records them", async () => {
    const deployed = await service.deploy({
      ownerId: "alice",
      name: "init-args",
      version: "1",
      initArgs: { a: 1 },
      source: INIT_ARGS,
    });
    expect(deployed.contractId).toBe("test-contract");
    expect((await service.call({ callerId: "alice", endpoint: "get" })).result).toEqual({
      a: 1,
    });
    expect((await service.getContract())?.initArgs).toEqual({ a: 1 });
  });

  it("lists contracts by roster across objects", async () => {
    await service.deploy({
      ownerId: "alice",
      name: "init-args",
      version: "1",
      initArgs: { a: 1 },
      source: INIT_ARGS,
    });

    const other = new ContractService({
      contractId: "other-contract",
      rosterId: "roster-1",
      openDb: db.open,
      config: { gasPricePerMillion: 0 },
    });
    await other.initialize();
    await other.credit("bob", 1_000_000);
    await other.deploy({
      ownerId: "bob",
      name: "second",
      version: "1",
      initArgs: { b: 2 },
      source: INIT_ARGS,
    });

    const contracts = await service.listContracts({ rosterId: "roster-1" });
    expect(contracts.map((entry) => entry.contractId).sort()).toEqual([
      "other-contract",
      "test-contract",
    ]);
    expect(contracts.find((entry) => entry.contractId === "other-contract")?.ownerId).toBe(
      "bob",
    );

    const byOwner = await service.listContracts({ ownerId: "alice" });
    expect(byOwner).toHaveLength(1);
    expect(byOwner[0].contractId).toBe("test-contract");
  });
});

const ACCESS = `
defineContract({
  name: "access",
  endpoints: {
    open: { run: async () => "open" },
    human: { access: "human", run: async () => "human" },
    contract: { access: "contract", run: async () => "contract" },
    whoami: {
      run: async (_i, ctx) => ({
        msgSender: ctx.msgSender,
        txOrigin: ctx.txOrigin,
      }),
    },
  },
});
`;

describe("access modes", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.deploy({ ownerId: "alice", name: "access", version: "1", source: ACCESS });
  });

  it("allows humans through public and human endpoints", async () => {
    expect((await service.call({ callerId: "bob", endpoint: "open" })).result).toBe("open");
    expect((await service.call({ callerId: "bob", endpoint: "human" })).result).toBe("human");
    const manifest = (await service.getContract())?.manifest;
    expect(manifest?.endpoints.human.access).toBe("human");
    expect(manifest?.endpoints.contract.access).toBe("contract");

    const owner = await service.call({ callerId: "alice", endpoint: "whoami" });
    expect(owner.result).toMatchObject({
      msgSender: { kind: "human", id: "alice" },
      txOrigin: { kind: "human", id: "alice" },
    });
    const other = await service.call({ callerId: "bob", endpoint: "whoami" });
    expect(other.result).toMatchObject({
      msgSender: { kind: "human", id: "bob" },
      txOrigin: { kind: "human", id: "bob" },
    });
  });

  it("reserves contract callers and contract-only endpoints", async () => {
    await expect(
      service.call({ callerId: "bob", endpoint: "contract" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.call({ callerId: "contract:spoof", endpoint: "open" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

const INPUT = `
defineContract({
  name: "input",
  endpoints: {
    greet: {
      input: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
      run: async (input) => "hello " + input.name,
    },
  },
});
`;

describe("endpoint input schemas", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.deploy({ ownerId: "alice", name: "input", version: "1", source: INPUT });
  });

  it("publishes the schema and validates before escrow", async () => {
    const manifest = (await service.getContract())?.manifest;
    expect(manifest?.endpoints.greet.input).toMatchObject({ type: "object" });

    expect(
      (await service.call({ callerId: "bob", endpoint: "greet", input: { name: "bob" } }))
        .result,
    ).toBe("hello bob");
    await expect(
      service.call({ callerId: "bob", endpoint: "greet", input: { name: 1 } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      service.call({ callerId: "bob", endpoint: "greet", input: { name: "bob", extra: 1 } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

const PLATFORM = `
defineContract({
  name: "platform",
  endpoints: {
    report: {
      access: "roster-lock",
      run: async (_i, ctx) => ({
        kind: ctx.msgSender.kind,
        id: ctx.msgSender.id,
        origin: ctx.txOrigin.id,
      }),
    },
    human: { access: "human", run: async () => "human" },
  },
});
`;

describe("roster-lock access", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.deploy({ ownerId: "alice", name: "platform", version: "1", source: PLATFORM });
  });

  it("reserves platform endpoints for the platform caller", async () => {
    await expect(
      service.call({ callerId: "alice", endpoint: "report" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.call({
        callerId: "alice",
        endpoint: "human",
        callerKind: "roster-lock",
        senderId: "roster-lock",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const result = await service.call({
      callerId: "alice",
      endpoint: "report",
      callerKind: "roster-lock",
      senderId: "roster-lock",
    });
    expect(result.result).toEqual({
      kind: "roster-lock",
      id: "roster-lock",
      origin: "alice",
    });
  });
});

const DELEGATE = `
defineContract({
  name: "delegate",
  events: { Seen: { schema: {} } },
  endpoints: {
    whoami: { run: async (_i, ctx) => ({ msgSender: ctx.msgSender, txOrigin: ctx.txOrigin }) },
    emit: {
      run: async (_i, ctx) => {
        await ctx.emit("Seen", {});
        return true;
      },
    },
  },
});
`;

describe("delegated apps", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.deploy({ ownerId: "alice", name: "delegate", version: "1", source: DELEGATE });
  });

  it("records the client on txOrigin, calls and events", async () => {
    const who = await service.call({
      callerId: "alice",
      endpoint: "whoami",
      delegate: "app-1",
    });
    expect(who.result).toEqual({
      msgSender: { kind: "human", id: "alice" },
      txOrigin: { kind: "human", id: "alice", delegate: "app-1" },
    });

    const emitted = await service.call({
      callerId: "alice",
      endpoint: "emit",
      delegate: "app-1",
    });
    expect(emitted.delegate).toBe("app-1");
    expect(emitted.events[0].delegate).toBe("app-1");

    const calls = await service.listCalls();
    expect(calls[0].delegate).toBe("app-1");
  });

  it("omits delegate for a normal call", async () => {
    const who = await service.call({ callerId: "alice", endpoint: "whoami" });
    expect(who.result).toEqual({
      msgSender: { kind: "human", id: "alice" },
      txOrigin: { kind: "human", id: "alice" },
    });
    expect(who.delegate).toBeUndefined();
  });
});

describe("read-only endpoints", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.credit("alice", 1_000_000);
    await service.deploy({ ownerId: "alice", name: "views", version: "1", source: VIEWS });
    await service.call({ callerId: "alice", endpoint: "write", input: { value: "x" } });
  });

  it("exposes mutability in the manifest and the result", async () => {
    const manifest = (await service.getContract())?.manifest;
    expect(manifest?.endpoints.read.mutates).toBe(false);
    expect(manifest?.endpoints.write.mutates).toBe(true);

    const read = await service.call({ callerId: "alice", endpoint: "read" });
    expect(read.result).toBe("x");
    expect(read.mutates).toBe(false);

    const write = await service.call({
      callerId: "alice",
      endpoint: "write",
      input: { value: "y" },
    });
    expect(write.mutates).toBe(true);
  });

  it("blocks writes and events from a read-only endpoint", async () => {
    await expect(
      service.call({ callerId: "alice", endpoint: "badView", input: { value: "z" } }),
    ).rejects.toMatchObject({ code: "execution_failed" });
    expect((await service.call({ callerId: "alice", endpoint: "read" })).result).toBe("x");

    await expect(
      service.call({ callerId: "alice", endpoint: "emitView" }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });
});

describe("events", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 0 } }));
    await service.credit("alice", 1_000_000);
    await service.deploy({ ownerId: "alice", name: "events", version: "1", source: EVENTS });
  });

  it("returns and lists committed events", async () => {
    const call = await service.call({
      callerId: "alice",
      endpoint: "emit",
      input: { x: 1 },
    });
    expect(call.events.map((event) => event.name)).toEqual(["Changed", "Other"]);
    expect(call.events[0].payload).toEqual({ x: 1 });
    expect(call.events.every((event) => event.contractId === "test-contract")).toBe(true);
    expect(call.events.every((event) => event.callerId === "alice")).toBe(true);
    expect(call.events[0].callId).toBeTruthy();

    const events = await service.listEvents();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.name)).toEqual(["Changed", "Other"]);

    const after = await service.listEvents(call.events[0].id);
    expect(after.map((event) => event.name)).toEqual(["Other"]);

    const filtered = await service.listEvents(undefined, 100, ["Other"]);
    expect(filtered.map((event) => event.name)).toEqual(["Other"]);
  });

  it("rejects undeclared events and payloads that do not match the schema", async () => {
    await expect(
      service.call({ callerId: "alice", endpoint: "badSchema" }),
    ).rejects.toMatchObject({ code: "execution_failed" });
    await expect(
      service.call({ callerId: "alice", endpoint: "unknown" }),
    ).rejects.toMatchObject({ code: "execution_failed" });
    expect(await service.listEvents()).toHaveLength(0);
  });

  it("rolls events back with the call", async () => {
    await expect(
      service.call({ callerId: "alice", endpoint: "rollback" }),
    ).rejects.toMatchObject({ code: "execution_failed" });
    expect(await service.listEvents()).toHaveLength(0);
  });
});
