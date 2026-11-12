import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_CLIENT_BUDGETS, type ClientBudgetConfig } from "./constants.js";
import { diagnostic } from "./errors.js";
import { maxSatisfying, parseSemver, satisfies } from "./semver.js";
import { readNpmTarball } from "./tar.js";
import { ZipError } from "./zip.js";

export interface PackageJson {
  name?: string;
  version?: string;
  type?: "module" | "commonjs";
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  imports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  gypfile?: boolean;
  os?: string[];
  cpu?: string[];
  [key: string]: unknown;
}

export interface PackageVersionMetadata {
  name: string;
  version: string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  gypfile?: boolean;
  os?: string[];
  cpu?: string[];
}

export interface Packument {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions: Record<string, PackageVersionMetadata>;
}

export interface ResolvedPackage {
  name: string;
  version: string;
  files: Map<string, Uint8Array>;
  packageJson: PackageJson;
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  integrity?: string;
  tarballHash?: string;
  resolved?: string;
}

export interface PackageResolveContext {
  /** Directory of the package doing the importing, for nested node_modules. */
  fromDir?: string;
}

export interface PackageProvider {
  resolve(name: string, range: string, context?: PackageResolveContext): Promise<ResolvedPackage>;
}

export interface ContentAddressedCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export class MemoryContentCache implements ContentAddressedCache {
  private readonly entries = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.entries.get(key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.entries.set(key, bytes.slice());
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Filesystem cache for the build container. Content is addressed by hash. */
export class FileContentCache implements ContentAddressedCache {
  constructor(private readonly root: string) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(join(this.root, safeCacheKey(key))));
    } catch {
      return undefined;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = join(this.root, safeCacheKey(key));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}

function safeCacheKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface NpmRegistryOptions {
  registryUrl?: string;
  fetchImpl?: typeof fetch;
  cache?: ContentAddressedCache;
  budgets?: ClientBudgetConfig;
  /** Optional allowlist; empty/undefined means any registry package. */
  allowedPackages?: readonly string[];
  now?: () => number;
}

/**
 * Build-time npm package provider.
 *
 * This is NOT `npm install`: it downloads a packument and tarball, verifies
 * integrity, stores the tarball in a content-addressed cache, and parses it.
 * No lifecycle script is ever executed.
 */
export class NpmPackageProvider implements PackageProvider {
  private readonly registryUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache?: ContentAddressedCache;
  private readonly budgets: ClientBudgetConfig;
  private readonly allowed?: Set<string>;
  private readonly packuments = new Map<string, Packument>();

  constructor(options: NpmRegistryOptions = {}) {
    this.registryUrl = (options.registryUrl ?? "https://registry.npmjs.org").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cache = options.cache;
    this.budgets = options.budgets ?? DEFAULT_CLIENT_BUDGETS;
    this.allowed = options.allowedPackages ? new Set(options.allowedPackages) : undefined;
  }

  async getPackument(name: string): Promise<Packument> {
    const cached = this.packuments.get(name);
    if (cached) return cached;
    if (this.allowed && !this.allowed.has(name)) {
      throw new PackageError(
        "package.not_allowed",
        `${name} is not in the build service package allowlist`,
      );
    }
    const url = `${this.registryUrl}/${registryPath(name)}`;
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new PackageError(
        "package.registry_error",
        `npm registry returned ${response.status} for ${name}`,
      );
    }
    const packument = (await response.json()) as Packument;
    if (!packument || typeof packument !== "object" || !packument.versions) {
      throw new PackageError("package.registry_error", `invalid packument for ${name}`);
    }
    this.packuments.set(name, packument);
    return packument;
  }

