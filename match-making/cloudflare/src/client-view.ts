import type { OpenDb } from "@roster-lock/smart-contract";
import { listMatchHistory } from "./history.js";

/** Client DTO for one match; mirrors `RecentMatch` in @roster-lock/smart-contract-sdk. */
export interface RecentMatchView {
  matchId: string;
  opponentId: string;
  opponentName?: string;
  result: "win" | "loss" | "draw";
  at: number;
  mmrDelta: number;
}

export interface RecentMatchesHostOptions {
  openDb: OpenDb;
  rosterId: string;
  /** Optional display-name lookup; the platform's user table is not in this package. */
  displayName?: (userId: string) => string | undefined | Promise<string | undefined>;
  /** Optional stats-projection enrichment; history does not store rating deltas. */
  mmrDelta?: (match: { matchId: string; userId: string }) => number | undefined;
}

/**
 * Host-side `getRecentMatches` wiring.
 *
 * History is platform-owned (`dsc_match_history`), so this works regardless of
 * what the matchmaker stores. `getLadder` has no generic equivalent: a ladder
 * needs a host-maintained stats projection or a declared matchmaker stats
 * contract, because algorithm storage is arbitrary.
 */
export function createRecentMatchesSource(
  options: RecentMatchesHostOptions,
): (userId: string, limit?: number) => Promise<RecentMatchView[]> {
  return async (userId, limit = 20) => {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const entries = await listMatchHistory(options.openDb, {
      rosterId: options.rosterId,
      userId,
      limit: safeLimit,
    });
    const output: RecentMatchView[] = [];
    for (const entry of entries) {
      const opponentId = entry.participants.find((id) => id !== userId) ?? "";
      const winners = entry.result.winners ?? [];
      const result: RecentMatchView["result"] =
        winners.length === 0 || winners.length === entry.participants.length
          ? "draw"
          : winners.includes(userId)
            ? "win"
            : "loss";
      const opponentName = await options.displayName?.(opponentId);
      output.push({
        matchId: entry.matchId,
        opponentId,
        ...(opponentName ? { opponentName } : {}),
        result,
        at: entry.finishedAt,
        mmrDelta: options.mmrDelta?.({ matchId: entry.matchId, userId }) ?? 0,
      });
    }
    return output;
  };
}
