/**
 * Browser-safe matchmaking dev helpers. The fixture runner and marketplace
 * run view use these types; the Node-only builder is the separate
 * `@roster-lock/match-making/build` entry point.
 */
export type {
  FixtureRunner,
  MatchmakingFixture,
  MatchmakingRun,
} from "./fixtures.js";
