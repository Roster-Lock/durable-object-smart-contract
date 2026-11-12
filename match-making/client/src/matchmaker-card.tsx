import type { ReactNode } from "react";
import type { CardRow } from "./model.js";

export interface MatchmakerCardProps {
  /** Key/value rows, typically from `playerCardRows`. */
  rows: readonly CardRow[];
  /** Heading text; pass `null` to render no heading. */
  title?: string | null;
  className?: string;
  /** Shown when there are no rows. */
  empty?: ReactNode;
}

/**
 * A compact key/value card: the label is a row header on the left, the value
 * sits to its right. Deliberately plain so a host can style it with one class.
 */
export function MatchmakerCard({
  rows,
  title = "Player",
  className = "rl-matchmaker-card",
  empty = "No player selected.",
}: MatchmakerCardProps) {
  return (
    <section className={className}>
      {title ? <h2 className="rl-matchmaker-card__title">{title}</h2> : null}
      {rows.length === 0 ? (
        <p className="rl-matchmaker-card__empty">{empty}</p>
      ) : (
        <table className="rl-matchmaker-card__table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key ?? row.label}>
                <th scope="row" className="rl-matchmaker-card__label">
                  {row.label}
                </th>
                <td className="rl-matchmaker-card__value">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
