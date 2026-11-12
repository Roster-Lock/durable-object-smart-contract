import type { ClientArchive } from "./archive.js";
import type { ClientBundleOutput } from "./build.js";
import type { ClientBudgetConfig } from "./constants.js";
import { ClientBuildError, diagnostic, type ClientBuildDiagnostic } from "./errors.js";
import {
  createClientBuildManifest,
  hashBytes,
  stableStringify,
  type BuildManifestResult,
} from "./manifest.js";
import type { ResolvedClientGraph } from "./resolver.js";
import type { ClientArtifactStore, ClientBuildRepository } from "./store.js";
import type {
  ClientBuildManifest,
  ClientBuildRecord,
  ClientBuildUsage,
  ClientLockfile,
  PublishedClientBuild,
} from "./types.js";

export interface PublishClientBuildInput {
  archive: ClientArchive;
  archiveBytes: Uint8Array;
  graph: ResolvedClientGraph;
  bundle: ClientBundleOutput;
  lockfile: ClientLockfile;
  budgets: ClientBudgetConfig;
  artifacts: ClientArtifactStore;
  repository: ClientBuildRepository;
  sourceRef?: string;
  commit?: string;
  /** Generated with client-runtime's createClientDocument; optional at the store layer. */
  documentHtml?: string;
  now?: number;
}

/**
 * Write a ready build's artifacts and metadata.
 *
 * Artifacts are written first and only then is the row marked ready. Any
 * failure deletes everything this attempt wrote and leaves a failed row with no
 * keys, so a retry can never observe a half-published build.
 */
