import { createHash } from "node:crypto";
import {
  CLIENT_MANIFEST_ALIASES,
  CLIENT_MANIFEST_FILENAME,
  CLIENT_SUBMISSION_SCHEMA_VERSION,
  DEFAULT_CLIENT_BUDGETS,
  type ClientBudgetConfig,
} from "./constants.js";
import { ClientBuildError, diagnostic } from "./errors.js";
import { parseSemver } from "./semver.js";
import type { ClientFramework, ClientSubmissionManifest } from "./types.js";
import { readZip, ZipError, type ZipEntry } from "./zip.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]);
const ASSET_EXTENSIONS = new Set([
  ".css",
  ".json",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);
const FORBIDDEN_EXTENSIONS = new Map<string, string>([
  [".node", "native addons cannot run in the browser"],
  [".wasm", "WebAssembly is not enabled in the client sandbox"],
  [".html", "HTML files are not client entrypoints; return a DOM node instead"],
  [".zip", "nested archives are not allowed"],
  [".tar", "nested archives are not allowed"],
  [".tgz", "nested archives are not allowed"],
  [".gz", "nested archives are not allowed"],
  [".exe", "executables are not allowed"],
  [".dll", "native libraries are not allowed"],
  [".so", "native libraries are not allowed"],
  [".dylib", "native libraries are not allowed"],
  [".sh", "shell scripts are not allowed"],
  [".bat", "scripts are not allowed"],
  [".ps1", "scripts are not allowed"],
  [".py", "scripts are not allowed"],
  [".rb", "scripts are not allowed"],
  [".go", "source for other runtimes is not allowed"],
  [".rs", "source for other runtimes is not allowed"],
]);
const FRAMEWORKS = new Set<ClientFramework>(["react", "vue", "svelte", "angular", "vanilla"]);
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const VERSION_RANGE_RE = /^[0-9A-Za-z.*^~<>=|xX\s-]+$/;

export interface ClientArchiveAsset {
  path: string;
  data: Uint8Array;
  contentType: string;
  kind: "asset" | "style";
}

export interface ClientArchive {
  manifest: ClientSubmissionManifest;
  manifestSource: string;
  entry: string;
  files: Map<string, Uint8Array>;
  assets: Map<string, ClientArchiveAsset>;
  archiveBytes: number;
  unpackedBytes: number;
  sourceHash: string;
  warnings: string[];
}

export function readClientArchive(
  bytes: Uint8Array,
  budgets: ClientBudgetConfig = DEFAULT_CLIENT_BUDGETS,
): ClientArchive {
  if (bytes.byteLength === 0) {
    throw new ClientBuildError("archive is empty", [
      diagnostic("archive.empty", "archive is empty"),
    ], "archive");
  }
  let zip;
  try {
    zip = readZip(bytes, {
      maxArchiveBytes: budgets.maxArchiveBytes,
      maxUnpackedBytes: budgets.maxUnpackedBytes,
      maxFiles: budgets.maxArchiveFiles,
      maxFileBytes: budgets.maxArchiveFileBytes,
    });
  } catch (error) {
    if (error instanceof ZipError) {
      throw new ClientBuildError(error.message, [diagnostic(error.code, error.message)], "archive");
    }
    throw error;
  }

  const files = new Map<string, Uint8Array>();
  const assets = new Map<string, ClientArchiveAsset>();
  const warnings: string[] = [];
  const manifests: ZipEntry[] = [];
  let totalFileBytes = 0;

  for (const entry of zip.entries) {
    if (entry.isDirectory) continue;
    if (CLIENT_MANIFEST_ALIASES.includes(entry.name)) {
      manifests.push(entry);
      continue;
    }
    if (CLIENT_MANIFEST_ALIASES.some((name) => entry.name.endsWith(`/${name}`))) {
      throw new ClientBuildError("multiple manifests", [
        diagnostic(
          "archive.multiple_manifests",
          `found a second manifest at ${JSON.stringify(entry.name)}; the manifest (client.json or manifest.json) must be at the archive root`,
          { file: entry.name },
        ),
      ], "archive", entry.name);
    }
    const lower = entry.name.toLowerCase();
    if (
      lower === "package.json" ||
      lower.endsWith("/package.json") ||
      lower === "package-lock.json" ||
      lower === "npm-shrinkwrap.json"
    ) {
      throw new ClientBuildError("build scripts are not allowed", [
        diagnostic(
          "archive.build_scripts",
          `${entry.name} is not allowed; dependencies belong in client.json and package scripts are never run`,
          { file: entry.name },
        ),
      ], "archive", entry.name);
    }
    if (
      lower === ".npmrc" ||
      lower === ".yarnrc" ||
      lower === "binding.gyp" ||
      lower === ".env" ||
      lower.startsWith(".env.") ||
      lower.includes("secret") ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key")
    ) {
      throw new ClientBuildError("archive contains a forbidden file", [
        diagnostic(
          "archive.forbidden_file",
          `${entry.name} is not allowed in a client archive`,
          { file: entry.name },
        ),
      ], "archive", entry.name);
    }
    if (lower.startsWith("node_modules/") || lower.includes("/node_modules/")) {
      throw new ClientBuildError("node_modules is not allowed", [
        diagnostic(
          "archive.node_modules",
          "do not upload node_modules; declare dependencies in client.json",
          { file: entry.name },
        ),
      ], "archive", entry.name);
    }
    if (lower.startsWith(".git/") || lower.includes("/.git/")) {
      throw new ClientBuildError("git metadata is not allowed", [
        diagnostic("archive.forbidden_file", `${entry.name} is not allowed`, { file: entry.name }),
      ], "archive", entry.name);
    }

    const extension = extensionOf(entry.name);
    const forbidden = FORBIDDEN_EXTENSIONS.get(extension);
    if (forbidden) {
      throw new ClientBuildError(`extension ${extension} is not allowed`, [
        diagnostic("archive.extension", `${entry.name}: ${forbidden}`, { file: entry.name }),
      ], "archive", entry.name);
    }
    if (extension === ".css") {
      assets.set(entry.name, {
        path: entry.name,
        data: entry.data,
        contentType: "text/css",
        kind: "style",
      });
      totalFileBytes += entry.data.byteLength;
      continue;
    }
    if (ASSET_EXTENSIONS.has(extension)) {
      assets.set(entry.name, {
        path: entry.name,
        data: entry.data,
        contentType: contentTypeFor(entry.name),
        kind: "asset",
      });
      totalFileBytes += entry.data.byteLength;
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extension)) {
      throw new ClientBuildError(`extension ${extension || "(none)"} is not allowed`, [
        diagnostic(
          "archive.extension",
          `${entry.name}: allowed source extensions are ${[...SOURCE_EXTENSIONS].join(", ")}; assets may be ${[
            ...ASSET_EXTENSIONS,
          ].join(", ")}`,
          { file: entry.name },
        ),
      ], "archive", entry.name);
    }
    files.set(entry.name, entry.data);
    totalFileBytes += entry.data.byteLength;
  }

  if (manifests.length === 0) {
    throw new ClientBuildError("client.json is missing", [
      diagnostic(
        "archive.missing_manifest",
        `the archive must contain ${CLIENT_MANIFEST_FILENAME} at its root`,
      ),
    ], "archive");
  }
  if (manifests.length > 1) {
    throw new ClientBuildError("multiple manifests", [
      diagnostic("archive.multiple_manifests", "exactly one client.json/manifest.json is allowed"),
    ], "archive");
  }
  const manifestBytes = manifests[0]!.data;
  const manifestSource = new TextDecoder().decode(manifestBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestSource);
  } catch (error) {
    throw new ClientBuildError("client.json is not valid JSON", [
      diagnostic(
        "manifest.invalid_json",
        error instanceof Error ? error.message : String(error),
        { file: CLIENT_MANIFEST_FILENAME },
      ),
    ], "manifest", CLIENT_MANIFEST_FILENAME);
  }
  const manifest = validateSubmissionManifest(parsed);
  const entry = manifest.entry;
  if (!files.has(entry)) {
    throw new ClientBuildError("entrypoint is missing", [
      diagnostic(
        "archive.entry_missing",
        `entry ${JSON.stringify(entry)} is not a source file in the archive`,
        { file: CLIENT_MANIFEST_FILENAME, hint: "check the \"entry\" field" },
      ),
    ], "archive", CLIENT_MANIFEST_FILENAME);
  }
  const entryExtension = extensionOf(entry);
  if (!SOURCE_EXTENSIONS.has(entryExtension)) {
    throw new ClientBuildError("entrypoint has an unsupported extension", [
      diagnostic(
        "archive.entry_extension",
        `entry ${JSON.stringify(entry)} has extension ${entryExtension}; use TS, TSX, JS, JSX or a supported framework SFC`,
        { file: entry },
      ),
    ], "archive", entry);
  }
  if (manifest.framework === "react" && entryExtension === ".vue") {
    warnings.push("framework is react but the entrypoint is a Vue SFC; the Vue adapter will be used");
  }

  const sourceHash = hashArchive(manifests[0]!, files, assets);
  return {
    manifest,
    manifestSource,
    entry,
    files,
    assets,
    archiveBytes: bytes.byteLength,
    unpackedBytes: totalFileBytes,
    sourceHash,
    warnings,
  };
}

