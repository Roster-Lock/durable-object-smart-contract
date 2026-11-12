import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LadderEntry } from "@roster-lock/smart-contract-sdk";
import { MatchmakerCard } from "../src/matchmaker-card.js";
import { RankedTable } from "../src/ranked-table.js";
import { playerCardRows } from "../src/model.js";

const entries: LadderEntry[] = [
  { userId: "u2", displayName: "Bob", mmr: 1400, matchesPlayed: 4 },
  { userId: "u1", displayName: "Ada", mmr: 1600, matchesPlayed: 9 },
];

describe("MatchmakerCard", () => {
  it("renders labels on the left and values on the right", () => {
    const html = renderToStaticMarkup(
      <MatchmakerCard
        rows={playerCardRows({
          userId: "u1",
          displayName: "Ada",
          mmr: 1500,
          matchesPlayed: 3,
        })}
      />,
    );
    expect(html).toContain("Player</h2>");
    expect(html).toContain(">MMR</th>");
    expect(html).toContain(">1500</td>");
    expect(html).toContain(">Matches</th>");
  });

  it("shows the empty state instead of a table", () => {
    const html = renderToStaticMarkup(<MatchmakerCard rows={[]} />);
    expect(html).toContain("No player selected.");
    expect(html).not.toContain("<table");
  });
});

describe("RankedTable", () => {
  it("sorts, ranks and highlights the current player", () => {
    const html = renderToStaticMarkup(
      <RankedTable entries={entries} currentUserId="u2" />,
    );
    expect(html.indexOf("Ada")).toBeLessThan(html.indexOf("Bob"));
    expect(html).toContain(">1</td>");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(">1600</td>");
  });

  it("makes the player name a button when selection is wired", () => {
    const html = renderToStaticMarkup(
      <RankedTable entries={entries} onSelect={() => {}} />,
    );
    expect(html).toContain("rl-ranked-table__select");
    expect(html).toContain(">Ada</button>");
  });

  it("renders loading and empty states", () => {
    expect(
      renderToStaticMarkup(<RankedTable entries={[]} loading />),
    ).toContain("Loading ladder");
    expect(renderToStaticMarkup(<RankedTable entries={[]} />)).toContain(
      "No ranked players yet.",
    );
  });
});
