import { createHash } from "node:crypto";
import type { ClientArchive } from "./archive.js";
import { ClientBuildError, diagnostic } from "./errors.js";
import { DEFAULT_CLIENT_BUDGETS, type ClientBudgetConfig } from "./constants.js";
import { packageDiagnostic, type PackageProvider, type ResolvedPackage } from "./packages.js";
import { satisfies } from "./semver.js";
import type { ClientLockfile, ClientPackagePin, ClientSubmissionManifest } from "./types.js";

export interface ResolvedPackageInstance extends ResolvedPackage {
  /** `${name}@${version}` */
  key: string;
  /** Virtual directory, either node_modules/<name> or a nested .roster path. */
  root: string;
  /** Dependency name -> instance key. */
  edges: Map<string, string>;
}

export interface ResolvedClientGraph {
  /** All instances, keyed by `${name}@${version}`. */
  packages: Map<string, ResolvedPackageInstance>;
  /** Hoisted instances used for archive imports and fallback resolution. */
  roots: Map<string, ResolvedPackageInstance>;
  lockfile: ClientLockfile;
  pins: ClientPackagePin[];
  warnings: string[];
}

export interface ResolveDependenciesOptions {
  provider: PackageProvider;
  budgets?: ClientBudgetConfig;
}

interface Request {
  name: string;
  range: string;
  fromKey?: string;
  direct: boolean;
}

/**
 * Resolve the dependency graph, allowing nested versions when packages cannot
 * agree (the same rule npm uses). A package that is not hoisted gets a stable
 * virtual root under node_modules/.roster and is reached only through its
 * importer.
 */
export async function resolveClientDependencies(
  manifest: ClientSubmissionManifest,
  options: ResolveDependenciesOptions,
): Promise<ResolvedClientGraph> {
  const budgets = options.budgets ?? DEFAULT_CLIENT_BUDGETS;
  const packages = new Map<string, ResolvedPackageInstance>();
  const roots = new Map<string, ResolvedPackageInstance>();
  const warnings: string[] = [];
  const queue: Request[] = Object.entries(manifest.dependencies ?? {}).map(([name, range]) => ({
    name,
    range,
    direct: true,
  }));

  while (queue.length > 0) {
    const request = queue.shift()!;
    const parent = request.fromKey ? packages.get(request.fromKey) : undefined;
    const existingEdge = parent?.edges.get(request.name);
    if (existingEdge) {
      const edge = packages.get(existingEdge);
      if (edge && satisfies(edge.version, request.range)) continue;
    }
    const hoisted = roots.get(request.name);
    if (hoisted && satisfies(hoisted.version, request.range)) {
      if (parent) parent.edges.set(request.name, hoisted.key);
      if (request.direct && !roots.has(request.name)) roots.set(request.name, hoisted);
      continue;
    }
    if (request.direct && hoisted && !satisfies(hoisted.version, request.range)) {
      throw conflict(request.name, hoisted.version, request.range, request.fromKey, packages);
    }
    if (packages.size >= budgets.maxPackages) {
      throw new ClientBuildError("too many packages", [
        diagnostic(
          "package.too_many",
          `resolved graph has more than ${budgets.maxPackages} package instances`,
        ),
      ], "packages");
    }
    let resolved: ResolvedPackage;
    try {
      resolved = await options.provider.resolve(request.name, request.range, {
        fromDir: parent?.root,
      });
    } catch (error) {
      throw new ClientBuildError(
        `could not resolve ${request.name}@${request.range}`,
        [packageDiagnostic(error)],
        "packages",
      );
    }
    const key = `${resolved.name}@${resolved.version}`;
    let instance = packages.get(key);
    const created = !instance;
    if (!instance) {
      const becomesRoot = !roots.has(resolved.name);
      instance = {
        ...resolved,
        key,
        root: becomesRoot
          ? packageVirtualDir(resolved.name)
          : nestedPackageVirtualDir(resolved.name, resolved.version),
        edges: new Map(),
      };
      packages.set(key, instance);
      if (becomesRoot) roots.set(resolved.name, instance);
    }
    if (request.direct) {
      const currentRoot = roots.get(instance.name);
      if (currentRoot && currentRoot.key !== instance.key) {
        throw conflict(instance.name, currentRoot.version, request.range, request.fromKey, packages);
      }
      roots.set(instance.name, instance);
    }
    if (parent) parent.edges.set(request.name, instance.key);
    if (created) {
      for (const [name, range] of Object.entries(instance.dependencies)) {
        if (
          !range ||
          range.startsWith("workspace:") ||
          range.startsWith("link:") ||
          range.startsWith("file:")
        ) {
          throw new ClientBuildError("unsupported dependency specifier", [
            diagnostic(
              "package.specifier",
              `${instance.name} depends on ${name}@${range}; build-time packages must come from the npm registry`,
            ),
          ], "packages");
        }
        queue.push({ name, range, fromKey: instance.key, direct: false });
      }
      if (instance.optionalDependencies && Object.keys(instance.optionalDependencies).length > 0) {
        warnings.push(
          `${instance.name} declares optional dependencies; they are not installed automatically`,
        );
      }
    }
  }

  const lockfile: ClientLockfile = { lockfileVersion: 1, packages: {} };
  const pins: ClientPackagePin[] = [];
  for (const instance of [...packages.values()].sort((a, b) => a.root.localeCompare(b.root))) {
    lockfile.packages[instance.root] = {
      version: instance.version,
      ...(instance.integrity ? { integrity: instance.integrity } : {}),
      ...(instance.tarballHash ? { tarballHash: instance.tarballHash } : {}),
      dependencies: instance.dependencies,
      files: [...instance.files.keys()].sort(),
    };
    pins.push({
      name: instance.name,
      version: instance.version,
      ...(instance.integrity ? { integrity: instance.integrity } : {}),
      ...(instance.tarballHash ? { tarballHash: instance.tarballHash } : {}),
      dependencies: instance.dependencies,
    });
  }
  return { packages, roots, lockfile, pins, warnings };
}

