import type { JsonValue } from "@roster-lock/deployed-types";

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface RecentMatch {
  matchId: string;
  opponentId: string;
  opponentName?: string;
  result: "win" | "loss" | "draw";
  at: number;
  mmrDelta: number;
}

export interface PlayerStats {
  userId: string;
  displayName?: string;
  mmr: number;
  matchesPlayed: number;
  recentMatch?: RecentMatch;
}

export interface LadderEntry {
  userId: string;
  displayName?: string;
  mmr: number;
  matchesPlayed: number;
}

export interface MatchmakerClient {
  getPlayer(userId: string): Promise<PlayerStats>;
  getLadder(input?: { limit?: number; cursor?: string }): Promise<Page<LadderEntry>>;
  getRecentMatches(userId: string, limit?: number): Promise<RecentMatch[]>;
}

export interface Piece {
  id: string;
  title: string;
  imageUrl?: string;
  url?: string;
}

export interface UserSummary {
  id: string;
  displayName: string;
  avatarUrl?: string;
  url?: string;
}

export interface Playlist {
  id: string;
  name: string;
  pieceIds: string[];
}

export interface CatalogClient {
  getPiece(id: string): Promise<Piece | undefined>;
  searchPieces(query: string, limit?: number): Promise<Piece[]>;
  getUser(id: string): Promise<UserSummary | undefined>;
  searchUsers(query: string, limit?: number): Promise<UserSummary[]>;
  getPlaylist?(userId: string, playlistId?: string): Promise<Playlist | undefined>;
}

export interface RosterEndpoint {
  input?: JsonValue;
  access?: "public" | "human" | "contract" | "roster-lock";
  mutates?: boolean;
  /** Declared ceiling; 0/undefined means the host default. */
  gasLimit?: number;
  /** Optional endpoint-level help; input schema title/description also work. */
  title?: string;
  description?: string;
}

export interface RosterContract {
  /**
   * Legacy/optional internal id. Hosts should not send contract ids to custom
   * clients; use `handle` for every client-facing operation.
   */
  id?: string;
  handle: string;
  name: string;
  endpoints: Record<string, RosterEndpoint>;
}

export interface RosterClient {
  listContracts(): Promise<RosterContract[]>;
  getContract(handle: string): Promise<RosterContract | undefined>;
  /** Read-only storage snapshot for display; never used for writes. */
  getStorage(handle: string): Promise<Record<string, unknown>>;
  call(handle: string, endpoint: string, input?: JsonValue): Promise<JsonValue>;
}

export interface ConfirmInput {
  title: string;
  message: string;
  details?: JsonValue;
}

export interface ClientSession {
  userId?: string;
  displayName?: string;
}

/**
 * The only capabilities available to custom client code. There is no fetch,
 * WebSocket or eval; everything goes through the host.
 */
export interface ClientHost {
  session: ClientSession;
  matchmaker: MatchmakerClient;
  roster: RosterClient;
  catalog: CatalogClient;
  /** Show a host-owned confirmation before a paid/gas-metered call. */
  confirm(input: ConfirmInput): Promise<boolean>;
}
