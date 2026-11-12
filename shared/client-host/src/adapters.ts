import type {
  ClientHost,
  LadderEntry,
  MatchmakerClient,
  Page,
  PlayerStats,
  RecentMatch,
} from "@roster-lock/smart-contract-sdk";

export interface MatchHistoryLike {
  matchId: string;
  finishedAt: number;
  participants: string[];
  result: {
    winners?: string[];
    players?: string[];
    [key: string]: unknown;
  };
}

export interface RecentMatchesAdapterOptions {
  listHistory: (query: {
    userId: string;
    limit: number;
  }) => Promise<MatchHistoryLike[]>;
  /** Optional host enrichment; match history itself does not store rating deltas. */
  mmrDelta?: (entry: MatchHistoryLike, userId: string) => number;
  displayName?: (userId: string) => string | undefined;
}

/**
 * Wire `getRecentMatches` from host-owned `dsc_match_history`.
 *
 * The platform records participants and the raw result, so this adapter can
 * answer without reading arbitrary matchmaker storage. MMR deltas are not in
 * history; pass `mmrDelta` if the host has a stats projection.
 */
export function createRecentMatchesAdapter(
  options: RecentMatchesAdapterOptions,
): (userId: string, limit?: number) => Promise<RecentMatch[]> {
  return async (userId, limit = 20) => {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const entries = await options.listHistory({ userId, limit: safeLimit });
    return entries.map((entry) => {
      const opponentId = entry.participants.find((id) => id !== userId) ?? "";
      const winners = entry.result.winners ?? [];
      const isDraw = winners.length === 0 || winners.length === entry.participants.length;
      const result: RecentMatch["result"] = isDraw
        ? "draw"
        : winners.includes(userId)
          ? "win"
          : "loss";
      const opponentName = options.displayName?.(opponentId);
      return {
        matchId: entry.matchId,
        opponentId,
        ...(opponentName ? { opponentName } : {}),
        result,
        at: entry.finishedAt,
        mmrDelta: options.mmrDelta?.(entry, userId) ?? 0,
      };
    });
  };
}

export interface LadderProjection {
  getPage(input: { limit: number; cursor?: string }): Promise<Page<LadderEntry>>;
}

export interface MatchmakerHostOptions {
  getPlayer?: (userId: string) => Promise<PlayerStats>;
  /**
   * A standard ladder projection is required. Matchmaker storage is arbitrary,
   * so there is no generic implementation; without this provider the host
   * returns a clear `host.ladder_unavailable` error.
   */
  ladder?: LadderProjection;
  recentMatches?: (userId: string, limit?: number) => Promise<RecentMatch[]>;
}

export function createMatchmakerClient(options: MatchmakerHostOptions): MatchmakerClient {
  return {
    getPlayer: options.getPlayer ?? (async (userId) => {
      throw hostError("host.player_unavailable", `player stats are not configured for ${userId}`);
    }),
    getLadder: options.ladder
      ? (input = {}) =>
          options.ladder!.getPage({
            limit: Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          })
      : async () => {
          throw hostError(
            "host.ladder_unavailable",
            "getLadder requires a standard host-maintained stats projection or a declared matchmaker stats contract; matchmaker storage is arbitrary",
          );
        },
    getRecentMatches: options.recentMatches ?? (async (userId) => {
      throw hostError(
        "host.matches_unavailable",
        `recent matches are not configured for ${userId}`,
      );
    }),
  };
}

export function createClientHost(input: {
  session: ClientHost["session"];
  matchmaker?: Partial<MatchmakerClient>;
  roster?: ClientHost["roster"];
  catalog?: ClientHost["catalog"];
  confirm?: ClientHost["confirm"];
}): ClientHost {
  const ladder: LadderProjection | undefined = input.matchmaker?.getLadder
    ? {
        getPage: async (page) =>
          input.matchmaker!.getLadder!({
            limit: page.limit,
            ...(page.cursor ? { cursor: page.cursor } : {}),
          }),
      }
    : undefined;
  const matchmaker = createMatchmakerClient({
    getPlayer: input.matchmaker?.getPlayer,
    ...(ladder ? { ladder } : {}),
    recentMatches: input.matchmaker?.getRecentMatches,
  });
  return {
    session: input.session,
    matchmaker,
    roster: input.roster ?? unavailableRoster(),
    catalog: input.catalog ?? unavailableCatalog(),
    confirm:
      input.confirm ??
      (async () => {
        throw hostError("host.confirm_unavailable", "host confirmation is not configured");
      }),
  };
}

export function hostError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function unavailableRoster(): ClientHost["roster"] {
  const fail = async () => {
    throw hostError("host.roster_unavailable", "roster access is not configured");
  };
  return {
    listContracts: fail,
    getContract: fail,
    getStorage: fail,
    call: fail,
  };
}

function unavailableCatalog(): ClientHost["catalog"] {
  const fail = async () => {
    throw hostError("host.catalog_unavailable", "catalog access is not configured");
  };
  return {
    getPiece: fail,
    searchPieces: fail,
    getUser: fail,
    searchUsers: fail,
  };
}
