import { beforeEach, describe, expect, it } from "vitest";
import { SmartContractDurableObject } from "../src/durable-object.js";
import { freshTestDatabase, type TestDatabase } from "@roster-lock/smart-contract-test-client";

/**
 * A stand-in for the Durable Object runtime. The engine no longer touches
 * `state.storage` (Postgres owns the data), so this only has to model the two
 * things the object uses: its id and `blockConcurrencyWhile`, which is a
 * serialising queue here exactly as it is in workerd.
 */
class FakeState {
  readonly id = {
    name: "test-contract",
    toString: () => "test-contract",
  };

  private queue: Promise<unknown> = Promise.resolve();

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => callback());
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async ready(): Promise<void> {
    await this.queue;
  }
}

const SOURCE = `
defineContract({
  name: "http",
  events: {
    Ping: {
      schema: {
        type: "object",
        required: ["a"],
        properties: { a: { type: "number" } },
        additionalProperties: false,
      },
    },
  },
  storage: { v: { kind: "value", schema: {} } },
  endpoints: {
    echo: { run: async (input) => input },
    contractOnly: { access: "contract", run: async () => "contract" },
    platformOnly: {
      access: "roster-lock",
      run: async (_i, ctx) => ({ kind: ctx.msgSender.kind, origin: ctx.txOrigin.id }),
    },
    read: { mutates: false, run: async (_i, ctx) => (await ctx.storage.v.get()) ?? null },
    emit: {
      run: async (_i, ctx) => {
        await ctx.emit("Ping", { a: 1 });
        return true;
      },
    },
  },
});
`;

let db: TestDatabase;
let state: FakeState;
let object: SmartContractDurableObject;

