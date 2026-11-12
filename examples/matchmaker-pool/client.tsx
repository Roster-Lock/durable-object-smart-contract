import type { ClientApi, LadderEntry, PlayerStats } from "@roster-lock/smart-contract-sdk";
import { createUserDisplay } from "@roster-lock/smart-contract-sdk";

function text(parent: HTMLElement, value: string): void {
  parent.appendChild(document.createTextNode(value));
}

function add(parent: HTMLElement, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

/**
 * The pool matchmaker has no bespoke interaction, so its client is a DOM table
 * plus a small MMR summary. Clicking a row shows that player's ranking.
 */
export default function createClient(api: ClientApi): HTMLElement {
  const root = document.createElement("div");
  root.className = "matchmaker-client";

  const summary = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = "Player MMR";
  const body = document.createElement("dl");
  add(summary, heading, body);

  const ladder = document.createElement("section");
  const ladderHeading = document.createElement("h2");
  ladderHeading.textContent = "Ladder";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["#", "Player", "MMR", "Matches"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    add(headRow, cell);
  }
  add(head, headRow);
  const rows = document.createElement("tbody");
  add(table, head, rows);
  add(ladder, ladderHeading, table);
  add(root, summary, ladder);

  let selected = api.session.userId;
  let entries: LadderEntry[] = [];

  function renderSummary(player: PlayerStats | undefined): void {
    body.textContent = "";
    if (!player) {
      text(body, "No player selected.");
      return;
    }
    const rank = entries.findIndex((entry) => entry.userId === player.userId) + 1;
    const label = player.displayName ?? player.userId;
    add(body, 
      Object.assign(document.createElement("dt"), { textContent: label }),
      Object.assign(document.createElement("dd"), {
        textContent: `${Math.round(player.mmr)} MMR · ${
          rank > 0 ? `rank #${rank}` : "unranked"
        } · ${player.matchesPlayed} matches`,
      }),
    );
    if (player.recentMatch) {
      const recent = player.recentMatch;
      add(body, 
        Object.assign(document.createElement("dt"), { textContent: "Most recent" }),
        Object.assign(document.createElement("dd"), {
          textContent: `${recent.result} vs ${recent.opponentName ?? recent.opponentId} (${
            recent.mmrDelta >= 0 ? "+" : ""
          }${recent.mmrDelta})`,
        }),
      );
    }
  }

  async function select(userId: string): Promise<void> {
    selected = userId;
    renderSummary(await api.matchmaker.getPlayer(userId));
  }

  async function load(): Promise<void> {
    let page;
    try {
      page = await api.matchmaker.getLadder({ limit: 100 });
    } catch (cause) {
      // A host without a standard ladder projection reports
      // host.ladder_unavailable rather than inventing one from arbitrary
      // matchmaker storage.
      table.hidden = true;
      text(
        ladder,
        cause instanceof Error && "code" in cause && cause.code === "host.ladder_unavailable"
          ? "The host has not enabled a ladder projection for this matchmaker."
          : "Could not load the ladder.",
      );
      return;
    }
    entries = [...page.items].sort((a, b) => b.mmr - a.mmr);
    rows.textContent = "";
    table.hidden = entries.length === 0;
    if (entries.length === 0) {
      text(ladder, "No ranked players yet.");
      return;
    }
    for (const [index, entry] of entries.entries()) {
      const row = document.createElement("tr");
      const rank = document.createElement("td");
      rank.textContent = String(index + 1);
      const player = document.createElement("td");
      add(player, createUserDisplay({ catalog: api.catalog, userId: entry.userId }));
      const mmr = document.createElement("td");
      mmr.textContent = String(Math.round(entry.mmr));
      const matches = document.createElement("td");
      matches.textContent = String(entry.matchesPlayed);
      add(row, rank, player, mmr, matches);
      row.addEventListener("click", () => void select(entry.userId));
      add(rows, row);
    }
    if (selected) await select(selected);
    else text(body, "Sign in to see your MMR.");
  }

  void load();
  return root;
}
