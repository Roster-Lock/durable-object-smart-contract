import { createHash } from "node:crypto";
import { extname } from "node:path";
import { build as esbuildBuild, transform as esbuildTransform, type Plugin } from "esbuild";
import { rollup, type OutputChunk, type RollupError, type RollupLog } from "rollup";
import type { ClientArchive } from "./archive.js";
import {
  CLIENT_BUILDER_VERSION,
  DEFAULT_CLIENT_BUDGETS,
  type ClientBudgetConfig,
} from "./constants.js";
import { ClientBuildError, diagnostic } from "./errors.js";
import {
  selectFrameworkAdapter,
  type FrameworkAdapter,
  type FrameworkAdapterOptions,
} from "./frameworks.js";
import {
  resolvePackageEntry,
  type PackageJson,
} from "./packages.js";
import type { ClientModuleMap, ResolvedClientGraph } from "./resolver.js";
import { validateClientJavaScript } from "./validator.js";

export interface ClientBundleInput {
  archive: ClientArchive;
  graph: ResolvedClientGraph;
  modules: ClientModuleMap;
  budgets?: ClientBudgetConfig;
  frameworkOptions?: FrameworkAdapterOptions;
}

export interface ClientBundleAsset {
  path: string;
  key: string;
  url: string;
  hash: string;
  data: Uint8Array;
  contentType: string;
}

export interface ClientBundleOutput {
  bundle: string;
  unminified: string;
  preOptimizationBytes: number;
  bundleBytes: number;
  assets: ClientBundleAsset[];
  styles: string[];
  sourceBytes: number;
  warnings: string[];
  builderVersion: string;
}