export async function publishClientBuild(
  input: PublishClientBuildInput,
): Promise<PublishedClientBuild> {
  const now = input.now ?? Date.now();
  const built: BuildManifestResult = createClientBuildManifest({
    archive: input.archive,
    graph: input.graph,
    bundle: input.bundle,
    lockfile: input.lockfile,
    budgets: input.budgets,
    createdAt: now,
  });
  const { buildId, manifest } = built;
  const existing = await input.repository.get(buildId);
  if (existing?.status === "banned") {
    throw new ClientBuildError(`client build ${buildId} is banned`, [
      diagnostic("build.banned", "a banned build cannot be republished from the same source"),
    ], "publish");
  }
  if (existing?.status === "ready") {
    // Immutable artifacts: the first publication wins. A rebuild of the same
    // inputs returns the existing record and does not rewrite the manifest
    // with a new timestamp.
    manifest.createdAt = existing.createdAt;
    return {
      record: existing,
      manifest,
      bundle: input.bundle.bundle,
      lockfile: input.lockfile,
      sourceZip: input.archiveBytes,
      assets: new Map(input.bundle.assets.map((asset) => [asset.path, asset.data])),
    };
  }
  const prefix = buildId;
  const keys = {
    source: `${prefix}/source.zip`,
    lockfile: `${prefix}/lockfile.json`,
    manifest: `${prefix}/manifest.json`,
    bundle: `${prefix}/bundle.js`,
    assets: Object.fromEntries(
      manifest.assets.map((asset) => [asset.path, asset.key]),
    ) as Record<string, string>,
    ...(input.documentHtml ? { document: `${prefix}/index.html` } : {}),
  };
  const urls: ClientBuildRecord["urls"] = {
    bundle: input.artifacts.publicUrl(keys.bundle),
    ...(keys.document ? { document: input.artifacts.publicUrl(keys.document) } : {}),
    assets: Object.fromEntries(
      manifest.assets.map((asset) => [asset.path, input.artifacts.publicUrl(asset.key)]),
    ),
  };
  const record: ClientBuildRecord = {
    id: buildId,
    status: "ready",
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    name: manifest.name,
    version: manifest.version,
    entry: manifest.entry,
    framework: manifest.framework,
    sourceHash: manifest.sourceHash,
    lockfileHash: manifest.lockfileHash,
    manifestHash: built.manifestHash,
    bundleHash: manifest.bundleHash,
    sizes: {
      archiveBytes: input.archive.archiveBytes,
      unpackedBytes: input.archive.unpackedBytes,
      preOptimizationBytes: input.bundle.preOptimizationBytes,
      bundleBytes: input.bundle.bundleBytes,
      assetBytes: input.bundle.assets.reduce((sum, asset) => sum + asset.data.byteLength, 0),
    },
    keys,
    urls,
    assets: manifest.assets,
    packages: manifest.packages,
    diagnostics: [],
    warnings: input.bundle.warnings,
    createdAt: now,
    updatedAt: now,
    readyAt: now,
  };

  const written: string[] = [];
  try {
    for (const asset of input.bundle.assets) {
      const key = record.keys.assets![asset.path]!;
      await input.artifacts.put(key, asset.data, {
        contentType: asset.contentType,
        cacheControl: "public, max-age=31536000, immutable",
        metadata: { buildId, path: asset.path, hash: asset.hash },
      });
      written.push(key);
    }
    await input.artifacts.put(keys.bundle, input.bundle.bundle, {
      contentType: "text/javascript; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { buildId, hash: manifest.bundleHash },
    });
    written.push(keys.bundle);
    await input.artifacts.put(keys.source, input.archiveBytes, {
      contentType: "application/zip",
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { buildId, hash: manifest.sourceHash },
    });
    written.push(keys.source);
    const lockfileJson = stableStringify(input.lockfile);
    await input.artifacts.put(keys.lockfile, lockfileJson, {
      contentType: "application/json",
      cacheControl: "public, max-age=31536000, immutable",
    });
    written.push(keys.lockfile);
    await input.artifacts.put(keys.manifest, stableStringify(manifest), {
      contentType: "application/json",
      cacheControl: "public, max-age=31536000, immutable",
    });
    written.push(keys.manifest);
    if (input.documentHtml && keys.document) {
      await input.artifacts.put(keys.document, input.documentHtml, {
        contentType: "text/html; charset=utf-8",
        cacheControl: "public, max-age=31536000, immutable",
      });
      written.push(keys.document);
    }
    await input.repository.save(record);
    return {
      record,
      manifest,
      bundle: input.bundle.bundle,
      lockfile: input.lockfile,
      sourceZip: input.archiveBytes,
      assets: new Map(input.bundle.assets.map((asset) => [asset.path, asset.data])),
    };
  } catch (error) {
    await deleteKeys(input.artifacts, written);
    const failed: ClientBuildRecord = {
      ...record,
      status: "failed",
      keys: {},
      urls: {},
      assets: [],
      readyAt: undefined,
      updatedAt: now,
      diagnostics: [
        ...(error instanceof ClientBuildError
          ? error.diagnostics
          : [diagnostic("publish.failed", error instanceof Error ? error.message : String(error))]),
      ],
    };
    await input.repository.save(failed);
    const failure =
      error instanceof ClientBuildError
        ? error
        : new ClientBuildError(
            "could not publish client build",
            failed.diagnostics,
            "publish",
          );
    (failure as ClientBuildError & { clientBuildRecord?: ClientBuildRecord }).clientBuildRecord =
      failed;
    throw failure;
  }
}

export async function banClientBuild(input: {
  buildId: string;
  repository: ClientBuildRepository;
  artifacts: ClientArtifactStore;
  reason?: string;
  bannedBy?: string;
  now?: number;
}): Promise<ClientBuildRecord> {
  const record = await input.repository.get(input.buildId);
  if (!record) throw new Error(`client build ${input.buildId} was not found`);
  const keys = collectKeys(record);
  await deleteKeys(input.artifacts, keys);
  await input.repository.removeUsage(input.buildId);
  await input.repository.removePinsForBuild?.(input.buildId);
  const now = input.now ?? Date.now();
  const banned: ClientBuildRecord = {
    ...record,
    status: "banned",
    keys: {},
    urls: {},
    assets: [],
    bannedAt: now,
    bannedBy: input.bannedBy ?? "admin",
    banReason: input.reason ?? "banned by an administrator",
    deletedAt: now,
    updatedAt: now,
  };
  await input.repository.save(banned);
  return banned;
}

