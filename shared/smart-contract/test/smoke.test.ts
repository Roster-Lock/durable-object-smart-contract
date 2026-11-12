import { beforeEach, describe, expect, it } from "vitest";
import { LIVING_ROSTER, makeService } from "@roster-lock/smart-contract-test-client";
import type { ContractService } from "../src/contract.js";

describe("vertical slice", () => {
  let service: ContractService;

  beforeEach(async () => {
    ({ service } = await makeService());
    await service.credit("alice", 1_000);
    await service.credit("bob", 1_000);
  });

  it("deploys and runs an endpoint that writes SQL", async () => {
    const deployed = await service.deploy({
      ownerId: "alice",
      name: "living-roster",
      version: "1.0.0",
      source: LIVING_ROSTER,
    });
    expect(deployed.manifest.endpoints.addPiece.gasLimit).toBe(800_000);

    const result = await service.call({
      callerId: "bob",
      endpoint: "addPiece",
      input: { rosterId: "r1", pieceId: "kfm", capacity: 10 },
    });
    expect(result.result).toEqual({ size: 1, caller: "bob" });
    expect(result.gasUsed).toBeGreaterThan(0);

    const list = await service.call({
      callerId: "bob",
      endpoint: "list",
      input: { rosterId: "r1" },
    });
    expect(list.result).toEqual(["kfm"]);
  });
});
