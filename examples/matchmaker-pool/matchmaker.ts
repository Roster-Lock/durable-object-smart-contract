/**
 * Reference matchmaker for a waiting pool.
 *
 * - longest-waiting player first
 * - avoid recent opponents when possible
 * - fall back to a recent opponent if that is the only option
 * - timeout players after ctx.maxWaitMs
 * - Elo-style rating updates based on the opponent's rating
 * - update each player's playedAgainst list on match end
 */
import { defineMatchmaker } from "@roster-lock/match-making";
import type {
  QueuedPlayer,
  MatchmakingPlan,
  MatchmakerContext,
  MatchResult,
  StorageConfig,
  UsableStorage,
  UserId,
} from "@roster-lock/match-making";

const storage = {
  ratings: {
    kind: "map",
    value: { kind: "value", schema: { type: "integer" } },
  },
  playedAgainst: {
    kind: "map",
    value: {
      kind: "value",
      schema: { type: "array", items: { type: "string" } },
    },
  },
} as const satisfies StorageConfig;

type Storage = UsableStorage<typeof storage>;

const K_FACTOR = 32;
const DEFAULT_RATING = 1000;
const RATING_WINDOW = 100;

function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

defineMatchmaker<typeof storage>({
  name: "pool-elo",
  version: "1.0.0",
  storage,

  async handleMatchResult(
    result: MatchResult,
    ctx: MatchmakerContext<Storage>,
  ): Promise<void> {
    const winners = new Set(result.winners);
    const before = new Map<UserId, number>();
    for (const player of result.players) {
      before.set(player, (await ctx.storage.ratings.get(player)) ?? DEFAULT_RATING);
    }

    for (const player of result.players) {
      const opponents = result.players.filter((other) => other !== player);
      const playerRating = before.get(player) ?? DEFAULT_RATING;
      const averageOpponent =
        opponents.length === 0
          ? playerRating
          : opponents.reduce((sum, other) => sum + (before.get(other) ?? DEFAULT_RATING), 0) /
            opponents.length;
      const expected = expectedScore(playerRating, averageOpponent);
      const score = winners.has(player) ? 1 : 0;
      const delta = Math.round(K_FACTOR * (score - expected));
      const nextRating = Math.max(100, playerRating + delta);
      await ctx.storage.ratings.set(player, nextRating);

      const recent = (await ctx.storage.playedAgainst.get(player)) ?? [];
      const next = [...new Set([...opponents, ...recent])].slice(0, 5);
      await ctx.storage.playedAgainst.set(player, next);
    }
  },

  async findOtherPlayers(
    pool: QueuedPlayer[],
    ctx: MatchmakerContext<Storage>,
  ): Promise<MatchmakingPlan> {
    const now = ctx.now();
    const matches: UserId[][] = [];
    const timedOut: UserId[] = [];

    if (pool.length === 1) {
      const only = pool[0];
      if (now - only.queuedAt > ctx.maxWaitMs) {
        timedOut.push(only.id);
      }
      return { matches, timedOut };
    }

    const sorted = [...pool].sort((a, b) => a.queuedAt - b.queuedAt);
    const available = new Map(sorted.map((player) => [player.id, player]));
    const cachedRating = new Map<UserId, number>();

    async function getRating(userId: UserId): Promise<number> {
      const cached = cachedRating.get(userId);
      if (cached !== undefined) return cached;
      const rating = (await ctx.storage.ratings.get(userId)) ?? DEFAULT_RATING;
      cachedRating.set(userId, rating);
      return rating;
    }

    for (const player of sorted) {
      if (!available.has(player.id)) continue;
      const waiting = now - player.queuedAt;
      if (waiting > ctx.maxWaitMs) {
        timedOut.push(player.id);
        available.delete(player.id);
        continue;
      }

      const playerRating = await getRating(player.id);
      const candidates = (
        await Promise.all(
          [...available.values()].map(async (candidate) => {
            if (candidate.id === player.id) return null;
            const otherRating = await getRating(candidate.id);
            return Math.abs(playerRating - otherRating) <= RATING_WINDOW
              ? candidate
              : null;
          }),
        )
      ).filter((candidate): candidate is QueuedPlayer => candidate !== null);

      if (candidates.length === 0) continue;

      const stored = (await ctx.storage.playedAgainst.get(player.id)) ?? [];
      const recent = new Set([...stored]);
      let valid = candidates.filter((candidate) => !recent.has(candidate.id));
      if (valid.length === 0) valid = candidates;

      valid.sort((a, b) => a.queuedAt - b.queuedAt);
      const opponent = valid[0];
      matches.push([player.id, opponent.id]);
      available.delete(player.id);
      available.delete(opponent.id);
    }

    return { matches, timedOut };
  },
});