export async function recordClientBuildUsage(input: {
  repository: ClientBuildRepository;
  rosterId: string;
  buildId: string;
  now?: number;
}): Promise<ClientBuildUsage> {
  const usage: ClientBuildUsage = {
    rosterId: input.rosterId,
    buildId: input.buildId,
    status: "active",
    createdAt: input.now ?? Date.now(),
  };
  await input.repository.addUsage(usage);
  return usage;
}

/** Pin a roster to an exact immutable build. Stale clients stay pinned. */
export async function pinClientBuild(input: {
  repository: ClientBuildRepository;
  rosterId: string;
  buildId: string;
  sourceRef?: string;
  commit?: string;
  now?: number;
}): Promise<void> {
  await input.repository.setPin({
    rosterId: input.rosterId,
    buildId: input.buildId,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    pinnedAt: input.now ?? Date.now(),
  });
}

export interface RetentionPolicy {
  /** Keep a ready build this long after last use when unreferenced. */
  readyDays: number;
  /** Failed rows are cheap; keep diagnostics for this long. */
  failedDays: number;
  /** Banned rows keep only hashes/diagnostics. */
  bannedDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  readyDays: 90,
  failedDays: 30,
  bannedDays: 365,
};

export function planRetention(
  records: readonly ClientBuildRecord[],
  usedBuildIds: ReadonlySet<string>,
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): { deleteArtifacts: string[]; deleteRows: string[] } {
  const day = 86_400_000;
  const deleteArtifacts: string[] = [];
  const deleteRows: string[] = [];
  for (const record of records) {
    const age = now - record.updatedAt;
    if (record.status === "ready" && !usedBuildIds.has(record.id) && age > policy.readyDays * day) {
      deleteArtifacts.push(record.id);
    } else if (record.status === "failed" && age > policy.failedDays * day) {
      deleteRows.push(record.id);
    } else if (record.status === "banned" && age > policy.bannedDays * day) {
      deleteRows.push(record.id);
    }
  }
  return { deleteArtifacts, deleteRows };
}

export interface ApplyRetentionInput {
  records: readonly ClientBuildRecord[];
  usedBuildIds: ReadonlySet<string>;
  now: number;
  repository: ClientBuildRepository;
  artifacts: ClientArtifactStore;
  policy?: RetentionPolicy;
}

/** Delete artifacts for unused ready builds and remove expired failed/banned rows. */
export async function applyRetention(input: ApplyRetentionInput): Promise<{
  artifactsDeleted: string[];
  rowsDeleted: string[];
}> {
  const plan = planRetention(
    input.records,
    input.usedBuildIds,
    input.now,
    input.policy ?? DEFAULT_RETENTION,
  );
  const byId = new Map(input.records.map((record) => [record.id, record]));
  for (const id of plan.deleteArtifacts) {
    const record = byId.get(id);
    if (!record) continue;
    await deleteKeys(input.artifacts, collectKeys(record));
    await input.repository.removePinsForBuild?.(id);
    await input.repository.save({
      ...record,
      status: "deleted",
      keys: {},
      urls: {},
      assets: [],
      deletedAt: input.now,
      updatedAt: input.now,
    });
  }
  for (const id of plan.deleteRows) {
    await input.repository.delete(id);
  }
  return { artifactsDeleted: plan.deleteArtifacts, rowsDeleted: plan.deleteRows };
}

export function collectKeys(record: ClientBuildRecord): string[] {
  return [
    record.keys.source,
    record.keys.lockfile,
    record.keys.manifest,
    record.keys.bundle,
    record.keys.document,
    ...Object.values(record.keys.assets ?? {}),
  ].filter((key): key is string => Boolean(key));
}

async function deleteKeys(store: ClientArtifactStore, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)]) {
    try {
      await store.delete(key);
    } catch {
      // Best effort: the failed-row write is the durable record either way.
    }
  }
}

export function publishedManifestHash(manifest: ClientBuildManifest): string {
  return hashBytes(new TextEncoder().encode(stableStringify(manifest)));
}
