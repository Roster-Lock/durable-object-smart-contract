import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CLIENT_BUDGETS,
  MemoryClientArtifactStore,
  MemoryClientBuildRepository,
  createZip,
  immediateStep,
  runClientBuildWorkflow,
  type ClientBuildRepository,
  type ClientBuildWorkflowDeps,
  type ClientBuildWorkflowResult,
  type ClientBudgetConfig,
  type ClientSubmissionManifest,
  type PackageProvider,
  type ResolvedPackage,
} from "@roster-lock/smart-contract-client-builder";
import { LocalPackageProvider, satisfies } from "@roster-lock/smart-contract-client-builder";

export const ROOT = process.cwd();

export function manifest(
  overrides: Partial<ClientSubmissionManifest> = {},
): ClientSubmissionManifest {
  return {
    schemaVersion: 1,
    name: "test-client",
    version: "1.0.0",
    entry: "src/client.tsx",
    framework: "react",
    ...overrides,
  };
}

export function makeClientZip(
  files: Record<string, string | Uint8Array>,
  overrides: Partial<ClientSubmissionManifest> = {},
  manifestOverride?: Record<string, unknown>,
): Uint8Array {
  const entries = Object.entries(files).map(([name, data]) => ({ name, data }));
  if (!files["client.json"]) {
    const value = manifestOverride ?? manifest(overrides);
    entries.push({ name: "client.json", data: JSON.stringify(value, null, 2) });
  }
  return createZip(entries);
}

export function localProvider(): PackageProvider {
  return new LocalPackageProvider({
    rootDir: ROOT,
    workspaces: {
      "@roster-lock/smart-contract-sdk": join(ROOT, "shared", "sdk"),
      "@roster-lock/smart-contract-client-host": join(ROOT, "shared", "client-host"),
    },
  });
}

export class StaticPackageProvider implements PackageProvider {
  constructor(
    private readonly packages: Record<
      string,
      { version: string; files: Record<string, string | Uint8Array>; packageJson?: Record<string, unknown> }
    >,
  ) {}

  async resolve(name: string, range: string): Promise<ResolvedPackage> {
    const pkg = this.packages[name];
    if (!pkg) throw new Error(`missing fake package ${name}`);
    if (!satisfies(pkg.version, range)) {
      throw new Error(`${name}@${pkg.version} does not satisfy ${range}`);
    }
    const files = new Map<string, Uint8Array>();
    for (const [path, data] of Object.entries(pkg.files)) {
      files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    }
    const packageJson = {
      name,
      version: pkg.version,
      main: "index.js",
      ...(pkg.packageJson ?? {}),
    };
    return {
      name,
      version: pkg.version,
      files,
      packageJson,
      dependencies: (pkg.packageJson?.dependencies as Record<string, string> | undefined) ?? {},
      tarballHash: `sha256:${name}`,
    };
  }
}

export interface MemoryDeps {
  provider: PackageProvider;
  artifacts: MemoryClientArtifactStore;
  repository: MemoryClientBuildRepository;
  deps: ClientBuildWorkflowDeps;
}

export function memoryDeps(provider: PackageProvider = localProvider()): MemoryDeps {
  const artifacts = new MemoryClientArtifactStore();
  const repository = new MemoryClientBuildRepository();
  return {
    provider,
    artifacts,
    repository,
    deps: {
      provider,
      artifacts,
      repository,
      isolation: { mode: "ci" },
    },
  };
}

export async function buildClientZip(
  zip: Uint8Array,
  options: {
    provider?: PackageProvider;
    budgets?: Partial<ClientBudgetConfig>;
    artifacts?: MemoryClientArtifactStore;
    repository?: ClientBuildRepository;
  } = {},
): Promise<ClientBuildWorkflowResult> {
  const memory = memoryDeps(options.provider ?? localProvider());
  return runClientBuildWorkflow(
    {
      ...memory.deps,
      ...(options.artifacts ? { artifacts: options.artifacts } : {}),
      ...(options.repository ? { repository: options.repository } : {}),
      ...(options.budgets ? { budgets: { ...DEFAULT_CLIENT_BUDGETS, ...options.budgets } } : {}),
    },
    { zip },
    immediateStep,
  );
}

export function exampleFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

export function exampleZip(
  directory: string,
  manifestFile: string,
  files: readonly string[],
  overrides: Partial<ClientSubmissionManifest> = {},
): Uint8Array {
  const entries = files.map((file) => ({
    name: file,
    data: exampleFile(join(directory, file)),
  }));
  const submission = JSON.parse(exampleFile(manifestFile)) as ClientSubmissionManifest;
  entries.push({ name: "client.json", data: JSON.stringify({ ...submission, ...overrides }) });
  return createZip(entries);
}
