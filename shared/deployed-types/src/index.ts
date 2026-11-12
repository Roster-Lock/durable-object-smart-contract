/**
 * Types shared by deployed living-roster contracts and matchmakers.
 * Import these with `import type` from `@roster-lock/deployed-types`.
 */

export type UserId = string;
export type RosterId = string;
export type ContractId = string;
export type MatchId = string;
export type PieceId = string;
export type PieceType = string;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MatchResult {
  matchId: MatchId;
  timestamp: number;
  winners: UserId[];
  players: UserId[];
  selection: Record<PieceType, PieceId[] | Record<UserId, PieceId[]>>;
  metadata?: JsonValue;
}

export interface QueuedPlayer {
  id: UserId;
  queuedAt: number;
}