export function validateSubmissionManifest(value: unknown): ClientSubmissionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientBuildError("client.json must be an object", [
      diagnostic("manifest.invalid", "client.json must be a JSON object"),
    ], "manifest", CLIENT_MANIFEST_FILENAME);
  }
  const object = value as Record<string, unknown>;
  const issues = [];
  const allowedFields = new Set([
    "schemaVersion",
    "name",
    "version",
    "entry",
    "framework",
    "dependencies",
    "jsxImportSource",
    "description",
    "budgets",
  ]);
  for (const field of Object.keys(object)) {
    if (!allowedFields.has(field)) {
      issues.push(
        diagnostic("manifest.unknown_field", `unknown manifest field ${JSON.stringify(field)}`, {
          file: CLIENT_MANIFEST_FILENAME,
        }),
      );
    }
  }
  if (object.schemaVersion !== CLIENT_SUBMISSION_SCHEMA_VERSION) {
    issues.push(
      diagnostic(
        "manifest.schema_version",
        `schemaVersion must be ${CLIENT_SUBMISSION_SCHEMA_VERSION}`,
        { file: CLIENT_MANIFEST_FILENAME },
      ),
    );
  }
  if (typeof object.name !== "string" || object.name.trim().length === 0 || object.name.length > 128) {
    issues.push(diagnostic("manifest.name", "name must be a non-empty string of at most 128 characters"));
  }
  if (typeof object.version !== "string" || !parseSemver(object.version)) {
    issues.push(diagnostic("manifest.version", "version must be a valid semver version"));
  }
  if (typeof object.entry !== "string" || object.entry.trim().length === 0) {
    issues.push(diagnostic("manifest.entry", "entry must be a non-empty path"));
  } else if (
    object.entry.startsWith("/") ||
    object.entry.startsWith("../") ||
    object.entry.includes("\\") ||
    object.entry.split("/").some((segment) => segment === "..")
  ) {
    issues.push(diagnostic("manifest.entry", "entry must be a relative path inside the archive"));
  }
  if (typeof object.framework !== "string" || !FRAMEWORKS.has(object.framework as ClientFramework)) {
    issues.push(
      diagnostic(
        "manifest.framework",
        `framework must be one of ${[...FRAMEWORKS].join(", ")}`,
      ),
    );
  }
  if (object.dependencies !== undefined) {
    if (!object.dependencies || typeof object.dependencies !== "object" || Array.isArray(object.dependencies)) {
      issues.push(diagnostic("manifest.dependencies", "dependencies must be an object"));
    } else {
      for (const [name, range] of Object.entries(object.dependencies)) {
        if (!PACKAGE_NAME_RE.test(name)) {
          issues.push(diagnostic("manifest.dependency_name", `${JSON.stringify(name)} is not a valid npm package name`));
        }
        if (typeof range !== "string" || !range.trim() || !VERSION_RANGE_RE.test(range)) {
          issues.push(
            diagnostic(
              "manifest.dependency_range",
              `${name}: ${JSON.stringify(range)} is not a semver range; git, file, URL and workspace specifiers are not allowed`,
            ),
          );
        }
      }
    }
  }
  if (object.jsxImportSource !== undefined) {
    if (
      typeof object.jsxImportSource !== "string" ||
      !PACKAGE_NAME_RE.test(object.jsxImportSource)
    ) {
      issues.push(diagnostic("manifest.jsx_import_source", "jsxImportSource must be a package name"));
    }
  }
  if (
    object.description !== undefined &&
    (typeof object.description !== "string" || object.description.length > 2000)
  ) {
    issues.push(diagnostic("manifest.description", "description must be a string of at most 2000 characters"));
  }
  if (object.budgets !== undefined) {
    if (!object.budgets || typeof object.budgets !== "object" || Array.isArray(object.budgets)) {
      issues.push(diagnostic("manifest.budgets", "budgets must be an object"));
    } else {
      const budgets = object.budgets as Record<string, unknown>;
      for (const key of ["maxPreOptimizationBytes", "maxBundleBytes"]) {
        const value = budgets[key];
        if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) {
          issues.push(diagnostic("manifest.budgets", `${key} must be a positive integer`));
        }
      }
    }
  }
  if (issues.length > 0) {
    throw new ClientBuildError("client.json is invalid", issues, "manifest", CLIENT_MANIFEST_FILENAME);
  }
  const dependencies = object.dependencies
    ? Object.fromEntries(
        Object.entries(object.dependencies as Record<string, string>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      )
    : undefined;
  return {
    schemaVersion: 1,
    name: (object.name as string).trim(),
    version: object.version as string,
    entry: (object.entry as string).replace(/^\.\//, ""),
    framework: object.framework as ClientFramework,
    ...(dependencies ? { dependencies } : {}),
    ...(typeof object.jsxImportSource === "string"
      ? { jsxImportSource: object.jsxImportSource }
      : {}),
    ...(typeof object.description === "string" ? { description: object.description } : {}),
    ...(object.budgets ? { budgets: object.budgets as ClientSubmissionManifest["budgets"] } : {}),
  };
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function contentTypeFor(path: string): string {
  switch (extensionOf(path)) {
    case ".css":
      return "text/css";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function hashArchive(
  manifest: ZipEntry,
  files: Map<string, Uint8Array>,
  assets: Map<string, ClientArchiveAsset>,
): string {
  const hash = createHash("sha256");
  const paths = [
    manifest.name,
    ...files.keys(),
    ...[...assets.keys()].map((path) => `asset:${path}`),
  ].sort();
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    if (path === manifest.name) hash.update(manifest.data);
    else if (path.startsWith("asset:")) hash.update(assets.get(path.slice("asset:".length))!.data);
    else hash.update(files.get(path)!);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export const CLIENT_ARCHIVE_SOURCE_EXTENSIONS = [...SOURCE_EXTENSIONS];
export const CLIENT_ARCHIVE_ASSET_EXTENSIONS = [...ASSET_EXTENSIONS];
