import {
  createAdopter,
  type Adopter,
  type AdopterDeps,
  type AdoptionRecord,
  type AdoptionRequest,
  type ReviewedVersion,
} from "@roster-lock/reviewed-versions";

/** What deploying an adopted living-roster environment yields. */
export type LivingRosterDeployment = {
  contractId: string;
};

export type LivingRosterAdopterDeps = Omit<
  AdopterDeps<LivingRosterDeployment>,
  "apply"
> & {
  /** Deploy the approved environment's contracts and return their handle. */
  deploy: (
    request: AdoptionRequest,
    version: ReviewedVersion,
  ) => Promise<LivingRosterDeployment>;
};

export type LivingRosterAdopter = Adopter<LivingRosterDeployment>;
export type LivingRosterAdoption = AdoptionRecord<LivingRosterDeployment>;

/**
 * Adopt an approved living-roster environment into a roster. The caller
 * supplies the deploy effect; the approval check and adoption record stay here
 * so a route cannot deploy an unreviewed source by forgetting the gate.
 */
export function createLivingRosterAdopter(
  deps: LivingRosterAdopterDeps,
): LivingRosterAdopter {
  const { deploy, ...rest } = deps;
  return createAdopter("living-roster", { ...rest, apply: deploy });
}
