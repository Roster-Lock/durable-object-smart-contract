import { describe, expect, it } from "vitest";
import type { LadderEntry, PlayerStats } from "@roster-lock/smart-contract-sdk";
import {
  formatMmr,
  formatMmrDelta,
  playerCardRows,
  rankLadder,
} from "../src/model.js";

function player(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    userId: "u1",
    displayName: "Ada",
    mmr: 1512.6,
    matchesPlayed: 7,
    ...overrides,
  };
}

describe("match-making client model", () => {
  it("ranks by MMR and breaks ties by user id", () => {
    const entries: LadderEntry[] = [
      { userId: "b", displayName: "Bob", mmr: 1400, matchesPlayed: 3 },
      { userId: "c", displayName: "Cy", mmr: 1600, matchesPlayed: 4 },
      { userId: "a", displayName: "Ada", mmr: 1600, matchesPlayed: 9 },
    ];
    expect(rankLadder(entries).map(({ rank, entry }) => [rank, entry.userId])).toEqual([
      [1, "a"],
      [2, "c"],
      [3, "b"],
    ]);
    expect(entries[0].userId).toBe("b");
  });

  it("builds the card rows with rank and the most recent match", () => {
    const rows = playerCardRows(
      player({
        recentMatch: {
          matchId: "m1",
          opponentId: "u2",
          opponentName: "Bob",
          result: "win",
          at: 10,
          mmrDelta: 12.4,
        },
      }),
      { rank: 2, total: 10 },
    );
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["Player", "Ada"],
      ["MMR", "1513"],
      ["Rank", "#2 of 10"],
      ["Matches", "7"],
      ["Most recent", "win vs Bob (+12)"],
    ]);
  });

  it("omits rank when it is not known", () => {
    const rows = playerCardRows(player());
    expect(rows.map((row) => row.label)).toEqual(["Player", "MMR", "Matches"]);
  });

  it("formats MMR and deltas", () => {
    expect(formatMmr(1499.6)).toBe("1500");
    expect(formatMmr(Number.NaN)).toBe("—");
    expect(formatMmrDelta(3)).toBe("+3");
    expect(formatMmrDelta(-4.6)).toBe("-5");
  });
});
