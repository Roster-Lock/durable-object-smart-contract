import { describe, expect, it } from "vitest";
import { createRecentMatchesSource } from "@roster-lock/match-making-cloudflare";
import { recordMatchHistory } from "../cloudflare/src/history.js";
import { freshTestDatabase } from "@roster-lock/smart-contract-test-client";

describe("host-owned recent matches for the client API", () => {
  it("wires getRecentMatches from dsc_match_history without reading matchmaker storage", async () => {
    const db = await freshTestDatabase();
    await recordMatchHistory(db, {
      rosterId: "client-roster",
      finishedAt: 100,
      result: {
        matchId: "m-win",
        timestamp: 100,
        winners: ["alice"],
        players: ["alice", "bob"],
        selection: {},
      },
    });
    await recordMatchHistory(db, {
      rosterId: "client-roster",
      finishedAt: 90,
      result: {
        matchId: "m-loss",
        timestamp: 90,
        winners: ["carl"],
        players: ["alice", "carl"],
        selection: {},
      },
    });
    const source = createRecentMatchesSource({
      openDb: db.open,
      rosterId: "client-roster",
      displayName: (userId) => (userId === "bob" ? "Bob" : undefined),
      mmrDelta: ({ matchId }) => (matchId === "m-win" ? 12 : -8),
    });
    const recent = await source("alice", 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({
      matchId: "m-win",
      opponentId: "bob",
      opponentName: "Bob",
      result: "win",
      at: 100,
      mmrDelta: 12,
    });
    expect(recent[1]).toMatchObject({
      matchId: "m-loss",
      result: "loss",
      mmrDelta: -8,
    });
  });
});