export interface ClientModuleMap {
  /** Virtual path -> bytes. Archive paths and package roots. */
  files: Map<string, Uint8Array>;
  /** Hoisted package name -> virtual root, for archive imports. */
  rootPackages: Map<string, string>;
  /** Virtual package root -> name/version, for identifying an importer. */
  packageRoots: Map<string, { name: string; version: string }>;
  /** Importer root -> dependency name -> target root. */
  packageEdges: Map<string, Map<string, string>>;
  /** Total bytes of archive source + package files. */
  sourceBytes: number;
}

export function buildClientModuleMap(
  archive: ClientArchive,
  graph: ResolvedClientGraph,
): ClientModuleMap {
  const files = new Map<string, Uint8Array>();
  const rootPackages = new Map<string, string>();
  const packageRoots = new Map<string, { name: string; version: string }>();
  const packageEdges = new Map<string, Map<string, string>>();
  let sourceBytes = 0;
  for (const [path, data] of archive.files) {
    files.set(path, data);
    sourceBytes += data.byteLength;
  }
  for (const instance of graph.packages.values()) {
    packageRoots.set(instance.root, { name: instance.name, version: instance.version });
    const edges = new Map<string, string>();
    for (const [depName, depKey] of instance.edges) {
      const dep = graph.packages.get(depKey);
      if (dep) edges.set(depName, dep.root);
    }
    packageEdges.set(instance.root, edges);
    for (const [path, data] of instance.files) {
      files.set(`${instance.root}/${path}`, data);
      sourceBytes += data.byteLength;
    }
  }
  for (const [name, instance] of graph.roots) {
    rootPackages.set(name, instance.root);
  }
  return { files, rootPackages, packageRoots, packageEdges, sourceBytes };
}

export function packageVirtualDir(name: string): string {
  return `node_modules/${name}`;
}

export function nestedPackageVirtualDir(name: string, version: string): string {
  const safe = name.replace(/^@/, "").replace(/\//g, "+");
  return `node_modules/.roster/${safe}@${version}`;
}

export function lockfileHash(lockfile: ClientLockfile): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(lockfile)).digest("hex")}`;
}

function conflict(
  name: string,
  version: string,
  range: string,
  fromKey: string | undefined,
  packages: Map<string, ResolvedPackageInstance>,
): ClientBuildError {
  const from = fromKey ? packages.get(fromKey)?.name : undefined;
  return new ClientBuildError(`conflicting versions for ${name}`, [
    diagnostic(
      "package.version_conflict",
      `${name}@${version} does not satisfy ${range}${from ? ` (required by ${from})` : ""}`,
      { hint: "make the direct dependency ranges agree, or rely on nested resolution for transitives" },
    ),
  ], "packages");
}
