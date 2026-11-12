import type { LadderEntry, PlayerStats } from "@roster-lock/smart-contract-sdk";

/** A row in the player card: label on the left, value on the right. */
export interface CardRow {
  label: string;
  value: string;
  /** Optional stable key; defaults to `label`. */
  key?: string;
}

export interface RankedEntry {
  rank: number;
  entry: LadderEntry;
}

/** Round MMR for display; the ladder is not precise enough to show decimals. */
export function formatMmr(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

/** Signed MMR change, e.g. `+12` or `-8`. */
export function formatMmrDelta(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

/**
 * Sort by MMR (highest first) and assign 1-based ranks. Ties fall back to
 * `userId` so the table is stable between renders.
 */
export function rankLadder(entries: readonly LadderEntry[]): RankedEntry[] {
  return [...entries]
    .sort((a, b) => b.mmr - a.mmr || a.userId.localeCompare(b.userId))
    .map((entry, index) => ({ rank: index + 1, entry }));
}

/**
 * The key/value rows for a player's card. `rank` is the player's position in
 * the ladder when it is known; `total` adds "of N".
 */
export function playerCardRows(
  player: PlayerStats,
  options: { rank?: number; total?: number } = {},
): CardRow[] {
  const rows: CardRow[] = [
    {
      key: "player",
      label: "Player",
      value: player.displayName ?? player.userId,
    },
    { key: "mmr", label: "MMR", value: formatMmr(player.mmr) },
  ];
  if (options.rank !== undefined && options.rank > 0) {
    rows.push({
      key: "rank",
      label: "Rank",
      value:
        options.total && options.total > 0
          ? `#${options.rank} of ${options.total}`
          : `#${options.rank}`,
    });
  }
  rows.push({
    key: "matches",
    label: "Matches",
    value: String(player.matchesPlayed),
  });
  if (player.recentMatch) {
    const recent = player.recentMatch;
    rows.push({
      key: "recent",
      label: "Most recent",
      value: `${recent.result} vs ${
        recent.opponentName ?? recent.opponentId
      } (${formatMmrDelta(recent.mmrDelta)})`,
    });
  }
  return rows;
}
