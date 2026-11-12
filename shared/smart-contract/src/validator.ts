import { parse, type Node as AcornNode } from "acorn";
import * as walk from "acorn-walk";
import {
  FORBIDDEN_GLOBALS,
  RESERVED_GLOBALS,
  UNAVAILABLE_GLOBALS,
  isReference,
} from "./analyze.js";
import type { AnalysisIssue, AnalysisResult } from "./types.js";

/** Packages a contract or matchmaker may import while being authored. */
export const DEFAULT_ALLOWED_IMPORTS: readonly string[] = [
  "@roster-lock/living-roster",
  "@roster-lock/match-making",
  "@roster-lock/deployed-types",
];

const EXTRA_FORBIDDEN: Record<string, string> = {
  eval: "eval is not available to deployed code",
  Function: "the Function constructor is not available to deployed code",
  globalThis: "globalThis is reserved by the sandbox",
  global: "global is not available to deployed code",
  self: "self is not available to deployed code",
  window: "browser globals are not available to deployed code",
  document: "browser globals are not available to deployed code",
  postMessage: "messaging is not available to deployed code",
  crypto: "crypto is not available to deployed code",
  module: "CommonJS globals are not available to deployed code",
  exports: "CommonJS globals are not available to deployed code",
  __dirname: "filesystem globals are not available to deployed code",
  __filename: "filesystem globals are not available to deployed code",
};

export interface ValidateOptions {
  /**
   * `source` permits relative imports and the allowed package imports.
   * `bundle` is the final single-file output: no imports or exports at all.
   */
  mode?: "source" | "bundle";
  allowedImports?: readonly string[];
  maxSourceBytes?: number;
}

/**
 * Shared validator for contract and matchmaker source.
 *
 * This is a lint, not the security boundary: the QuickJS sandbox and gas
 * metering still enforce isolation. It is what catches an accidental network
 * call or an import that would survive bundling.
 */
export function validateJavaScript(
  source: string,
  options: ValidateOptions = {},
): AnalysisResult {
  const mode = options.mode ?? "source";
  const allowed = new Set(options.allowedImports ?? DEFAULT_ALLOWED_IMPORTS);
  const maxBytes = options.maxSourceBytes ?? 262_144;
  const issues: AnalysisIssue[] = [];

  if (typeof source !== "string" || source.trim().length === 0) {
    return {
      ok: false,
      nodes: 0,
      issues: [{ severity: "error", code: "source.empty", message: "source is empty" }],
    };
  }
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > maxBytes) {
    return {
      ok: false,
      nodes: 0,
      issues: [
        {
          severity: "error",
          code: "source.too_large",
          message: `source is ${bytes} bytes, limit is ${maxBytes}`,
        },
      ],
    };
  }

  let ast: AcornNode;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: mode === "bundle" ? "script" : "module",
      locations: true,
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
    });
  } catch (error) {
    const located = error as { message?: string; loc?: { line: number; column: number } };
    issues.push({
      severity: "error",
      code: "source.parse_error",
      message: located.message ?? "could not parse source",
      line: located.loc?.line,
      column: located.loc ? located.loc.column + 1 : undefined,
    });
    return { ok: false, nodes: 0, issues };
  }

  const forbidden = { ...FORBIDDEN_GLOBALS, ...EXTRA_FORBIDDEN };
  let nodes = 0;

  walk.fullAncestor(ast, (node, _state, ancestors) => {
    nodes++;
    const parent = ancestors[ancestors.length - 2] as AcornNode | undefined;

    if (node.type === "ImportDeclaration") {
      const sourceValue = node.source.value;
      if (mode === "bundle") {
        issues.push({
          severity: "error",
          code: "import.after_bundle",
          message: "the final bundle must not contain imports",
          ...location(node),
        });
      } else if (typeof sourceValue !== "string" || !isAllowedImport(sourceValue, allowed)) {
        issues.push({
          severity: "error",
          code: "import.forbidden",
          message: `import ${JSON.stringify(sourceValue)} is not allowed; allowed packages are ${[
            ...allowed,
          ].join(", ")}`,
          ...location(node),
        });
      }
      return;
    }

    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      const sourceValue = node.source.value;
      if (mode === "bundle") {
        issues.push({
          severity: "error",
          code: "import.after_bundle",
          message: "the final bundle must not re-export imports",
          ...location(node),
        });
      } else if (typeof sourceValue !== "string" || !isAllowedImport(sourceValue, allowed)) {
        issues.push({
          severity: "error",
          code: "import.forbidden",
          message: `re-export from ${JSON.stringify(sourceValue)} is not allowed`,
          ...location(node),
        });
      }
      return;
    }

    if (node.type === "ImportExpression") {
      issues.push({
        severity: "error",
        code: "import.dynamic",
        message: "dynamic import is not available to deployed code",
        ...location(node),
      });
      return;
    }

    if (node.type === "MetaProperty") {
      issues.push({
        severity: "error",
        code: "syntax.meta_property",
        message: "import.meta is not available to deployed code",
        ...location(node),
      });
      return;
    }

    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = node.callee;
      if (callee.type === "Identifier") {
        if (callee.name === "require") {
          issues.push({
            severity: "error",
            code: "import.require",
            message: "require() is not available to deployed code",
            ...location(node),
          });
        }
        if (callee.name === "eval") {
          issues.push({
            severity: "error",
            code: "eval.dynamic",
            message: "eval() is not available to deployed code",
            ...location(node),
          });
        }
        if (callee.name === "Function") {
          issues.push({
            severity: "error",
            code: "eval.constructor",
            message: "the Function constructor is not available to deployed code",
            ...location(node),
          });
        }
      }
      return;
    }

    if (node.type === "Identifier" && isReference(node, parent)) {
      const name = node.name;
      const message = forbidden[name] ?? RESERVED_GLOBALS[name] ?? UNAVAILABLE_GLOBALS[name];
      if (message) {
        issues.push({
          severity: "error",
          code: "global.forbidden",
          message,
          ...location(node),
        });
      }
    }
  });

  const errors = issues.filter((issue) => issue.severity === "error");
  return { ok: errors.length === 0, issues, nodes };
}

function isAllowedImport(source: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(source)) return true;
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
    return true;
  }
  return false;
}

function location(node: AcornNode): { line?: number; column?: number } {
  const loc = (node as unknown as { loc?: { start: { line: number; column: number } } }).loc;
  return loc
    ? { line: loc.start.line, column: loc.start.column + 1 }
    : {};
}
