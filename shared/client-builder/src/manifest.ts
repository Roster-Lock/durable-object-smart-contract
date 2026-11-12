import { createHash } from "node:crypto";
import {
  CLIENT_BUILD_MANIFEST_SCHEMA_VERSION,
  CLIENT_BUDGET_POLICY,
  CLIENT_BUILDER_VERSION,
  type ClientBudgetConfig,
} from "./constants.js";
import type { ClientBundleOutput } from "./build.js";
import type { ClientArchive } from "./archive.js";
import type { ResolvedClientGraph } from "./resolver.js";
import type {
  ClientAssetManifest,
  ClientBuildManifest,
  ClientLockfile,
  ClientPackagePin,
  ClientSubmissionManifest,
} from "./types.js";
import type { ClientBuildDiagnostic } from "./errors.js";

export interface BuildManifestInput {
  archive: ClientArchive;
  graph: ResolvedClientGraph;
  bundle: ClientBundleOutput;
  lockfile: ClientLockfile;
  budgets: ClientBudgetConfig;
  createdAt?: number;
}

export interface BuildManifestResult {
  manifest: ClientBuildManifest;
  buildId: string;
  manifestHash: string;
}

export function createClientBuildManifest(input: BuildManifestInput): BuildManifestResult {
  const bundleHash = `sha256:${createHash("sha256").update(input.bundle.bundle).digest("hex")}`;
  const lockfileHash = hashLockfile(input.lockfile);
  const buildId = computeBuildId({
    sourceHash: input.archive.sourceHash,
    lockfileHash,
    bundleHash,
    assets: input.bundle.assets.map((asset) => ({
      path: asset.path,
      key: asset.key,
      url: asset.url,
      hash: asset.hash,
      bytes: asset.data.byteLength,
      contentType: asset.contentType,
    })),
    budgets: input.budgets,
  });
  const assets: ClientAssetManifest[] = input.bundle.assets.map((asset) => ({
    path: asset.path,
    key: `${buildId}/${asset.key}`,
    url: asset.url,
    hash: asset.hash,
    bytes: asset.data.byteLength,
    contentType: asset.contentType,
  }));
  const manifest: ClientBuildManifest = {
    schemaVersion: CLIENT_BUILD_MANIFEST_SCHEMA_VERSION,
    buildId,
    name: input.archive.manifest.name,
    version: input.archive.manifest.version,
    entry: input.archive.entry,
    framework: input.archive.manifest.framework,
    builderVersion: CLIENT_BUILDER_VERSION,
    sourceHash: input.archive.sourceHash,
    lockfileHash,
    bundleHash,
    bundleBytes: input.bundle.bundleBytes,
    preOptimizationBytes: input.bundle.preOptimizationBytes,
    assets,
    packages: input.graph.pins,
    bundleUrl: "./bundle.js",
    documentUrl: "./index.html",
    createdAt: input.createdAt ?? Date.now(),
    warnings: input.bundle.warnings,
    budgetPolicy: CLIENT_BUDGET_POLICY,
  };
  return {
    manifest,
    buildId,
    manifestHash: `sha256:${createHash("sha256").update(stableStringify(manifest)).digest("hex")}`,
  };
}

export function computeBuildId(input: {
  sourceHash: string;
  lockfileHash: string;
  bundleHash: string;
  assets: readonly ClientAssetManifest[];
  budgets: ClientBudgetConfig;
}): string {
  const hash = createHash("sha256");
  hash.update(input.sourceHash);
  hash.update("\0");
  hash.update(input.lockfileHash);
  hash.update("\0");
  hash.update(input.bundleHash);
  hash.update("\0");
  hash.update(CLIENT_BUILDER_VERSION);
  hash.update("\0");
  hash.update(
    JSON.stringify({
      pre: input.budgets.maxPreOptimizationBytes,
      final: input.budgets.maxBundleBytes,
      asset: input.budgets.maxAssetBytes,
    }),
  );
  hash.update("\0");
  for (const asset of [...input.assets].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(asset.path);
    hash.update("\0");
    hash.update(asset.hash);
    hash.update("\0");
  }
  return `b_${hash.digest("hex").slice(0, 32)}`;
}

export function hashLockfile(lockfile: ClientLockfile): string {
  return `sha256:${createHash("sha256").update(stableStringify(lockfile)).digest("hex")}`;
}

export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function validateClientBuildManifest(value: unknown): ClientBuildManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("build manifest must be an object");
  }
  const manifest = value as ClientBuildManifest;
  if (manifest.schemaVersion !== CLIENT_BUILD_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported build manifest schemaVersion ${String(manifest.schemaVersion)}`);
  }
  if (typeof manifest.buildId !== "string" || !/^b_[a-f0-9]{32}$/.test(manifest.buildId)) {
    throw new Error("build manifest buildId is invalid");
  }
  if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.packages)) {
    throw new Error("build manifest assets/packages must be arrays");
  }
  for (const asset of manifest.assets) {
    if (
      !asset.key.startsWith(`${manifest.buildId}/assets/`) ||
      !asset.url.startsWith("./assets/")
    ) {
      throw new Error(`asset ${asset.path} has an invalid immutable key/url`);
    }
  }
  return manifest;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function diagnosticsForManifest(
  diagnostics: ClientBuildDiagnostic[],
): ClientBuildDiagnostic[] {
  return diagnostics.map((item) => ({ ...item }));
}

export type { ClientAssetManifest, ClientPackagePin, ClientSubmissionManifest };
