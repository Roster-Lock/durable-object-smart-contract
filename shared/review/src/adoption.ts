import type {
  ReviewedKind,
  ReviewedVersion,
  ReviewedVersionGate,
} from "./types.js";
import { ReviewError, normalizeSourceHash } from "./types.js";

/**
 * Product-facing kind of adoptable code. The review store keeps its own
 * canonical kinds (`roster-environment`, `matchmaker`); this type is the
 * vocabulary the products and the marketplace use.
 */
export type AdoptableKind = "living-roster" | "match-maker";

export interface AdoptionRequest {
  rosterId: string;
  kind: AdoptableKind;
  /** Immutable identity of the exact approved version. */
  sourceHash: string;
  repo: string;
  commit: string;
  entry: string;
  config?: Record<string, unknown>;
}

export interface Adoption {
  id: string;
  rosterId: string;
  kind: AdoptableKind;
  sourceHash: string;
  status: "active" | "revoked";
  adoptedAt: number;
  revokedAt?: number;
  /** Product-specific handle, e.g. a contract id or matchmaker deployment id. */
  result?: Record<string, unknown>;
}

export interface AdoptionStore {
  save(adoption: Adoption): Promise<void>;
  get(
    rosterId: string,
    kind: AdoptableKind,
    sourceHash: string,
  ): Promise<Adoption | undefined>;
  list(rosterId: string, kind?: AdoptableKind): Promise<Adoption[]>;
}

export function adoptionKey(
  rosterId: string,
  kind: AdoptableKind,
  sourceHash: string,
): string {
  return `${rosterId}\u0000${kind}\u0000${sourceHash}`;
}

export class MemoryAdoptionStore implements AdoptionStore {
  private readonly adoptions = new Map<string, Adoption>();

  async save(adoption: Adoption): Promise<void> {
    this.adoptions.set(
      adoptionKey(adoption.rosterId, adoption.kind, adoption.sourceHash),
      structuredClone(adoption),
    );
  }

  async get(
    rosterId: string,
    kind: AdoptableKind,
    sourceHash: string,
  ): Promise<Adoption | undefined> {
    const adoption = this.adoptions.get(adoptionKey(rosterId, kind, sourceHash));
    return adoption ? structuredClone(adoption) : undefined;
  }

  async list(rosterId: string, kind?: AdoptableKind): Promise<Adoption[]> {
    return [...this.adoptions.values()]
      .filter((adoption) => adoption.rosterId === rosterId)
      .filter((adoption) => !kind || adoption.kind === kind)
      .sort((a, b) => b.adoptedAt - a.adoptedAt)
      .map((adoption) => structuredClone(adoption));
  }
}

export function reviewedKindForAdoption(kind: AdoptableKind): ReviewedKind {
  return kind === "living-roster" ? "roster-environment" : "matchmaker";
}

export interface AdopterDeps<T extends Record<string, unknown>> {
  /** Approval gate; adoption is refused unless the exact hash is approved. */
  gate: ReviewedVersionGate;
  store: AdoptionStore;
  /** Apply the product-specific effect (deploy, attach runner, wire listeners). */
  apply: (request: AdoptionRequest, version: ReviewedVersion) => Promise<T>;
  /** Undo the effect when an adoption is revoked or a version is banned. */
  revert?: (adoption: Adoption, result: T) => Promise<void>;
  now?: () => number;
}

export interface AdoptionRecord<T extends Record<string, unknown>>
  extends Adoption {
  result: T;
}

export interface Adopter<T extends Record<string, unknown>> {
  adopt(request: AdoptionRequest): Promise<AdoptionRecord<T>>;
  revoke(
    rosterId: string,
    sourceHash: string,
  ): Promise<AdoptionRecord<T> | undefined>;
  list(rosterId: string): Promise<AdoptionRecord<T>[]>;
}

/**
 * Build an adopter for one product kind. The product supplies the effect; this
 * function owns the invariants: the request kind must match, the exact source
 * hash must be approved before `apply` runs, and an active adoption is
 * idempotent.
 */
export function createAdopter<T extends Record<string, unknown>>(
  kind: AdoptableKind,
  deps: AdopterDeps<T>,
): Adopter<T> {
  const now = deps.now ?? Date.now;

  function record(adoption: Adoption): AdoptionRecord<T> {
    return { ...adoption, result: (adoption.result ?? {}) as T };
  }

  return {
    async adopt(request) {
      if (request.kind !== kind) {
        throw new ReviewError(
          "review.invalid",
          `expected a ${kind} adoption, got ${request.kind}`,
        );
      }
      const sourceHash = normalizeSourceHash(request.sourceHash);
      const existing = await deps.store.get(request.rosterId, kind, sourceHash);
      if (existing?.status === "active") return record(existing);

      const version = await deps.gate.requireApproved({
        kind: reviewedKindForAdoption(kind),
        sourceHash,
      });
      const result = await deps.apply(
        { ...request, kind, sourceHash },
        version,
      );
      const adoption: Adoption = {
        id: adoptionKey(request.rosterId, kind, sourceHash),
        rosterId: request.rosterId,
        kind,
        sourceHash,
        status: "active",
        adoptedAt: now(),
        result,
      };
      await deps.store.save(adoption);
      return record(adoption);
    },

    async revoke(rosterId, sourceHash) {
      const normalized = normalizeSourceHash(sourceHash);
      const existing = await deps.store.get(rosterId, kind, normalized);
      if (!existing) return undefined;
      if (existing.status === "revoked") return record(existing);

      if (deps.revert) await deps.revert(existing, record(existing).result);
      const revoked: Adoption = {
        ...existing,
        status: "revoked",
        revokedAt: now(),
      };
      await deps.store.save(revoked);
      return record(revoked);
    },

    async list(rosterId) {
      const adoptions = await deps.store.list(rosterId, kind);
      return adoptions.map(record);
    },
  };
}
