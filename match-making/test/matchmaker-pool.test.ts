import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MatchmakerRunner,
  listMatchHistory,
} from "@roster-lock/match-making-cloudflare";
import { buildMatchmaker } from "@roster-lock/match-making/build";
import { freshTestDatabase } from "@roster-lock/smart-contract-test-client";

let SOURCE = "";

beforeAll(async () => {
  const built = await buildMatchmaker({
    source: readFileSync("examples/matchmaker-pool/matchmaker.ts", "utf8"),
    sourcefile: "examples/matchmaker-pool/matchmaker.ts",
  });
  if (!built.ok) {
    throw new Error(
      built.sourceValidation.issues
        .concat(built.bundleValidation?.issues ?? [])
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n"),
    );
  }
  SOURCE = built.code!;
});

function player(id: string, queuedAt: number) {
  return { id, queuedAt };
}

describe("pool matchmaker", () => {
  it("matches longest-waiting players and removes them from the pool", async () => {
    const db = await freshTestDatabase();
    const runner = new MatchmakerRunner({ openDb: db.open, config: { hardTimeoutMs: 10_000 } });

    const plan = await runner.findOtherPlayers({
      rosterId: "pool-roster",
      source: SOURCE,
      pool: [
        player("alice", 0),
        player("bob", 10),
        player("carl", 20),
        player("dave", 30),
      ],
      now: 100,
      maxWaitMs: 10_000,
    });

    expect(plan.matches).toEqual([
      ["alice", "bob"],
      ["carl", "dave"],
    ]);
    expect(plan.timedOut).toEqual([]);
  });

  it("returns timed-out players", async () => {
    const db = await freshTestDatabase();
    const runner = new MatchmakerRunner({ openDb: db.open, config: { hardTimeoutMs: 10_000 } });
    const plan = await runner.findOtherPlayers({
      rosterId: "pool-timeout",
      source: SOURCE,
      pool: [player("alice", 0)],
      now: 500,
      maxWaitMs: 100,
    });
    expect(plan.matches).toEqual([]);
    expect(plan.timedOut).toEqual(["alice"]);
  });

  it("updates playedAgainst when a match ends", async () => {
    const db = await freshTestDatabase();
    const runner = new MatchmakerRunner({ openDb: db.open, config: { hardTimeoutMs: 10_000 } });
    await runner.handleMatchResult({
      rosterId: "pool-result",
      source: SOURCE,
      result: {
        matchId: "m1",
        timestamp: 1,
        winners: ["alice"],
        players: ["alice", "carl"],
        selection: {},
      },
    });
    const plan = await runner.findOtherPlayers({
      rosterId: "pool-result",
      source: SOURCE,
      pool: [player("alice", 0), player("carl", 1), player("dave", 2)],
      now: 100,
      maxWaitMs: 10_000,
    });
    // alice avoids carl (stored playedAgainst) and matches dave instead.
    expect(plan.matches[0]).toEqual(["alice", "dave"]);

    const history = await listMatchHistory(db.open, { rosterId: "pool-result" });
    expect(history).toHaveLength(1);
    expect(history[0]?.result.matchId).toBe("m1");
    expect(history[0]?.finishedAt).toBeGreaterThan(0);
    expect(history[0]?.participants).toEqual(["alice", "carl"]);
    const forAlice = await listMatchHistory(db.open, {
      rosterId: "pool-result",
      userId: "alice",
    });
    expect(forAlice).toHaveLength(1);
    const forBob = await listMatchHistory(db.open, {
      rosterId: "pool-result",
      userId: "bob",
    });
    expect(forBob).toHaveLength(0);

    const rows = await db.query<{ key: string; value: string }>(
      `SELECT key, value FROM dsc_state_map
       WHERE contract_id = $1 AND collection = 'ratings'`,
      ["matchmaker:pool-result:default"],
    );
    const ratings = new Map(rows.rows.map((row) => [row.key, JSON.parse(row.value)]));
    expect(ratings.get("alice")).toBe(1016);
    expect(ratings.get("carl")).toBe(984);
  });
});