  async resolve(name: string, range: string): Promise<ResolvedPackage> {
    const packument = await this.getPackument(name);
    const version = maxSatisfying(Object.keys(packument.versions), range);
    if (!version) {
      throw new PackageError(
        "package.no_matching_version",
        `${name}@${range} does not resolve to a published version`,
      );
    }
    const metadata = packument.versions[version]!;
    const tarballUrl = metadata.dist?.tarball;
    if (!tarballUrl) {
      throw new PackageError("package.no_tarball", `${name}@${version} has no tarball`);
    }
    const integrity = metadata.dist?.integrity;
    const tarball = await this.fetchTarball(name, version, tarballUrl, integrity, metadata.dist?.shasum);
    let files: Map<string, Uint8Array>;
    try {
      files = readNpmTarball(tarball, {
        maxTarballBytes: this.budgets.maxPackageTarballBytes,
        maxUnpackedBytes: this.budgets.maxUnpackedBytes,
        maxFiles: this.budgets.maxPackageFiles,
        maxFileBytes: this.budgets.maxArchiveFileBytes,
      });
    } catch (error) {
      if (error instanceof ZipError) {
        const code = error.code.startsWith("archive.")
          ? `package.${error.code.slice("archive.".length)}`
          : error.code;
        throw new PackageError(code, `${name}@${version}: ${error.message}`);
      }
      throw error;
    }
    const packageJsonBytes = files.get("package.json");
    if (!packageJsonBytes) {
      throw new PackageError("package.invalid", `${name}@${version} has no package.json`);
    }
    let packageJson: PackageJson;
    try {
      packageJson = JSON.parse(new TextDecoder().decode(packageJsonBytes)) as PackageJson;
    } catch {
      throw new PackageError("package.invalid", `${name}@${version} has invalid package.json`);
    }
    validateBrowserPackage(name, version, packageJson, files);
    return {
      name,
      version,
      files,
      packageJson,
      dependencies: packageJson.dependencies ?? {},
      optionalDependencies: packageJson.optionalDependencies,
      peerDependencies: packageJson.peerDependencies,
      integrity,
      tarballHash: sha256Hex(tarball),
      resolved: tarballUrl,
    };
  }

