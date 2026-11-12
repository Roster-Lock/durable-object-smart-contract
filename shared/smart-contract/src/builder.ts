import { build, transform } from "esbuild";
import type { AnalysisResult } from "./types.js";
import {
  DEFAULT_ALLOWED_IMPORTS,
  validateJavaScript,
  type ValidateOptions,
} from "./validator.js";

export interface BuildOptions {
  /** TypeScript or JavaScript source. */
  source: string;
  sourcefile?: string;
  loader?: "ts" | "js";
  /** Additional packages to leave external. */
  external?: readonly string[];
  /** Directory used to resolve relative imports. */
  resolveDir?: string;
  validate?: boolean;
}

export interface BuildResult {
  ok: boolean;
  code?: string;
  warnings: string[];
  sourceValidation: AnalysisResult;
  bundleValidation?: AnalysisResult;
}

/**
 * Compile authoring source to one QuickJS-evaluable JavaScript file.
 *
 * esbuild handles TypeScript, relative imports and decorators. The allowed
 * platform packages are left external so they can be type-only; a value import
 * from them survives into the bundle and the final validator rejects it. That
 * keeps this builder honest until the runtime packages have real JS shims.
 */
export async function buildJavaScript(options: BuildOptions): Promise<BuildResult> {
  // TypeScript has to become JavaScript before the shared JS validator can
  // read it. This transform also strips `import type` before bundling.
  let transformed: string;
  try {
    const result = await transform(options.source, {
      loader: options.loader ?? "ts",
      format: "esm",
      target: "es2022",
      sourcefile: options.sourcefile ?? "contract.ts",
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
          useDefineForClassFields: false,
        },
      },
    });
    transformed = result.code;
  } catch (error) {
    return {
      ok: false,
      warnings: [error instanceof Error ? error.message : String(error)],
      sourceValidation: {
        ok: false,
        nodes: 0,
        issues: [
          {
            severity: "error",
            code: "source.parse_error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      },
    };
  }

  const sourceValidation = validateJavaScript(transformed, {
    mode: "source",
    allowedImports: DEFAULT_ALLOWED_IMPORTS,
  });
  if (!sourceValidation.ok) {
    return { ok: false, warnings: [], sourceValidation };
  }

  const shims: Record<string, string> = {
    "@roster-lock/living-roster": `export const defineContract = __rosterDefineContract;`,
    "@roster-lock/match-making": `export const defineMatchmaker = __rosterDefineMatchmaker;`,
    "@roster-lock/deployed-types": ``,
  };
  const external = options.external ?? [];
  let result;
  try {
    result = await build({
      stdin: {
        contents: options.source,
        sourcefile: options.sourcefile ?? "contract.ts",
        loader: options.loader ?? "ts",
        resolveDir: options.resolveDir ?? "/",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "neutral",
      target: "es2022",
      external: [...external],
      logLevel: "silent",
      plugins: [
        {
          name: "roster-runtime-shims",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^@roster-lock\/(living-roster|match-making|deployed-types)$/ }, (args) => ({
              path: args.path,
              namespace: "roster-shim",
            }));
            pluginBuild.onLoad({ filter: /.*/, namespace: "roster-shim" }, (args) => ({
              contents: shims[args.path] ?? "",
              loader: "js",
            }));
          },
        },
      ],
      banner: {
        js: "(function(__rosterDefineContract, __rosterDefineMatchmaker) {",
      },
      footer: {
        js: '})(typeof defineContract === "function" ? defineContract : undefined, typeof defineMatchmaker === "function" ? defineMatchmaker : undefined);',
      },
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
          useDefineForClassFields: false,
        },
      },
    });
  } catch (error) {
    return {
      ok: false,
      warnings: [error instanceof Error ? error.message : String(error)],
      sourceValidation,
    };
  }

  const code = result.outputFiles[0]?.text ?? "";
  const warnings = result.warnings.map((warning) =>
    warning.location
      ? `${warning.location.file}:${warning.location.line}: ${warning.text}`
      : warning.text,
  );

  if (options.validate === false) {
    return { ok: true, code, warnings, sourceValidation };
  }

  const bundleValidation = validateJavaScript(code, {
    mode: "bundle",
    allowedImports: DEFAULT_ALLOWED_IMPORTS,
  } satisfies ValidateOptions);
  return {
    ok: bundleValidation.ok,
    code,
    warnings,
    sourceValidation,
    bundleValidation,
  };
}