interface BuildContext {
  modules: ClientModuleMap;
  packageJsonCache: Map<string, PackageJson>;
  packageFileCache: Map<string, Map<string, Uint8Array>>;
  assets: Map<string, ClientBundleAsset>;
  styles: Map<string, string>;
  warnings: string[];
  frameworkOptions: FrameworkAdapterOptions;
  jsxImportSource: string;
  framework: ClientArchive["manifest"]["framework"];
  entry: string;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json", ".css"];
const ASSET_EXTENSIONS = new Set([
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
  ".txt",
]);

export async function buildClientBundle(input: ClientBundleInput): Promise<ClientBundleOutput> {
  const budgets = input.budgets ?? DEFAULT_CLIENT_BUDGETS;
  const context: BuildContext = {
    modules: input.modules,
    packageJsonCache: new Map(),
    packageFileCache: new Map(),
    assets: new Map(),
    styles: new Map(),
    warnings: [...input.archive.warnings],
    frameworkOptions: input.frameworkOptions ?? {},
    jsxImportSource: input.archive.manifest.jsxImportSource ?? "react",
    framework: input.archive.manifest.framework,
    entry: input.archive.entry,
  };
  await validateArchiveSources(input.archive, budgets, context.jsxImportSource);
  for (const [path, asset] of input.archive.assets) {
    context.modules.files.set(path, asset.data);
  }
  addArchiveAssets(context, input.archive);

  const esm = await esbuildClient(context, budgets);
  context.warnings.push(...esm.warnings);
  const unminified = esm.code;
  const preOptimizationBytes = byteLength(unminified);
  if (preOptimizationBytes > budgets.maxPreOptimizationBytes) {
    throw new ClientBuildError(
      `unminified client bundle is ${preOptimizationBytes} bytes; limit is ${budgets.maxPreOptimizationBytes}`,
      [
        diagnostic(
          "budget.pre_optimization",
          `unminified client bundle is ${preOptimizationBytes} bytes; limit is ${budgets.maxPreOptimizationBytes}`,
          {
            hint: "remove unused dependencies, import narrower package entrypoints or enable a framework production build",
          },
        ),
      ],
      "bundle",
    );
  }

  const iife = await rollupClient(esm.code, context);
  const minified = await minify(iife);
  const bundleBytes = byteLength(minified);
  if (bundleBytes > budgets.maxBundleBytes) {
    throw new ClientBuildError(
      `final client bundle is ${bundleBytes} bytes; limit is ${budgets.maxBundleBytes}`,
      [
        diagnostic(
          "budget.bundle",
          `final client bundle is ${bundleBytes} bytes; limit is ${budgets.maxBundleBytes}`,
          {
            hint: "remove dependencies, avoid large UI kits, or split the client into a smaller one",
          },
        ),
      ],
      "bundle",
    );
  }

  const validation = validateClientJavaScript(minified, {
    mode: "bundle",
    file: "bundle.js",
    maxBytes: budgets.maxBundleBytes,
    allowInnerHtml: true,
  });
  if (!validation.ok) {
    throw new ClientBuildError(
      "final client bundle failed static validation",
      validation.issues,
      "validate",
      "bundle.js",
    );
  }

  const assets = [...context.assets.values()].sort((a, b) => a.key.localeCompare(b.key));
  const styles = [...context.styles.values()].sort();
  let assetBytes = 0;
  for (const asset of assets) {
    if (asset.data.byteLength > budgets.maxAssetBytes) {
      throw new ClientBuildError(
        `asset ${asset.path} is ${asset.data.byteLength} bytes; limit is ${budgets.maxAssetBytes}`,
        [
          diagnostic(
            "budget.asset",
            `asset ${asset.path} is ${asset.data.byteLength} bytes; per-asset limit is ${budgets.maxAssetBytes}`,
            { file: asset.path },
          ),
        ],
        "bundle",
        asset.path,
      );
    }
    assetBytes += asset.data.byteLength;
  }
  if (assetBytes > budgets.maxTotalAssetBytes) {
    throw new ClientBuildError(
      `assets total ${assetBytes} bytes; limit is ${budgets.maxTotalAssetBytes}`,
      [
        diagnostic(
          "budget.assets_total",
          `assets total ${assetBytes} bytes; limit is ${budgets.maxTotalAssetBytes}`,
        ),
      ],
      "bundle",
    );
  }

  return {
    bundle: minified,
    unminified,
    preOptimizationBytes,
    bundleBytes,
    assets,
    styles,
    sourceBytes: input.modules.sourceBytes,
    warnings: context.warnings,
    builderVersion: CLIENT_BUILDER_VERSION,
  };
}

async function esbuildClient(
  context: BuildContext,
  budgets: ClientBudgetConfig,
): Promise<{ code: string; warnings: string[] }> {
  const plugin = clientPlugin(context);
  let result;
  try {
    result = await esbuildBuild({
      entryPoints: [context.entry],
      bundle: true,
      write: false,
      outfile: "bundle.js",
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["browser", "import", "module", "default"],
      mainFields: ["browser", "module", "main"],
      jsx: context.jsxImportSource ? "automatic" : "transform",
      jsxImportSource: context.jsxImportSource,
      jsxDev: false,
      treeShaking: true,
      minify: false,
      sourcemap: false,
      legalComments: "none",
      charset: "utf8",
      logLevel: "silent",
      absWorkingDir: "/",
      define: {
        "process.env.NODE_ENV": '"production"',
        global: "globalThis",
        __VUE_OPTIONS_API__: "true",
        __VUE_PROD_DEVTOOLS__: "false",
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
      },
      plugins: [plugin],
      metafile: true,
    });
  } catch (error) {
    const errors = (error as { errors?: Array<{ text: string; location?: { file: string; line: number; column: number } }> }).errors;
    if (errors && errors.length > 0) {
      throw new ClientBuildError(
        "client bundle failed",
        errors.map((item) =>
          diagnostic("bundle.failed", item.text, {
            file: item.location?.file,
            line: item.location?.line,
            column: item.location?.column,
          }),
        ),
        "bundle",
      );
    }
    throw new ClientBuildError(
      "client bundle failed",
      [diagnostic("bundle.failed", error instanceof Error ? error.message : String(error))],
      "bundle",
    );
  }
  const output = result.outputFiles.find((file) => file.path.endsWith(".js")) ?? result.outputFiles[0];
  if (!output) {
    throw new ClientBuildError("esbuild produced no JavaScript", [
      diagnostic(
        "bundle.empty",
        `the client entrypoint produced no JavaScript (outputs: ${result.outputFiles
          .map((file) => file.path)
          .join(", ")})`,
      ),
    ], "bundle");
  }
  const warnings = result.warnings.map((warning) =>
    warning.location
      ? `${warning.location.file}:${warning.location.line}: ${warning.text}`
      : warning.text,
  );
  if (byteLength(output.text) > Math.max(budgets.maxPreOptimizationBytes * 4, 16 * 1024 * 1024)) {
    // A quick guard before parsing/minifying an absurd intermediate result.
    throw new ClientBuildError("client bundle is unexpectedly large", [
      diagnostic(
        "budget.intermediate",
        `intermediate bundle is ${byteLength(output.text)} bytes; refusing to continue`,
      ),
    ], "bundle");
  }
  return { code: output.text, warnings };
}

async function validateArchiveSources(
  archive: ClientArchive,
  budgets: ClientBudgetConfig,
  jsxImportSource: string,
): Promise<void> {
  for (const [path, data] of archive.files) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) continue;
    const extension = extname(path).toLowerCase();
    const loader: "ts" | "tsx" | "js" | "jsx" =
      extension === ".ts"
        ? "ts"
        : extension === ".tsx"
          ? "tsx"
          : extension === ".jsx"
            ? "jsx"
            : "js";
    const source = new TextDecoder().decode(data);
    let transformed: string;
    try {
      const result = await esbuildTransform(source, {
        loader,
        format: "esm",
        target: "es2022",
        jsx: "automatic",
        jsxImportSource,
        logLevel: "silent",
      });
      transformed = result.code;
    } catch (error) {
      throw new ClientBuildError(
        `client source ${path} could not be parsed`,
        [diagnostic("client.parse_error", error instanceof Error ? error.message : String(error), { file: path })],
        "validate",
        path,
      );
    }
    const result = validateClientJavaScript(transformed, {
      mode: "source",
      file: path,
      maxBytes: budgets.maxArchiveFileBytes,
    });
    if (!result.ok) {
      throw new ClientBuildError(
        `client source ${path} failed static validation`,
        result.issues,
        "validate",
        path,
      );
    }
  }
}

