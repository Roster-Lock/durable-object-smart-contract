import { describe, expect, it } from "vitest";
import { createLocalRoster } from "@roster-lock/living-roster-test-client";

const SOURCE = `
defineContract({
  name: "local",
  endpoints: {
    ping: { run: async () => "pong" },
  },
});
`;

describe("living-roster dev", () => {
  it("creates a local PGlite-backed contract service", async () => {
    const local = await createLocalRoster({
      contractId: "local-test",
      config: { gasPricePerMillion: 0 },
    });
    try {
      await local.service.deploy({
        ownerId: "alice",
        name: "local",
        version: "1",
        source: SOURCE,
      });
      const result = await local.service.call({ callerId: "alice", endpoint: "ping" });
      expect(result.result).toBe("pong");
    } finally {
      await local.close();
    }
  });
});
