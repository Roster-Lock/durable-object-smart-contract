import type { CLIENT_BUDGET_POLICY } from "./constants.js";
import type { ClientBuildDiagnostic } from "./errors.js";

export type ClientFramework = "react" | "vue" | "svelte" | "angular" | "vanilla";

/** `client.json` at the root of a submitted ZIP. */
export interface ClientSubmissionManifest {
  /** Submission format version. Currently 1. */
  schemaVersion: 1;
  name: string;
  version: string;
  /** Path inside the archive; exactly one entrypoint. */
  entry: string;
  framework: ClientFramework;
  /** Runtime dependencies, resolved at build time. Exact versions or semver ranges. */
  dependencies?: Record<string, string>;
  /** Optional JSX automatic runtime source; defaults to react for TSX. */
  jsxImportSource?: string;
  description?: string;
  /** Optional per-build budget overrides; the host may ignore/clamp these. */
  budgets?: Partial<{
    maxPreOptimizationBytes: number;
    maxBundleBytes: number;
  }>;
}

export interface ClientAssetManifest {
  /** Logical archive path. */
  path: string;
  /** Immutable key below the build's `assets/` prefix. */
  key: string;
  /** URL relative to the artifact document. */
  url: string;
  hash: string;
  bytes: number;
  contentType: string;
}

export interface ClientPackagePin {
  name: string;
  version: string;
  /** npm integrity string when available. */
  integrity?: string;
  /** sha256 of the package tarball, when fetched from a registry. */
  tarballHash?: string;
  /** Package names and ranges requested by this package. */
  dependencies?: Record<string, string>;
}

export interface ClientLockfile {
  lockfileVersion: 1;
  packages: Record<
    string,
    {
      version: string;
      integrity?: string;
      tarballHash?: string;
      dependencies?: Record<string, string>;
      /** Relative virtual files used by this package. */
      files: string[];
    }
  >;
}

/** The immutable build manifest stored next to the bundle. */
export interface ClientBuildManifest {
  schemaVersion: 1;
  buildId: string;
  name: string;
  version: string;
  entry: string;
  framework: ClientFramework;
  builderVersion: string;
  sourceHash: string;
  lockfileHash: string;
  bundleHash: string;
  bundleBytes: number;
  preOptimizationBytes: number;
  assets: ClientAssetManifest[];
  packages: ClientPackagePin[];
  /** Relative URL of the bundle inside the artifact. */
  bundleUrl: string;
  /** Relative URL of the runtime document. */
  documentUrl: string;
  createdAt: number;
  warnings: string[];
  budgetPolicy: typeof CLIENT_BUDGET_POLICY;
}

export type ClientBuildStatus =
  | "pending"
  | "building"
  | "ready"
  | "failed"
  | "banned"
  | "deleted";

export interface ClientBuildSizes {
  archiveBytes: number;
  unpackedBytes: number;
  preOptimizationBytes: number;
  bundleBytes: number;
  assetBytes: number;
}

export interface ClientBuildKeys {
  source?: string;
  lockfile?: string;
  manifest?: string;
  bundle?: string;
  document?: string;
  assets?: Record<string, string>;
}

export interface ClientBuildUrls {
  bundle?: string;
  document?: string;
  assets?: Record<string, string>;
}

export interface ClientBuildRecord {
  id: string;
  status: ClientBuildStatus;
  sourceRef?: string;
  commit?: string;
  name: string;
  version: string;
  entry: string;
  framework: ClientFramework;
  sourceHash?: string;
  lockfileHash?: string;
  manifestHash?: string;
  bundleHash?: string;
  sizes: ClientBuildSizes;
  keys: ClientBuildKeys;
  urls: ClientBuildUrls;
  assets: ClientAssetManifest[];
  packages: ClientPackagePin[];
  diagnostics: ClientBuildDiagnostic[];
  warnings: string[];
  createdAt: number;
  updatedAt: number;
  readyAt?: number;
  bannedAt?: number;
  bannedBy?: string;
  banReason?: string;
  deletedAt?: number;
}

export interface ClientBuildUsage {
  rosterId: string;
  buildId: string;
  status: "active" | "revoked" | "banned";
  createdAt: number;
  revokedAt?: number;
}

export interface ClientBuildPin {
  rosterId: string;
  buildId: string;
  sourceRef?: string;
  commit?: string;
  pinnedAt: number;
}

/** What the build service returns after a successful publication. */
export interface PublishedClientBuild {
  record: ClientBuildRecord;
  manifest: ClientBuildManifest;
  bundle: string;
  lockfile: ClientLockfile;
  sourceZip: Uint8Array;
  assets: Map<string, Uint8Array>;
}
