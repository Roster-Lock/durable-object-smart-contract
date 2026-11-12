/**
 * Raw-byte limits for a custom client build.
 *
 * These are bytes, not gzip. Assets have their own budget and are not included
 * in either JavaScript budget. See docs/client-builds.md.
 */
export interface ClientBudgetConfig {
  /** Uploaded ZIP size. */
  maxArchiveBytes: number;
  /** Total bytes after decompression. */
  maxUnpackedBytes: number;
  /** Maximum number of regular files in the archive. */
  maxArchiveFiles: number;
  /** Maximum uncompressed size of one archive file. */
  maxArchiveFileBytes: number;
  /** Unminified bundle output (the dependency graph after esbuild bundling). */
  maxPreOptimizationBytes: number;
  /** Final minified IIFE. */
  maxBundleBytes: number;
  /** One extracted/static asset. */
  maxAssetBytes: number;
  /** All static assets in one build. */
  maxTotalAssetBytes: number;
  /** One npm package tarball. */
  maxPackageTarballBytes: number;
  /** Packages in one resolved graph. */
  maxPackages: number;
  /** Resolved package files retained in the virtual module map. */
  maxPackageFiles: number;
  /** Wall-clock budget enforced around the build phases. */
  buildTimeoutMs: number;
  /** Per-request host bridge timeout default (runtime, not build). */
  requestTimeoutMs: number;
}

export const DEFAULT_CLIENT_BUDGETS: Readonly<ClientBudgetConfig> = Object.freeze({
  maxArchiveBytes: 8 * 1024 * 1024,
  maxUnpackedBytes: 16 * 1024 * 1024,
  maxArchiveFiles: 512,
  maxArchiveFileBytes: 5 * 1024 * 1024,
  maxPreOptimizationBytes: 2_500_000,
  maxBundleBytes: 1_000_000,
  maxAssetBytes: 5 * 1024 * 1024,
  maxTotalAssetBytes: 20 * 1024 * 1024,
  maxPackageTarballBytes: 25 * 1024 * 1024,
  maxPackages: 128,
  maxPackageFiles: 20_000,
  buildTimeoutMs: 120_000,
  requestTimeoutMs: 15_000,
});

/** Human-readable policy metadata returned in build reports and docs. */
export const CLIENT_BUDGET_POLICY = Object.freeze({
  unit: "raw-bytes" as const,
  gzip: false,
  preOptimization: "unminified-esbuild-bundle",
  finalBundle: "minified-rollup-iife",
  assetsCountedInJsBudget: false,
  assets: "separate-per-file-and-total-limits",
});

/** Bump when a change to the pipeline can change emitted bytes. */
export const CLIENT_BUILDER_VERSION = "1.0.0";

/** Package installation policy, shown in build reports and docs. */
export const CLIENT_PACKAGE_POLICY = Object.freeze({
  installStrategy: "tarball-extraction",
  executeLifecycleScripts: false,
  npmFlag: "--ignore-scripts",
  nativeAddons: false,
  runtimeImports: false,
});

export const CLIENT_MANIFEST_FILENAME = "client.json";
export const CLIENT_MANIFEST_ALIASES: readonly string[] = ["client.json", "manifest.json"];
export const CLIENT_SUBMISSION_SCHEMA_VERSION = 1;
export const CLIENT_BUILD_MANIFEST_SCHEMA_VERSION = 1;

export const RUNTIME_ARTIFACT_PATHS = Object.freeze({
  source: "source.zip",
  lockfile: "lockfile.json",
  manifest: "manifest.json",
  bundle: "bundle.js",
  assets: "assets",
});