  private async fetchTarball(
    name: string,
    version: string,
    url: string,
    integrity: string | undefined,
    shasum: string | undefined,
  ): Promise<Uint8Array> {
    const integrityKey = integrity ? `npm/tarball/integrity/${integrity}` : undefined;
    const versionKey = `npm/tarball/${name}@${version}`;
    for (const key of [integrityKey, versionKey]) {
      if (!key) continue;
      const cached = await this.cache?.get(key);
      if (cached) return cached;
    }
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw new PackageError(
        "package.tarball_error",
        `could not download ${name}@${version}: HTTP ${response.status}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.budgets.maxPackageTarballBytes) {
      throw new PackageError(
        "package.tarball_too_large",
        `${name}@${version} tarball is ${bytes.byteLength} bytes; limit is ${this.budgets.maxPackageTarballBytes}`,
      );
    }
    const hash = sha256Hex(bytes);
    assertIntegrity(name, version, bytes, integrity, shasum);
    if (this.cache) {
      await this.cache.put(`npm/tarball/sha256/${hash}`, bytes);
      await this.cache.put(versionKey, bytes);
      if (integrityKey) await this.cache.put(integrityKey, bytes);
    }
    return bytes;
  }
}

export interface LocalPackageProviderOptions {
  /** Directory containing node_modules (normally the repository root). */
  rootDir: string;
  /** name -> package directory overrides for workspace packages. */
  workspaces?: Record<string, string>;
  budgets?: ClientBudgetConfig;
}

/**
 * Test/dev provider that treats an installed node_modules tree as a warm cache.
 * Production builds use NpmPackageProvider; this exists so examples and tests
 * do not need a live registry.
 */
export class LocalPackageProvider implements PackageProvider {
  private readonly rootDir: string;
  private readonly workspaces: Record<string, string>;
  private readonly budgets: ClientBudgetConfig;

  constructor(options: LocalPackageProviderOptions) {
    this.rootDir = options.rootDir;
    this.workspaces = options.workspaces ?? {};
    this.budgets = options.budgets ?? DEFAULT_CLIENT_BUDGETS;
  }

  async resolve(name: string, range: string, context?: PackageResolveContext): Promise<ResolvedPackage> {
    const directory = await this.findPackage(name, context?.fromDir);
    if (!directory) {
      throw new PackageError("package.not_found", `${name} is not installed locally`);
    }
    const packageJson = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as PackageJson;
    const version = packageJson.version ?? "0.0.0";
    if (!satisfies(version, range) && range !== "*" && range !== "latest") {
      throw new PackageError(
        "package.version_conflict",
        `${name}@${version} does not satisfy ${range}`,
      );
    }
    const files = await readPackageFiles(directory, this.budgets);
    validateBrowserPackage(name, version, packageJson, files);
    return {
      name,
      version,
      files,
      packageJson,
      dependencies: packageJson.dependencies ?? {},
      optionalDependencies: packageJson.optionalDependencies,
      peerDependencies: packageJson.peerDependencies,
      tarballHash: hashFiles(files),
      resolved: `local:${directory}`,
    };
  }

  private async findPackage(name: string, fromDir?: string): Promise<string | undefined> {
    const override = this.workspaces[name];
    if (override) return resolve(override);
    if (fromDir) {
      for (const candidate of nestedCandidates(name, fromDir, this.rootDir)) {
        if (await isDirectory(candidate)) return candidate;
      }
    }
    const direct = join(this.rootDir, "node_modules", ...name.split("/"));
    if (await isDirectory(direct)) return direct;
    return undefined;
  }
}

export class PackageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageError";
    this.code = code;
  }
}

export function validateBrowserPackage(
  name: string,
  version: string,
  packageJson: PackageJson,
  files: Map<string, Uint8Array>,
): void {
  const scripts = packageJson.scripts ?? {};
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (typeof scripts[lifecycle] === "string") {
      throw new PackageError(
        "package.lifecycle_script",
        `${name}@${version} declares a ${lifecycle} script; the builder never executes package scripts`,
      );
    }
  }
  if (packageJson.gypfile === true) {
    throw new PackageError("package.native_addon", `${name}@${version} uses node-gyp`);
  }
  if (packageJson.os && packageJson.os.length > 0) {
    throw new PackageError(
      "package.os_restricted",
      `${name}@${version} restricts operating systems (${packageJson.os.join(", ")}); it is not a browser package`,
    );
  }
  if (packageJson.cpu && packageJson.cpu.length > 0) {
    throw new PackageError(
      "package.cpu_restricted",
      `${name}@${version} restricts CPU architectures; it is not a browser package`,
    );
  }
  for (const path of files.keys()) {
    if (path.endsWith(".node") || path === "binding.gyp" || path.endsWith("/binding.gyp")) {
      throw new PackageError(
        "package.native_addon",
        `${name}@${version} contains ${path}; native addons cannot run in a browser`,
      );
    }
    if (path.endsWith(".wasm")) {
      throw new PackageError(
        "package.wasm",
        `${name}@${version} contains ${path}; WebAssembly is not enabled in the client sandbox`,
      );
    }
  }
  const entry = resolvePackageEntry(packageJson, files, "");
  if (!entry) {
    const hasRuntimeFiles = [...files.keys()].some(
      (path) =>
        /\.(?:[cm]?js|jsx|ts|tsx|vue|svelte)$/.test(path) && !path.endsWith(".d.ts"),
    );
    if (!hasRuntimeFiles) return; // Type-only package; imports are erased by esbuild.
    throw new PackageError(
      "package.no_browser_entry",
      `${name}@${version} has no resolvable browser entrypoint`,
    );
  }
  if (!/\.(?:[cm]?js|jsx|ts|tsx|json|vue|svelte)$/.test(entry)) {
    throw new PackageError(
      "package.not_browser_compatible",
      `${name}@${version} entry ${entry} is not browser JavaScript`,
    );
  }
}

/** Resolve a package entry/subpath to a virtual file path inside the package. */
export function resolvePackageEntry(
  packageJson: PackageJson,
  files: Map<string, Uint8Array>,
  subpath: string,
): string | undefined {
  const normalizedSubpath = subpath.replace(/^\.\//, "").replace(/^\/+/, "");
  const possible = new Set<string>();
  const exportsValue = packageJson.exports;
  if (exportsValue !== undefined) {
    const fromExports = resolveExports(exportsValue, normalizedSubpath ? `./${normalizedSubpath}` : ".");
    if (fromExports) possible.add(fromExports);
  }
  const browser = packageJson.browser;
  if (typeof browser === "string" && !normalizedSubpath) possible.add(browser);
  if (browser && typeof browser === "object" && !normalizedSubpath) {
    const mapped = browser["./index.js"] ?? browser["./lib/index.js"];
    if (typeof mapped === "string") possible.add(mapped);
  }
  if (!normalizedSubpath) {
    if (packageJson.module) possible.add(packageJson.module);
    if (packageJson.main) possible.add(packageJson.main);
    possible.add("index.js");
  } else {
    possible.add(normalizedSubpath);
    possible.add(`${normalizedSubpath}.js`);
    possible.add(`${normalizedSubpath}.mjs`);
    possible.add(`${normalizedSubpath}.cjs`);
    possible.add(`${normalizedSubpath}/index.js`);
  }
  for (const candidate of possible) {
    const cleaned = candidate.replace(/^\.\//, "").replace(/^\/+/, "");
    if (files.has(cleaned)) return cleaned;
    for (const extension of [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".vue", ".svelte"]) {
      if (files.has(`${cleaned}${extension}`)) return `${cleaned}${extension}`;
    }
    if (files.has(`${cleaned}/index.js`)) return `${cleaned}/index.js`;
  }
  return undefined;
}

function resolveExports(value: unknown, subpath: string): string | undefined {
  if (typeof value === "string") return subpath === "." ? value : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  const usesSubpaths = keys.some((key) => key === "." || key.startsWith("./"));
  if (!usesSubpaths) {
    return pickCondition(value);
  }
  if (subpath === "." && typeof object["."] !== "undefined") {
    return pickCondition(object["."]);
  }
  const exact = object[subpath];
  if (typeof exact !== "undefined") return pickCondition(exact);
  for (const key of keys) {
    if (!key.includes("*")) continue;
    const [prefix, suffix] = key.split("*");
    if (
      subpath.startsWith(prefix ?? "") &&
      subpath.endsWith(suffix ?? "") &&
      subpath.length >= (prefix?.length ?? 0) + (suffix?.length ?? 0)
    ) {
      const replacement = subpath.slice(prefix?.length ?? 0, subpath.length - (suffix?.length ?? 0));
      const target = pickCondition(object[key]);
      if (target) return target.replace("*", replacement);
    }
  }
  return undefined;
}

function pickCondition(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const condition of ["browser", "import", "module", "default"]) {
    const picked = pickCondition(object[condition]);
    if (picked) return picked;
  }
  for (const condition of ["require", "node"]) {
    const picked = pickCondition(object[condition]);
    if (picked) return picked;
  }
  return undefined;
}

async function readPackageFiles(
  directory: string,
  budgets: ClientBudgetConfig,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".bin") continue;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= budgets.maxPackageFiles) {
        throw new PackageError(
          "package.too_many_files",
          `package at ${directory} has more than ${budgets.maxPackageFiles} files`,
        );
      }
      const data = new Uint8Array(await readFile(path));
      if (data.byteLength > budgets.maxArchiveFileBytes) continue;
      total += data.byteLength;
      if (total > budgets.maxUnpackedBytes) {
        throw new PackageError(
          "package.unpacked_too_large",
          `package at ${directory} exceeds the unpacked package budget`,
        );
      }
      files.set(relative(directory, path).split(sep).join("/"), data);
    }
  }
  await walk(directory);
  return files;
}

function nestedCandidates(name: string, fromDir: string, root: string): string[] {
  const candidates: string[] = [];
  let current = resolve(fromDir);
  const rootResolved = resolve(root);
  while (true) {
    candidates.push(join(current, "node_modules", ...name.split("/")));
    if (current === rootResolved) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function hashFiles(files: Map<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files.get(path)!);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertIntegrity(
  name: string,
  version: string,
  bytes: Uint8Array,
  integrity?: string,
  shasum?: string,
): void {
  if (integrity) {
    const [algorithm, value] = integrity.split("-", 2);
    if (algorithm && value) {
      const digest = createHash(algorithm).update(bytes).digest("base64");
      if (digest !== value) {
        throw new PackageError(
          "package.integrity",
          `${name}@${version} failed ${algorithm} integrity verification`,
        );
      }
      return;
    }
  }
  if (shasum) {
    const digest = createHash("sha1").update(bytes).digest("hex");
    if (digest !== shasum) {
      throw new PackageError("package.integrity", `${name}@${version} failed sha1 verification`);
    }
  }
}

function registryPath(name: string): string {
  if (name.startsWith("@")) {
    return `@${encodeURIComponent(name.slice(1))}`;
  }
  return encodeURIComponent(name);
}

export function packageDiagnostic(error: unknown, file?: string) {
  if (error instanceof PackageError) {
    return diagnostic(error.code, error.message, { file });
  }
  return diagnostic("package.failed", error instanceof Error ? error.message : String(error), { file });
}
