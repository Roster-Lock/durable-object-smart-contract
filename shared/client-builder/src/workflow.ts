import { createHash } from "node:crypto";
import { readClientArchive, type ClientArchive } from "./archive.js";
import { buildClientBundle, type ClientBundleOutput } from "./build.js";
import {
  CLIENT_BUILDER_VERSION,
  DEFAULT_CLIENT_BUDGETS,
  type ClientBudgetConfig,
} from "./constants.js";
import { ClientBuildError, diagnostic, type ClientBuildDiagnostic } from "./errors.js";
import type { FrameworkAdapterOptions } from "./frameworks.js";
import { buildClientModuleMap, resolveClientDependencies, type ResolvedClientGraph } from "./resolver.js";
import { publishClientBuild, type PublishClientBuildInput } from "./publish.js";
import type { ClientArtifactStore, ClientBuildRepository } from "./store.js";
import type {
  ClientBuildRecord,
  ClientLockfile,
  ClientSubmissionManifest,
  PublishedClientBuild,
} from "./types.js";
import type { PackageProvider } from "./packages.js";

export type ClientBuildStepRunner = <T>(
  name: string,
  fn: () => Promise<T>,
) => Promise<T>;

export type BuildEnvironmentMode = "container" | "ci" | "worker";

export interface BuildIsolationPolicy {
  mode: BuildEnvironmentMode;
  /** CPU/memory limits are enforced by the container; this records the intent. */
  cpuMillis?: number;
  memoryBytes?: number;
  wallClockMs?: number;
  networkHosts?: readonly string[];
  allowSecrets?: false;
  executeLifecycleScripts?: false;
}

export const DEFAULT_ISOLATION: BuildIsolationPolicy = {
  mode: "ci",
  cpuMillis: 120_000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  wallClockMs: 120_000,
  networkHosts: ["registry.npmjs.org"],
  allowSecrets: false,
  executeLifecycleScripts: false,
};

export function assertBuildIsolation(policy: BuildIsolationPolicy = DEFAULT_ISOLATION): void {
  const effective = { ...DEFAULT_ISOLATION, ...policy };
  if (effective.mode === "worker") {
    throw new ClientBuildError("client builds cannot run in the request Worker", [
      diagnostic(
        "build.isolation",
        "native esbuild/Rollup builds must run in an isolated container, CI job or Cloudflare Workflow step backed by one; do not build in the request Worker",
      ),
    ], "internal");
  }
  if (effective.allowSecrets !== false) {
    throw new ClientBuildError("build containers must not receive platform secrets", [
      diagnostic("build.isolation_secrets", "the build service may only receive registry access and client input"),
    ], "internal");
  }
  if (effective.executeLifecycleScripts !== false) {
    throw new ClientBuildError("package lifecycle scripts are forbidden", [
      diagnostic("build.lifecycle_scripts", "the build service never executes package lifecycle scripts"),
    ], "internal");
  }
}

export interface ClientBuildWorkflowDeps {
  provider: PackageProvider;
  artifacts: ClientArtifactStore;
  repository: ClientBuildRepository;
  budgets?: ClientBudgetConfig;
  frameworkOptions?: FrameworkAdapterOptions;
  isolation?: BuildIsolationPolicy;
  now?: () => number;
}

export interface ClientBuildRequest {
  zip: Uint8Array;
  sourceRef?: string;
  commit?: string;
  budgets?: Partial<ClientBudgetConfig>;
}

export interface ClientBuildWorkflowResult {
  published: PublishedClientBuild;
  archive: ClientArchive;
  graph: ResolvedClientGraph;
  bundle: ClientBundleOutput;
  lockfile: ClientLockfile;
}

export interface ClientBuildFailure {
  record: ClientBuildRecord;
  diagnostics: ClientBuildDiagnostic[];
}

/**
 * Coordinated build pipeline. The caller supplies a step runner: an immediate
 * function in tests/CI, or a Cloudflare Workflow `step.do` in production.
 *
 * The actual compilation still happens in the isolated build worker/container;
 * this function is the durable orchestration and artifact/DB state machine.
 */
