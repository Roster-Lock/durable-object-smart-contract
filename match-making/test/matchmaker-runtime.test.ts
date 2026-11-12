import { describe, expect, it } from "vitest";
import { MatchmakerRunner, clearMatchmakerData } from "@roster-lock/match-making-cloudflare";
import { buildMatchmaker } from "@roster-lock/match-making/build";
import { freshTestDatabase } from "@roster-lock/smart-contract-test-client";

const SOURCE = `
defineMatchmaker({
  name: "test-matchmaker",
  storage: {
    ratings: {
      kind: "map",
      value: { kind: "value", schema: { type: "integer" } },
    },
  },
  async handleMatchResult(result, ctx) {
    await ctx.storage.ratings.set(result.winners[0], 1200);
  },
  async findOtherPlayers(pool, ctx) {
    const first = pool[0];
    const rating = await ctx.storage.ratings.get(first.id);
    return {
      matches: [[
        String(rating === undefined ? 1000 : rating),
        ...pool
          .filter((candidate) => candidate.id !== first.id)
          .map((candidate) => candidate.id),
      ]],
    };
  },
});
`;

describe("matchmaker QuickJS runner", () => {
  it("runs a builder-produced matchmaker with runtime shims", async () => {
    const built = await buildMatchmaker({
      source: `
        import { defineMatchmaker } from "@roster-lock/match-making";
        defineMatchmaker({
          name: "shimmed",
          storage: {
            ratings: {
              kind: "map",
              value: { kind: "value", schema: { type: "integer" } },
            },
          },
          async handleMatchResult(result, ctx) {
            await ctx.storage.ratings.set(result.winners[0], 1300);
          },
          async findOtherPlayers(pool, ctx) {
            return {
              matches: [[String((await ctx.storage.ratings.get(pool[0].id)) ?? 1000)]],
            };
          },
        });
      `,
    });
    expect(built.ok).toBe(true);
    const db = await freshTestDatabase();
    const runner = new MatchmakerRunner({ openDb: db.open, config: { hardTimeoutMs: 10_000 } });
    await runner.handleMatchResult({
      rosterId: "r2",
      source: built.code!,
      result: {
        matchId: "m2",
        timestamp: 1,
        winners: ["alice"],
        players: ["alice"],
        selection: {},
      },
    });
    const plan = await runner.findOtherPlayers({
      rosterId: "r2",
      source: built.code!,
      pool: [{ id: "alice", queuedAt: 1 }],
    });
    expect(plan.matches).toEqual([["1300"]]);
  });

  it("runs the init hook once for a fresh deployment", async () => {
    const source = `
      defineMatchmaker({
        name: "init-test",
        storage: { ratings: { kind: "map", value: { kind: "value", schema: { type: "integer" } } } },
        async init(ctx, previous) {
          const prior = previous ? await previous.ratings.get("alice") : undefined;
          await ctx.storage.ratings.set("alice", prior ?? 1500);
        },
        async handleMatchResult() {},
        async findOtherPlayers(pool, ctx) {
          return { matches: [[String((await ctx.storage.ratings.get(pool[0].id)) ?? 1000)]] };
        },
      });
    `;
    const db = await freshTestDatabase();
    const runner = new MatchmakerRunner({ openDb: db.open, config: { hardTimeoutMs: 10_000 } });
    await runner.initialize({
      rosterId: "init",
      source,
      previous: {
        storage: {
          ratings: {
            kind: "map",
            value: { kind: "value", schema: { type: "integer" } },
          },
        },
        data: { ratings: { alice: 1800 } },
      },
    });
    const plan = await runner.findOtherPlayers({
      rosterId: "init",
      source,
      pool: [{ id: "alice", queuedAt: 0 }],
    });
    expect(plan.matches).toEqual([["1800"]]);
  });

  it("runs the matchmaker against declared storage and host queue data", async () => {
    const db = await freshTestDatabase();
    const runner = new MatchmakerRunner({
      openDb: db.open,
      config: { hardTimeoutMs: 10_000 },
    });

    await runner.handleMatchResult({
      rosterId: "r1",
      source: SOURCE,
      now: 100,
      random: 0.5,
      result: {
        matchId: "m1",
        timestamp: 1,
        winners: ["alice"],
        players: ["alice", "bob"],
        selection: {},
      },
    });

    const plan = await runner.findOtherPlayers({
      rosterId: "r1",
      source: SOURCE,
      pool: [
        { id: "alice", queuedAt: 90 },
        { id: "bob", queuedAt: 80 },
        { id: "carl", queuedAt: 70 },
      ],
      now: 200,
      random: 0.25,
    });

    expect(plan.matches).toEqual([["1200", "bob", "carl"]]);

    await clearMatchmakerData(db, "matchmaker:r1:default");
    const afterClear = await runner.findOtherPlayers({
      rosterId: "r1",
      source: SOURCE,
      pool: [{ id: "alice", queuedAt: 1 }],
    });
    expect(afterClear.matches).toEqual([["1000"]]);
  });
});