beforeEach(async () => {
  db = await freshTestDatabase();
  state = new FakeState();
  object = new SmartContractDurableObject(
    state as unknown as DurableObjectState,
    { ROSTER_ID: "roster-1" },
    { openDb: db.open, contractId: "test-contract" },
  );
  await state.ready();
  await db.query(
    `INSERT INTO dsc_wallet (user_id, balance)
     VALUES ('alice', 100000), ('bob', 100000)`,
  );
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return object.fetch(
    new Request(`https://contract.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("SmartContractDurableObject", () => {
  it("deploys and calls over HTTP", async () => {
    const deployed = await post("/deploy", {
      ownerId: "alice",
      name: "http",
      version: "1",
      source: SOURCE,
    });
    expect(deployed.status).toBe(200);
    const deployBody = (await deployed.json()) as { manifest: { name: string } };
    expect(deployBody.manifest.name).toBe("http");

    const called = await post("/call/echo", {
      callerId: "bob",
      input: { hi: true },
    });
    expect(called.status).toBe(200);
    const body = (await called.json()) as { result: unknown; gasCharged: number };
    expect(body.result).toEqual({ hi: true });
    expect(body.gasCharged).toBeGreaterThan(0);
  });

  it("maps errors to status codes", async () => {
    expect((await post("/call/echo", { callerId: "bob" })).status).toBe(404);

    await post("/deploy", {
      ownerId: "alice",
      name: "http",
      version: "1",
      source: SOURCE,
    });

    const forbidden = await post("/call/contractOnly", { callerId: "bob" });
    expect(forbidden.status).toBe(403);

    await db.query(`INSERT INTO dsc_wallet (user_id, balance) VALUES ('carol', 0)`);
    const broke = await post("/call/echo", { callerId: "carol", input: 1 });
    expect(broke.status).toBe(402);
  });

  it("serves the contract, wallet and call log", async () => {
    await post("/deploy", {
      ownerId: "alice",
      name: "http",
      version: "1",
      source: SOURCE,
    });
    await post("/call/echo", { callerId: "bob", input: 1 });

    const contract = await object.fetch(new Request("https://contract.test/contract"));
    expect(((await contract.json()) as { deployed: boolean }).deployed).toBe(true);

    const wallet = await object.fetch(
      new Request("https://contract.test/wallet?userId=bob"),
    );
    const walletBody = (await wallet.json()) as { balance: number };
    expect(walletBody.balance).toBeGreaterThan(90_000);

    const calls = await object.fetch(new Request("https://contract.test/calls"));
    const callsBody = (await calls.json()) as { calls: unknown[] };
    expect(callsBody.calls).toHaveLength(1);
  });

  it("previews without deploying and exposes the registry", async () => {
    const preview = await post("/deploy/preview", {
      ownerId: "alice",
      name: "http",
      source: SOURCE,
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      manifest: { endpoints: { read: { mutates: boolean } } };
    };
    expect(previewBody.manifest.endpoints.read.mutates).toBe(false);

    const before = await object.fetch(new Request("https://contract.test/contract"));
    expect(((await before.json()) as { deployed: boolean }).deployed).toBe(false);

    await post("/deploy", {
      ownerId: "alice",
      name: "http",
      version: "1",
      contractId: "test-contract",
      source: SOURCE,
    });

    const contracts = await object.fetch(
      new Request("https://contract.test/contracts?rosterId=roster-1"),
    );
    const contractsBody = (await contracts.json()) as {
      contracts: { contractId: string; rosterId: string }[];
    };
    expect(contractsBody.contracts).toEqual([
      expect.objectContaining({ contractId: "test-contract", rosterId: "roster-1" }),
    ]);

    const contract = await object.fetch(new Request("https://contract.test/contract"));
    const contractBody = (await contract.json()) as {
      contract: { contractId: string; rosterId: string };
    };
    expect(contractBody.contract).toMatchObject({
      contractId: "test-contract",
      rosterId: "roster-1",
    });
  });

  it("serves events and enforces read-only endpoints", async () => {
    await post("/deploy", {
      ownerId: "alice",
      name: "http",
      version: "1",
      source: SOURCE,
    });

    const read = await post("/call/read", { callerId: "bob", input: null });
    const readBody = (await read.json()) as { mutates: boolean; result: unknown };
    expect(readBody.mutates).toBe(false);
    expect(readBody.result).toBeNull();

    const emitted = await post("/call/emit", { callerId: "bob" });
    const emittedBody = (await emitted.json()) as { events: { name: string }[] };
    expect(emittedBody.events.map((event) => event.name)).toEqual(["Ping"]);

    const events = await object.fetch(new Request("https://contract.test/events"));
    const eventsBody = (await events.json()) as { events: { name: string }[] };
    expect(eventsBody.events).toHaveLength(1);

    const filtered = await object.fetch(
      new Request("https://contract.test/events?event=Ping"),
    );
    expect(((await filtered.json()) as { events: unknown[] }).events).toHaveLength(1);
    const none = await object.fetch(
      new Request("https://contract.test/events?event=Nope"),
    );
    expect(((await none.json()) as { events: unknown[] }).events).toHaveLength(0);
  });

  it("serves platform calls only with the shared secret", async () => {
    await post("/deploy", {
      ownerId: "alice",
      name: "http",
      version: "1",
      source: SOURCE,
    });

    const disabled = await post("/platform/call/platformOnly", { input: null });
    expect(disabled.status).toBe(403);

    const platformState = new FakeState();
    const platform = new SmartContractDurableObject(
      platformState as unknown as DurableObjectState,
      { SMART_CONTRACT_SECRET: "s3cret" },
      { openDb: db.open, contractId: "test-contract" },
    );
    await platformState.ready();

    const noSecret = await platform.fetch(
      new Request("https://contract.test/platform/call/platformOnly", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: null }),
      }),
    );
    expect(noSecret.status).toBe(403);

    const allowed = await platform.fetch(
      new Request("https://contract.test/platform/call/platformOnly", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dsc-secret": "s3cret",
        },
        body: JSON.stringify({ input: null }),
      }),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { result: unknown };
    expect(body.result).toEqual({ kind: "roster-lock", origin: "alice" });
  });

  it("checks the shared secret when configured", async () => {
    const guarded = new SmartContractDurableObject(
      state as unknown as DurableObjectState,
      { SMART_CONTRACT_SECRET: "s3cret" },
      { openDb: db.open, contractId: "test-contract" },
    );
    await state.ready();

    const denied = await guarded.fetch(
      new Request("https://contract.test/contract"),
    );
    expect(denied.status).toBe(403);

    const allowed = await guarded.fetch(
      new Request("https://contract.test/contract", {
        headers: { "x-dsc-secret": "s3cret" },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});