export async function runClientBuildWorkflow(
  deps: ClientBuildWorkflowDeps,
  request: ClientBuildRequest,
  step: ClientBuildStepRunner = immediateStep,
): Promise<ClientBuildWorkflowResult> {
  const isolation = deps.isolation ?? DEFAULT_ISOLATION;
  assertBuildIsolation(isolation);
  const budgets = { ...DEFAULT_CLIENT_BUDGETS, ...(deps.budgets ?? {}), ...(request.budgets ?? {}) };
  const now = deps.now ?? Date.now;
  let archive: ClientArchive | undefined;
  try {
    archive = await step("validate-archive", async () => readClientArchive(request.zip, budgets));
    const effectiveBudgets = applyManifestBudgets(budgets, archive.manifest);
    const graph = await step("resolve-packages", async () =>
      resolveClientDependencies(archive!.manifest, { provider: deps.provider, budgets: effectiveBudgets }),
    );
    const modules = buildClientModuleMap(archive, graph);
    const bundle = await step("transform-bundle-validate", async () =>
      withTimeout(
        buildClientBundle({
          archive: archive!,
          graph,
          modules,
          budgets: effectiveBudgets,
          frameworkOptions: deps.frameworkOptions,
        }),
        effectiveBudgets.buildTimeoutMs,
        "transform/bundle/validate",
      ),
    );
    const lockfile = graph.lockfile;
    const published = await step("publish-artifacts", async () =>
      publishClientBuild({
        archive: archive!,
        archiveBytes: request.zip,
        graph,
        bundle,
        lockfile,
        budgets: effectiveBudgets,
        artifacts: deps.artifacts,
        repository: deps.repository,
        ...(request.sourceRef ? { sourceRef: request.sourceRef } : {}),
        ...(request.commit ? { commit: request.commit } : {}),
        now: now(),
      }),
    );
    return { published, archive, graph, bundle, lockfile };
  } catch (error) {
    const diagnostics =
      error instanceof ClientBuildError
        ? error.diagnostics
        : [diagnostic("build.failed", error instanceof Error ? error.message : String(error))];
    const existing = (error as { clientBuildRecord?: ClientBuildRecord }).clientBuildRecord;
    const failed: ClientBuildFailure = existing
      ? { record: existing, diagnostics }
      : await recordFailedBuild(deps, request, archive, diagnostics, now());
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { buildFailure: failed satisfies ClientBuildFailure },
    );
  }
}

async function recordFailedBuild(
  deps: ClientBuildWorkflowDeps,
  request: ClientBuildRequest,
  archive: ClientArchive | undefined,
  diagnostics: ClientBuildDiagnostic[],
  now: number,
): Promise<ClientBuildFailure> {
  const id = `b_${createHash("sha256")
    .update(request.zip)
    .update(request.sourceRef ?? "")
    .update(String(now))
    .digest("hex")
    .slice(0, 32)}`;
  const archiveBytes = request.zip.byteLength;
  const record: ClientBuildRecord = {
    id,
    status: "failed",
    ...(request.sourceRef ? { sourceRef: request.sourceRef } : {}),
    ...(request.commit ? { commit: request.commit } : {}),
    name: archive?.manifest.name ?? "invalid-client",
    version: archive?.manifest.version ?? "0.0.0",
    entry: archive?.entry ?? "",
    framework: archive?.manifest.framework ?? "vanilla",
    ...(archive ? { sourceHash: archive.sourceHash } : {}),
    sizes: {
      archiveBytes,
      unpackedBytes: archive?.unpackedBytes ?? 0,
      preOptimizationBytes: 0,
      bundleBytes: 0,
      assetBytes: 0,
    },
    keys: {},
    urls: {},
    assets: [],
    packages: [],
    diagnostics,
    warnings: archive?.warnings ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await deps.repository.save(record);
  return { record, diagnostics };
}

export function applyManifestBudgets(
  base: ClientBudgetConfig,
  manifest: ClientSubmissionManifest,
): ClientBudgetConfig {
  const requested = manifest.budgets ?? {};
  return {
    ...base,
    ...(requested.maxPreOptimizationBytes
      ? { maxPreOptimizationBytes: Math.min(base.maxPreOptimizationBytes, requested.maxPreOptimizationBytes) }
      : {}),
    ...(requested.maxBundleBytes
      ? { maxBundleBytes: Math.min(base.maxBundleBytes, requested.maxBundleBytes) }
      : {}),
  };
}

export function immediateStep<T>(_name: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}

/** Adapter for a Cloudflare Workflow `step` object. The build step itself must
 * delegate to the isolated container; this only maps names to durable steps. */
export interface WorkflowStepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export function cloudflareWorkflowStep(step: WorkflowStepLike): ClientBuildStepRunner {
  return (name, fn) => step.do(name, fn);
}

/** Wall-clock guard in addition to the container's CPU/memory limits. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase = "build",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ClientBuildError(`client ${phase} timed out`, [
              diagnostic(
                "build.timeout",
                `client ${phase} exceeded ${timeoutMs}ms; run builds in an isolated container with CPU/memory limits`,
              ),
            ], "internal"),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Convenience service wrapper. Production callers should run the workflow in a
 * Cloudflare Workflow whose build step delegates to an isolated container.
 */
export class ClientBuildService {
  constructor(readonly deps: ClientBuildWorkflowDeps) {}

  build(request: ClientBuildRequest, step: ClientBuildStepRunner = immediateStep) {
    return runClientBuildWorkflow(this.deps, request, step);
  }

  publish(input: PublishClientBuildInput) {
    return publishClientBuild(input);
  }
}

export function buildConfigHash(budgets: ClientBudgetConfig): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        builder: CLIENT_BUILDER_VERSION,
        budgets,
      }),
    )
    .digest("hex")}`;
}
