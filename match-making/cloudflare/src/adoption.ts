import {
  createAdopter,
  type Adopter,
  type AdopterDeps,
  type AdoptionRecord,
  type AdoptionRequest,
  type ReviewedVersion,
} from "@roster-lock/reviewed-versions";

/** What attaching an adopted match maker to a roster yields. */
export type MatchMakerDeployment = {
  deploymentId: string;
};

export type MatchMakerAdopterDeps = Omit<
  AdopterDeps<MatchMakerDeployment>,
  "apply"
> & {
  /** Attach the approved matchmaker: create its runner/storage and listeners. */
  attach: (
    request: AdoptionRequest,
    version: ReviewedVersion,
  ) => Promise<MatchMakerDeployment>;
};

export type MatchMakerAdopter = Adopter<MatchMakerDeployment>;
export type MatchMakerAdoption = AdoptionRecord<MatchMakerDeployment>;

/**
 * Adopt an approved match maker into a roster. Attaching is product-specific
 * (runner, storage namespace, match-result listeners), so it is a caller
 * effect; the approval check and the adoption record are enforced here.
 */
export function createMatchMakerAdopter(
  deps: MatchMakerAdopterDeps,
): MatchMakerAdopter {
  const { attach, ...rest } = deps;
  return createAdopter("match-maker", { ...rest, apply: attach });
}
