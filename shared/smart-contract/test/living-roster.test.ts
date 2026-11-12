import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContractService } from "../src/contract.js";
import { makeService } from "@roster-lock/smart-contract-test-client";

const SOURCE = readFileSync(
  join(process.cwd(), "examples/living-roster/contract.js"),
  "utf8",
);

describe("living-roster example", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService({ config: { gasPricePerMillion: 100 } }));
    for (const user of ["alice", "bob", "carol", "dave"]) {
      await service.credit(user, 1_000_000);
    }
    await service.deploy({
      ownerId: "alice",
      name: "living-roster",
      version: "1.0.0",
      source: SOURCE,
    });
    await service.call({
      callerId: "alice",
      endpoint: "configure",
      input: { quorum: 3, approval: 0.6, rosterLimit: 2 },
    });
  });

  async function roster(): Promise<unknown> {
    return (await service.call({ callerId: "dave", endpoint: "roster" })).result;
  }

  it("adds a piece through a weighted vote", async () => {
    await service.call({
      callerId: "alice",
      endpoint: "setWeight",
      input: { userId: "bob", weight: 5 },
    });

    const proposed = await service.call({
      callerId: "carol",
      endpoint: "propose",
      input: { proposalId: "p1", action: "add", pieceId: "kfm" },
    });
    expect(proposed.events.map((event) => event.name)).toEqual(["ProposalCreated"]);

    await service.call({
      callerId: "bob",
      endpoint: "vote",
      input: { proposalId: "p1", support: true },
    });
    await service.call({
      callerId: "carol",
      endpoint: "vote",
      input: { proposalId: "p1", support: true },
    });
    const resolved = await service.call({
      callerId: "dave",
      endpoint: "resolve",
      input: { proposalId: "p1" },
    });

    expect((resolved.result as { outcome: string }).outcome).toBe("approved");
    expect(resolved.events.map((event) => event.name)).toEqual(["ProposalResolved"]);
    expect(await roster()).toEqual(["kfm"]);
  });

  it("does not let one account vote twice", async () => {
    await service.call({
      callerId: "carol",
      endpoint: "propose",
      input: { proposalId: "p1", action: "add", pieceId: "kfm" },
    });
    await service.call({
      callerId: "bob",
      endpoint: "vote",
      input: { proposalId: "p1", support: true },
    });
    await expect(
      service.call({
        callerId: "bob",
        endpoint: "vote",
        input: { proposalId: "p1", support: false },
      }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("keeps the roster when the vote fails", async () => {
    await service.call({
      callerId: "alice",
      endpoint: "setWeight",
      input: { userId: "bob", weight: 5 },
    });
    await service.call({
      callerId: "carol",
      endpoint: "propose",
      input: { proposalId: "p1", action: "add", pieceId: "kfm" },
    });
    await service.call({
      callerId: "bob",
      endpoint: "vote",
      input: { proposalId: "p1", support: false },
    });
    await service.call({
      callerId: "carol",
      endpoint: "vote",
      input: { proposalId: "p1", support: true },
    });
    await service.call({
      callerId: "dave",
      endpoint: "vote",
      input: { proposalId: "p1", support: true },
    });

    // 2 yes against 5 no is below the 0.6 approval threshold.
    await expect(
      service.call({
        callerId: "alice",
        endpoint: "resolve",
        input: { proposalId: "p1" },
      }),
    ).rejects.toMatchObject({ code: "execution_failed" });

    expect(await roster()).toEqual([]);
  });

  it("enforces quorum", async () => {
    await service.call({
      callerId: "carol",
      endpoint: "propose",
      input: { proposalId: "p1", action: "add", pieceId: "kfm" },
    });
    await service.call({
      callerId: "carol",
      endpoint: "vote",
      input: { proposalId: "p1", support: true },
    });
    await expect(
      service.call({
        callerId: "alice",
        endpoint: "resolve",
        input: { proposalId: "p1" },
      }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("lets the owner dictate and respects the roster limit", async () => {
    await service.call({
      callerId: "alice",
      endpoint: "dictate",
      input: { action: "add", pieceId: "kfm" },
    });
    await service.call({
      callerId: "alice",
      endpoint: "dictate",
      input: { action: "add", pieceId: "nash" },
    });
    expect(await roster()).toEqual(["nash", "kfm"]);

    await expect(
      service.call({
        callerId: "alice",
        endpoint: "dictate",
        input: { action: "add", pieceId: "zangief" },
      }),
    ).rejects.toMatchObject({ code: "execution_failed" });

    expect(await roster()).toEqual(["nash", "kfm"]);
  });

  it("does not let anyone but the owner dictate or set weights", async () => {
    await expect(
      service.call({
        callerId: "bob",
        endpoint: "dictate",
        input: { action: "add", pieceId: "kfm" },
      }),
    ).rejects.toMatchObject({ code: "execution_failed" });
    await expect(
      service.call({
        callerId: "bob",
        endpoint: "setWeight",
        input: { userId: "bob", weight: 100 },
      }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("exposes a fetchable roster source and x-roster-list schema", async () => {
    const record = await service.getContract();
    const rosterEndpoint = record?.manifest.endpoints.roster;
    expect(rosterEndpoint).toMatchObject({ access: "public", mutates: false });
    const inspect = record?.manifest.endpoints.inspectPiece;
    expect(inspect?.input).toMatchObject({
      properties: {
        pieceId: {
          "x-roster-list": {
            type: "piece",
            include: [{ handle: "living-roster", endpoint: "roster" }],
          },
        },
      },
    });

    await service.call({
      callerId: "alice",
      endpoint: "dictate",
      input: { action: "add", pieceId: "kfm" },
    });
    const inspected = await service.call({
      callerId: "dave",
      endpoint: "inspectPiece",
      input: { pieceId: "kfm" },
    });
    expect(inspected.result).toEqual({ pieceId: "kfm", onRoster: true });
  });
});
