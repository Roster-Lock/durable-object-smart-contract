import type { LadderEntry } from "@roster-lock/smart-contract-sdk";
import type { ReactNode } from "react";
import { formatMmr, rankLadder } from "./model.js";

export interface RankedTableProps {
  entries: readonly LadderEntry[];
  /** Highlights this player's row. */
  currentUserId?: string;
  /** When set, the player name becomes a button that selects the user. */
  onSelect?: (userId: string) => void;
  /** Heading text; pass `null` to render no heading. */
  title?: string | null;
  className?: string;
  loading?: boolean;
  /** Shown when the ladder loaded with no entries. */
  empty?: ReactNode;
}

/**
 * The ladder: highest MMR first, ranked from 1. Names are buttons only when a
 * selection handler is supplied, so the table stays keyboard accessible.
 */
export function RankedTable({
  entries,
  currentUserId,
  onSelect,
  title = "Ladder",
  className = "rl-ranked-table",
  loading = false,
  empty = "No ranked players yet.",
}: RankedTableProps) {
  const ranked = rankLadder(entries);
  return (
    <section className={className}>
      {title ? <h2 className="rl-ranked-table__title">{title}</h2> : null}
      {loading ? (
        <p className="rl-ranked-table__status">Loading ladder…</p>
      ) : ranked.length === 0 ? (
        <p className="rl-ranked-table__status">{empty}</p>
      ) : (
        <table className="rl-ranked-table__table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Player</th>
              <th scope="col">MMR</th>
              <th scope="col">Matches</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ rank, entry }) => {
              const current = entry.userId === currentUserId;
              const name = entry.displayName ?? entry.userId;
              return (
                <tr
                  key={entry.userId}
                  className={`rl-ranked-table__row${current ? " is-current" : ""}`}
                  aria-current={current ? "true" : undefined}
                >
                  <td className="rl-ranked-table__rank">{rank}</td>
                  <td className="rl-ranked-table__player">
                    {onSelect ? (
                      <button
                        type="button"
                        className="rl-ranked-table__select"
                        onClick={() => onSelect(entry.userId)}
                      >
                        {name}
                      </button>
                    ) : (
                      name
                    )}
                  </td>
                  <td className="rl-ranked-table__mmr">{formatMmr(entry.mmr)}</td>
                  <td className="rl-ranked-table__matches">
                    {entry.matchesPlayed}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
