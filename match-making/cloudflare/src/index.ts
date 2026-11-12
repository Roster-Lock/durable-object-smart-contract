import type {
  MatchmakerDefinition,
  MatchmakingPlan,
  MatchResult,
  QueuedPlayer,
} from "@roster-lock/match-making";

export interface MatchmakerDeployment {
  id: string;
  rosterId: string;
  sourceHash: string;
  status: "pending" | "active" | "failed" | "banned";
  createdAt: number;
  updatedAt: number;
}

/**
 * Production matchmaker surface. `MatchmakerRunner` implements execution;
 * this interface keeps deployment/usage code decoupled from it.
 */
export interface MatchmakerService {
  deploy(input: {
    rosterId: string;
    source: string;
    definition?: MatchmakerDefinition;
  }): Promise<MatchmakerDeployment>;
  handleMatchResult(input: {
    rosterId: string;
    result: MatchResult;
  }): Promise<void>;
  findOtherPlayers(input: {
    rosterId: string;
    pool: QueuedPlayer[];
  }): Promise<MatchmakingPlan>;
}

export { MatchmakerRunner } from "./runner.js";
export type {
  FindPlayersInput,
  HandleMatchInput,
  MatchmakerCallBase,
  MatchmakerRunnerOptions,
} from "./runner.js";

export { clearMatchmakerData } from "./data.js";
export { listMatchHistory } from "./history.js";
export type { MatchHistoryQuery } from "./history.js";
export { createRecentMatchesSource } from "./client-view.js";
export type { RecentMatchesHostOptions, RecentMatchView } from "./client-view.js";

export * from "./adoption.js";
