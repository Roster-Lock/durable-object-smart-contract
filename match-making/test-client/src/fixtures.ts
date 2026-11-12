import type {
  MatchResult,
  QueuedPlayer,
} from "@roster-lock/deployed-types";

/** A deterministic fixture for local and marketplace test runs. */
export interface MatchmakingFixture {
  players: QueuedPlayer[];
  /** Optional initial matchmaker storage snapshot. */
  storage?: Record<string, unknown>;
  matches: MatchResult[];
  now: number;
  seed: number;
}

export interface MatchmakingRun {
  matched: string[];
  queue: QueuedPlayer[];
  ratings: Record<string, number>;
}

export interface FixtureRunner {
  run(fixture: MatchmakingFixture): Promise<MatchmakingRun>;
}