function clientPlugin(context: BuildContext): Plugin {
  return {
    name: "roster-client",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: "roster-client" };
        }
        const resolved = resolveImport(context, args.path, args.importer);
        if (!resolved) {
          return {
            errors: [
              {
                text: `could not resolve ${JSON.stringify(args.path)} from ${
                  args.importer || context.entry
                }`,
              },
            ],
          };
        }
        return { path: resolved, namespace: "roster-client" };
      });
      build.onLoad({ filter: /.*/, namespace: "roster-client" }, async (args) => {
        const data = context.modules.files.get(args.path);
        if (!data) {
          return { errors: [{ text: `module ${args.path} is missing` }] };
        }
        // lodash's legacy global fallback calls Function('return this')(). In a
        // browser frame globalThis/self always exist, so the fallback is dead
        // code; substitute the safe equivalent so the final bundle passes the
        // CSP lint without changing behaviour. This is a library compatibility
        // shim, not a security stripping pass (see docs/client-builds.md).
        if (/(?:^|\/)lodash(?:-es)?(?:@[^/]+)?\/_root\.js$/.test(args.path)) {
          context.warnings.push(
            "replaced lodash _root.js Function('return this') fallback with globalThis/self detection (dead in a browser frame)",
          );
          return {
            contents:
              'export default typeof globalThis === "object" ? globalThis : typeof self === "object" ? self : {};',
            loader: "js",
          };
        }
        const extension = extname(args.path).toLowerCase();
        if (extension === ".css") {
          addCssAsset(context, args.path, data);
          return { contents: "export default {};", loader: "js" };
        }
        if (extension === ".json") {
          return { contents: new TextDecoder().decode(data), loader: "json" };
        }
        if (ASSET_EXTENSIONS.has(extension)) {
          const emitted = addAsset(context, args.path, data);
          return {
            contents: `export default ${JSON.stringify(emitted.url)};`,
            loader: "js",
          };
        }
        if (extension === ".vue" || extension === ".svelte") {
          const adapter = selectFrameworkAdapter(args.path, context.framework, context.frameworkOptions);
          if (!adapter) {
            return { errors: [{ text: `no framework adapter for ${args.path}` }] };
          }
          try {
            const transformed = await adapter.transform({
              path: args.path,
              source: new TextDecoder().decode(data),
              framework: context.framework,
            });
            for (const style of transformed.styles ?? []) {
              addCssAsset(context, style.path, new TextEncoder().encode(style.content));
            }
            let frameworkJs = transformed.code;
            try {
              const js = await esbuildTransform(transformed.code, {
                loader: transformed.loader ?? "js",
                format: "esm",
                target: "es2022",
                logLevel: "silent",
              });
              frameworkJs = js.code;
            } catch (error) {
              return {
                errors: [
                  {
                    text: `framework output could not be parsed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  },
                ],
              };
            }
            const frameworkValidation = validateClientJavaScript(frameworkJs, {
              mode: "source",
              file: args.path,
              maxBytes: 5 * 1024 * 1024,
            });
            if (!frameworkValidation.ok) {
              return {
                errors: frameworkValidation.issues.map((item) => ({
                  text: item.message,
                  location: item.line
                    ? { file: args.path, line: item.line, column: item.column ?? 1 }
                    : undefined,
                })),
              };
            }
            context.warnings.push(...(transformed.warnings ?? []));
            return { contents: transformed.code, loader: transformed.loader ?? "js" };
          } catch (error) {
            if (error instanceof ClientBuildError) {
              return {
                errors: error.diagnostics.map((item) => ({
                  text: item.message,
                  location: item.file
                    ? { file: item.file, line: item.line ?? 1, column: item.column ?? 1 }
                    : undefined,
                })),
              };
            }
            return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
          }
        }
        const loader: "ts" | "tsx" | "js" | "jsx" =
          extension === ".ts"
            ? "ts"
            : extension === ".tsx"
              ? "tsx"
              : extension === ".jsx"
                ? "jsx"
                : "js";
        return { contents: data, loader };
      });
    },
  };
}

function resolveImport(context: BuildContext, request: string, importer: string): string | undefined {
  if (request.startsWith("./") || request.startsWith("../") || request.startsWith("/")) {
    const base = normalizePath(joinPath(dirnamePath(importer), request));
    return resolveFile(context, base);
  }
  return resolveBare(context, request, importer);
}

function resolveBare(
  context: BuildContext,
  request: string,
  importer: string,
): string | undefined {
  const { packageName, subpath } = splitPackageRequest(request);
  const importerRoot = findImporterPackageRoot(context, importer);
  const root =
    (importerRoot ? context.modules.packageEdges.get(importerRoot)?.get(packageName) : undefined) ??
    context.modules.rootPackages.get(packageName);
  if (!root) return undefined;
  const packageJson = readPackageJson(context, root);
  if (!packageJson) return undefined;
  const files = packageFiles(context, root);
  const entry = resolvePackageEntry(packageJson, files, subpath);
  if (!entry) return undefined;
  const path = normalizePath(`${root}/${entry}`);
  if (context.modules.files.has(path)) return path;
  return resolveFile(context, path);
}

function findImporterPackageRoot(context: BuildContext, importer: string): string | undefined {
  let best: string | undefined;
  for (const root of context.modules.packageRoots.keys()) {
    if (importer === root || importer.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

function resolveFile(context: BuildContext, path: string): string | undefined {
  const clean = normalizePath(path);
  if (context.modules.files.has(clean)) return clean;
  if (clean.endsWith(".js")) {
    const stem = clean.slice(0, -3);
    for (const extension of [".ts", ".tsx", ".jsx", ".mjs", ".cjs"]) {
      if (context.modules.files.has(`${stem}${extension}`)) return `${stem}${extension}`;
    }
  }
  for (const extension of EXTENSIONS) {
    if (context.modules.files.has(`${clean}${extension}`)) return `${clean}${extension}`;
  }
  for (const extension of EXTENSIONS) {
    if (context.modules.files.has(`${clean}/index${extension}`)) return `${clean}/index${extension}`;
  }
  return undefined;
}

function readPackageJson(context: BuildContext, root: string): PackageJson | undefined {
  const cached = context.packageJsonCache.get(root);
  if (cached) return cached;
  const bytes = context.modules.files.get(`${root}/package.json`);
  if (!bytes) return undefined;
  try {
    const packageJson = JSON.parse(new TextDecoder().decode(bytes)) as PackageJson;
    context.packageJsonCache.set(root, packageJson);
    return packageJson;
  } catch {
    return undefined;
  }
}

function packageFiles(context: BuildContext, root: string): Map<string, Uint8Array> {
  const cached = context.packageFileCache.get(root);
  if (cached) return cached;
  const files = new Map<string, Uint8Array>();
  const prefix = `${root}/`;
  for (const [path, data] of context.modules.files) {
    if (path.startsWith(prefix)) files.set(path.slice(prefix.length), data);
  }
  context.packageFileCache.set(root, files);
  return files;
}

function splitPackageRequest(request: string): { packageName: string; subpath: string } {
  const parts = request.split("/");
  if (request.startsWith("@")) {
    return {
      packageName: parts.slice(0, 2).join("/"),
      subpath: parts.slice(2).join("/"),
    };
  }
  return { packageName: parts[0] ?? request, subpath: parts.slice(1).join("/") };
}

function addArchiveAssets(context: BuildContext, archive: ClientArchive): void {
  for (const [path, asset] of archive.assets) {
    if (asset.kind === "style") {
      addCssAsset(context, path, asset.data);
    } else {
      addAsset(context, path, asset.data);
    }
  }
}

function addCssAsset(context: BuildContext, path: string, data: Uint8Array): void {
  const emitted = addAsset(context, path, data, "text/css");
  context.styles.set(emitted.key, emitted.url);
}

function addAsset(
  context: BuildContext,
  path: string,
  data: Uint8Array,
  contentType = contentTypeFor(path),
): ClientBundleAsset {
  const extension = extname(path).toLowerCase();
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 32);
  const key = `assets/${hash}${extension}`;
  const existing = context.assets.get(key);
  if (existing) return existing;
  const asset: ClientBundleAsset = {
    path,
    key,
    url: `./${key}`,
    hash: `sha256:${createHash("sha256").update(data).digest("hex")}`,
    data,
    contentType,
  };
  context.assets.set(key, asset);
  return asset;
}

async function rollupClient(code: string, context: BuildContext): Promise<string> {
  const facade = "virtual:roster-client-facade";
  const bundle = "virtual:roster-client-bundle";
  const warnings: string[] = [];
  let result;
  try {
    result = await rollup({
      input: facade,
      treeshake: {
        moduleSideEffects: "no-external",
        propertyReadSideEffects: false,
        tryCatchDeoptimization: false,
      },
      plugins: [
        {
          name: "roster-client-facade",
          resolveId(id) {
            if (id === facade || id === bundle) return id;
            return null;
          },
          load(id) {
            if (id === facade) {
              return `import factory from ${JSON.stringify(bundle)}; export default factory;`;
            }
            if (id === bundle) return code;
            return null;
          },
        },
      ],
      onwarn(warning: RollupLog, defaultHandler) {
        if (
          warning.code === "UNRESOLVED_IMPORT" ||
          warning.code === "MISSING_EXPORT" ||
          warning.code === "PARSE_ERROR"
        ) {
          warnings.push(`rollup.${warning.code}: ${warning.message}`);
          return;
        }
        if (warning.code !== "CIRCULAR_DEPENDENCY") {
          defaultHandler(warning);
        }
      },
    });
  } catch (error) {
    const rollupError = error as RollupError;
    throw new ClientBuildError(
      "Rollup could not bundle the client",
      [
        diagnostic("bundle.rollup", rollupError.message ?? String(error), {
          file: rollupError.loc?.file,
          line: rollupError.loc?.line,
          column: rollupError.loc?.column ? rollupError.loc.column + 1 : undefined,
        }),
      ],
      "bundle",
    );
  }
  try {
    const output = await result.generate({
      format: "iife",
      name: "__rosterClientFactory",
      exports: "default",
      inlineDynamicImports: true,
      sourcemap: false,
      generatedCode: "es2015",
      compact: false,
    });
    await result.close();
    const chunks = output.output.filter((item): item is OutputChunk => item.type === "chunk");
    if (chunks.length !== 1) {
      throw new ClientBuildError("Rollup emitted more than one chunk", [
        diagnostic("bundle.chunks", `expected one chunk, got ${chunks.length}`),
      ], "bundle");
    }
    const chunk = chunks[0]!;
    if (chunk.imports.length > 0 || chunk.dynamicImports.length > 0) {
      throw new ClientBuildError("Rollup output still has imports", [
        diagnostic(
          "client.import_after_bundle",
          `the final bundle imports ${[...chunk.imports, ...chunk.dynamicImports].join(", ")}`,
        ),
      ], "bundle");
    }
    context.warnings.push(...warnings);
    return chunk.code;
  } catch (error) {
    await result.close().catch(() => undefined);
    if (error instanceof ClientBuildError) throw error;
    throw new ClientBuildError(
      "could not generate the client IIFE",
      [diagnostic("bundle.rollup", error instanceof Error ? error.message : String(error))],
      "bundle",
    );
  }
}

async function minify(code: string): Promise<string> {
  try {
    const result = await esbuildTransform(code, {
      loader: "js",
      minify: true,
      target: "es2022",
      legalComments: "none",
      charset: "utf8",
      logLevel: "silent",
    });
    return result.code;
  } catch (error) {
    throw new ClientBuildError(
      "could not minify the client bundle",
      [diagnostic("bundle.minify", error instanceof Error ? error.message : String(error))],
      "bundle",
    );
  }
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function joinPath(base: string, request: string): string {
  if (request.startsWith("/")) return request;
  return base ? `${base}/${request}` : request;
}

function dirnamePath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
