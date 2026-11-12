import { parse, type Node as AcornNode } from "acorn";
import * as walk from "acorn-walk";

export interface ClientValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface ClientValidationOptions {
  /** `bundle` requires no imports/exports and is the normal final check. */
  mode?: "source" | "bundle";
  file?: string;
  maxBytes?: number;
  /**
   * The final bundle includes npm libraries (React, Vue) that legitimately
   * assign innerHTML for their own renderer. Authored client sources are
   * validated separately in strict mode; this switch only applies to the
   * bundled dependency graph.
   */
  allowInnerHtml?: boolean;
}

export interface ClientValidationResult {
  ok: boolean;
  nodes: number;
  bytes: number;
  issues: ClientValidationIssue[];
}

const FORBIDDEN_GLOBALS: Record<string, string> = {
  fetch: "network access is not available to custom clients",
  XMLHttpRequest: "network access is not available to custom clients",
  WebSocket: "network access is not available to custom clients",
  WebSocketStream: "network access is not available to custom clients",
  EventSource: "network access is not available to custom clients",
  WebTransport: "network access is not available to custom clients",
  RTCPeerConnection: "network access is not available to custom clients",
  importScripts: "loading external scripts is not allowed",
  require: "modules are not available at runtime",
  Worker: "workers are not available in the client sandbox",
  SharedWorker: "workers are not available in the client sandbox",
  ServiceWorker: "service workers are not available in the client sandbox",
  BroadcastChannel: "cross-context channels are not available in the client sandbox",
  SharedArrayBuffer: "shared memory is not available in the client sandbox",
  Atomics: "shared memory is not available in the client sandbox",
  localStorage: "the client sandbox has no origin storage",
  sessionStorage: "the client sandbox has no origin storage",
  indexedDB: "the client sandbox has no origin storage",
  caches: "the client sandbox has no origin storage",
  cookieStore: "cookies are not available to custom clients",
  postMessage: "use the host API; raw postMessage is reserved by the runtime bridge",
  eval: "eval is not available to custom clients",
  Function: "the Function constructor is not available to custom clients",
  Deno: "runtime access is not available to custom clients",
  Bun: "runtime access is not available to custom clients",
  process: "process access is not available to custom clients",
  Buffer: "Node Buffer is not available in the browser client runtime",
};

const FORBIDDEN_PROPERTIES: Record<string, string> = {
  fetch: "network access is not available to custom clients",
  eval: "eval is not available to custom clients",
  Function: "the Function constructor is not available to custom clients",
  XMLHttpRequest: "network access is not available to custom clients",
  WebSocket: "network access is not available to custom clients",
  WebSocketStream: "network access is not available to custom clients",
  EventSource: "network access is not available to custom clients",
  importScripts: "loading external scripts is not allowed",
  Worker: "workers are not available to custom clients",
  SharedWorker: "workers are not available to custom clients",
  sendBeacon: "beacon requests are not available to custom clients",
  serviceWorker: "service workers are not available to custom clients",
  cookie: "cookies are not available to custom clients",
  write: "document.write is not available to custom clients",
  writeln: "document.writeln is not available to custom clients",
  innerHTML: "setting innerHTML is not allowed; build DOM nodes explicitly",
  outerHTML: "setting outerHTML is not allowed; build DOM nodes explicitly",
  insertAdjacentHTML: "insertAdjacentHTML is not allowed; build DOM nodes explicitly",
  srcdoc: "iframe srcdoc is not available to custom clients",
  opener: "the opener window is not available to custom clients",
  parent: "the parent page is not available to custom clients",
};

const FORBIDDEN_METHODS: Array<{ object: string; method: string; message: string }> = [
  { object: "document", method: "write", message: "document.write is not available to custom clients" },
  { object: "document", method: "writeln", message: "document.writeln is not available to custom clients" },
  { object: "navigator", method: "sendBeacon", message: "beacon requests are not available" },
  { object: "navigator", method: "serviceWorker", message: "service workers are not available" },
  { object: "window", method: "open", message: "popups/navigation are not available to custom clients" },
  { object: "location", method: "assign", message: "navigation is not available to custom clients" },
  { object: "location", method: "replace", message: "navigation is not available to custom clients" },
];

/**
 * Static client lint. This is intentionally conservative and fails closed.
 *
 * It is NOT the security boundary. The iframe sandbox and CSP are. The lint
 * catches accidental network calls, escape hatches and bundle mistakes before
 * an artifact is published.
 */
export function validateClientJavaScript(
  source: string,
  options: ClientValidationOptions = {},
): ClientValidationResult {
  const mode = options.mode ?? "bundle";
  const bytes = new TextEncoder().encode(source).length;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const issues: ClientValidationIssue[] = [];
  if (typeof source !== "string" || source.trim().length === 0) {
    return {
      ok: false,
      nodes: 0,
      bytes,
      issues: [
        {
          severity: "error",
          code: "client.empty",
          message: "client bundle is empty",
          ...(options.file ? { file: options.file } : {}),
        },
      ],
    };
  }
  if (bytes > maxBytes) {
    return {
      ok: false,
      nodes: 0,
      bytes,
      issues: [
        {
          severity: "error",
          code: "client.too_large",
          message: `client source is ${bytes} bytes; analyzer limit is ${maxBytes}`,
          ...(options.file ? { file: options.file } : {}),
        },
      ],
    };
  }

  let ast: AcornNode;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
      allowHashBang: true,
    });
  } catch (error) {
    const located = error as { message?: string; loc?: { line: number; column: number } };
    issues.push({
      severity: "error",
      code: "client.parse_error",
      message: located.message ?? "could not parse client JavaScript",
      ...(options.file ? { file: options.file } : {}),
      ...(located.loc ? { line: located.loc.line, column: located.loc.column + 1 } : {}),
    });
    return { ok: false, nodes: 0, bytes, issues };
  }

  let nodes = 0;
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    nodes++;
    const parent = ancestors[ancestors.length - 2] as AcornNode | undefined;
    const location = sourceLocation(node, options.file);

    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" || node.type === "ExportDefaultDeclaration") {
      if (mode === "bundle") {
        issues.push({
          severity: "error",
          code: node.type === "ImportDeclaration" ? "client.import_after_bundle" : "client.export_after_bundle",
          message:
            node.type === "ImportDeclaration"
              ? "the final client bundle must not contain imports"
              : "the final client bundle must not contain exports",
          ...location,
        });
      }
      return;
    }
    if (node.type === "ImportExpression") {
      issues.push({
        severity: "error",
        code: "client.dynamic_import",
        message: "dynamic import() is not available to custom clients",
        ...location,
      });
      return;
    }
    if (node.type === "MetaProperty") {
      issues.push({
        severity: "error",
        code: "client.meta_property",
        message: "import.meta is not available to custom clients",
        ...location,
      });
      return;
    }
    if (node.type === "WithStatement") {
      issues.push({
        severity: "error",
        code: "client.with_statement",
        message: "with statements are not allowed",
        ...location,
      });
      return;
    }
    if (node.type === "Literal" && typeof node.value === "string") {
      if (/^\s*javascript:/i.test(node.value)) {
        issues.push({
          severity: "error",
          code: "client.javascript_url",
          message: "javascript: URLs are not allowed",
          ...location,
        });
      }
      return;
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      inspectCall(node, (issue) => issues.push({ ...issue, ...location }), options);
      return;
    }
    if (node.type === "AssignmentExpression") {
      const left = node.left;
      if (left.type === "MemberExpression") {
        const property = propertyName(left);
        if (
          property &&
          (property === "innerHTML" || property === "outerHTML" || property === "srcdoc") &&
          !(options.allowInnerHtml && (property === "innerHTML" || property === "outerHTML"))
        ) {
          issues.push({
            severity: "error",
            code:
              property === "innerHTML"
                ? "client.inner_html"
                : property === "outerHTML"
                  ? "client.outer_html"
                  : "client.srcdoc",
            message: `assigning ${property} is not allowed; construct DOM nodes and textContent`,
            ...location,
          });
        }
        if (
          (property === "href" && isLocationObject(left.object)) ||
          (property === "location" &&
            (objectIsNamed(left.object, "window") ||
              objectIsNamed(left.object, "document") ||
              objectIsNamed(left.object, "globalThis")))
        ) {
          issues.push({
            severity: "error",
            code: "client.navigation",
            message: "client code may not navigate the host or frame",
            ...location,
          });
        }
        if (property === "download") {
          issues.push({
            severity: "error",
            code: "client.download",
            message: "downloads are not enabled for custom clients",
            ...location,
          });
        }
        if (property === "src" && objectIsScript(left.object)) {
          issues.push({
            severity: "error",
            code: "client.dynamic_script",
            message: "setting a script src is not allowed",
            ...location,
          });
        }
      }
      return;
    }
    if (node.type === "MemberExpression") {
      const property = propertyName(node);
      if (property && FORBIDDEN_PROPERTIES[property] && isDangerousMember(node)) {
        issues.push({
          severity: "error",
          code: "client.forbidden_api",
          message: FORBIDDEN_PROPERTIES[property]!,
          ...location,
        });
      }
      if (property && (property === "parent" || property === "top") && isWindowLike(node.object)) {
        issues.push({
          severity: "error",
          code: "client.parent_dom",
          message: "the parent page DOM is not available to custom clients",
          ...location,
        });
      }
      if (
        property === "constructor" &&
        node.object.type === "MemberExpression" &&
        propertyName(node.object) === "prototype" &&
        objectIsNamed((node.object as unknown as { object: AcornNode }).object, "Function")
      ) {
        issues.push({
          severity: "error",
          code: "client.function_constructor",
          message: "the Function constructor is not available to custom clients",
          ...location,
        });
      }
      if (property === "cookie" && isDocumentLike(node.object)) {
        issues.push({
          severity: "error",
          code: "client.cookie",
          message: "cookies are not available to custom clients",
          ...location,
        });
      }
      if (
        (objectIsNamed(node.object, "parent") ||
          objectIsNamed(node.object, "opener") ||
          objectIsNamed(node.object, "frameElement")) &&
        ["document", "location", "postMessage", "frames", "window", "cookie"].includes(property ?? "")
      ) {
        issues.push({
          severity: "error",
          code: "client.parent_dom",
          message: "the parent page is not available to custom clients",
          ...location,
        });
      }
      return;
    }
    if (node.type === "Identifier" && isReference(node, parent)) {
      if (
        node.name === "Function" &&
        parent?.type === "MemberExpression" &&
        propertyName(parent) === "prototype"
      ) {
        return;
      }
      const message = FORBIDDEN_GLOBALS[node.name];
      if (message) {
        issues.push({
          severity: "error",
          code: "client.forbidden_api",
          message,
          ...location,
        });
      }
    }
  });

  const errors = issues.filter((issue) => issue.severity === "error");
  return { ok: errors.length === 0, nodes, bytes, issues };
}

function inspectCall(
  node: AcornNode & { callee: AcornNode; arguments: AcornNode[] },
  push: (issue: Omit<ClientValidationIssue, "line" | "column" | "file">) => void,
  options: ClientValidationOptions,
): void {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    const name = (callee as unknown as { name: string }).name;
    if (name === "eval") {
      push({ severity: "error", code: "client.eval", message: "eval is not available to custom clients" });
    }
    if (name === "Function") {
      push({
        severity: "error",
        code: "client.function_constructor",
        message: "the Function constructor is not available to custom clients",
      });
    }
    if (name === "require") {
      push({ severity: "error", code: "client.require", message: "require() is not available at runtime" });
    }
    if (name === "importScripts") {
      push({
        severity: "error",
        code: "client.import_scripts",
        message: "importScripts is not available to custom clients",
      });
    }
    if (node.type === "NewExpression" && (name === "Worker" || name === "SharedWorker")) {
      push({
        severity: "error",
        code: "client.worker",
        message: "workers are not available to custom clients",
      });
    }
    return;
  }
  if (callee.type !== "MemberExpression") return;
  const method = propertyName(callee);
  const object = (callee as unknown as { object: AcornNode }).object;
  if (!method) return;
  if (method === "createElement" || method === "createElementNS") {
    const tagNode = method === "createElementNS" ? node.arguments[1] : node.arguments[0];
    const tag = literalString(tagNode);
    if (tag && tag.toLowerCase() === "script") {
      push({
        severity: "error",
        code: "client.dynamic_script",
        message: "dynamic <script> creation/injection is not allowed",
      });
    }
    return;
  }
  if (method === "importScripts") {
    push({
      severity: "error",
      code: "client.import_scripts",
      message: "importScripts is not available to custom clients",
    });
    return;
  }
  if (method === "insertAdjacentHTML") {
    if (!options.allowInnerHtml) {
      push({
        severity: "error",
        code: "client.inner_html",
        message: "insertAdjacentHTML is not allowed; build DOM nodes explicitly",
      });
    }
    return;
  }
  if (method === "setAttribute") {
    const attribute = literalString(node.arguments[0])?.toLowerCase();
    if (attribute === "srcdoc") {
      push({
        severity: "error",
        code: "client.srcdoc",
        message: "iframe srcdoc is not available to custom clients",
      });
    }
    if (attribute === "src" && objectIsScript(object)) {
      push({
        severity: "error",
        code: "client.dynamic_script",
        message: "setting a script src is not allowed",
      });
    }
    return;
  }
  for (const rule of FORBIDDEN_METHODS) {
    if (
      method === rule.method &&
      (objectIsNamed(object, rule.object) ||
        (rule.object === "location" && isLocationObject(object)))
    ) {
      push({ severity: "error", code: "client.forbidden_api", message: rule.message });
      return;
    }
  }
}

function sourceLocation(
  node: AcornNode,
  file: string | undefined,
): { line?: number; column?: number; file?: string } {
  const loc = (node as unknown as { loc?: { start: { line: number; column: number } } }).loc;
  return {
    ...(loc ? { line: loc.start.line, column: loc.start.column + 1 } : {}),
    ...(file ? { file } : {}),
  };
}

function propertyName(node: AcornNode): string | undefined {
  const member = node as unknown as {
    computed?: boolean;
    property?: AcornNode;
  };
  if (!member.property) return undefined;
  if (!member.computed && member.property.type === "Identifier") {
    return (member.property as unknown as { name: string }).name;
  }
  if (member.computed && member.property.type === "Literal") {
    const value = (member.property as unknown as { value?: unknown }).value;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function literalString(node: AcornNode | undefined): string | undefined {
  if (!node || node.type !== "Literal") return undefined;
  const value = (node as unknown as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

function isWindowLike(node: AcornNode): boolean {
  return objectIsNamed(node, "window") || objectIsNamed(node, "globalThis") || objectIsNamed(node, "self");
}

function isDocumentLike(node: AcornNode): boolean {
  return objectIsNamed(node, "document");
}

function isLocationObject(node: AcornNode): boolean {
  return objectIsNamed(node, "location") || (node.type === "MemberExpression" && propertyName(node) === "location");
}

function objectIsNamed(node: AcornNode, name: string): boolean {
  return node.type === "Identifier" && (node as unknown as { name: string }).name === name;
}

function objectIsScript(node: AcornNode): boolean {
  return objectIsNamed(node, "script");
}

function isDangerousMember(node: AcornNode): boolean {
  const member = node as unknown as { object: AcornNode; property: AcornNode; computed?: boolean };
  // A bare property read such as `settings.cookie` is not a browser cookie.
  // Only browser-ish objects and the explicit dangerous properties matter.
  if (
    objectIsNamed(member.object, "globalThis") ||
    objectIsNamed(member.object, "window") ||
    objectIsNamed(member.object, "self") ||
    objectIsNamed(member.object, "document")
  ) {
    return true;
  }
  if (objectIsNamed(member.object, "navigator")) return true;
  return false;
}

function isReference(node: AcornNode, parent: AcornNode | undefined): boolean {
  if (!parent) return true;
  const p = parent as unknown as {
    type: string;
    property?: AcornNode;
    computed?: boolean;
    key?: AcornNode;
    shorthand?: boolean;
    id?: AcornNode;
    params?: AcornNode[];
    label?: AcornNode;
    param?: AcornNode;
    left?: AcornNode;
    argument?: AcornNode;
  };
  switch (p.type) {
    case "MemberExpression":
      return p.property !== node || p.computed === true;
    case "Property":
      return p.key !== node || p.computed === true || p.shorthand === true;
    case "MethodDefinition":
    case "PropertyDefinition":
      return p.key !== node || p.computed === true;
    case "VariableDeclarator":
      return p.id !== node;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return p.id !== node && !(p.params ?? []).includes(node);
    case "LabeledStatement":
      return p.label !== node;
    case "BreakStatement":
    case "ContinueStatement":
      return p.label !== node;
    case "CatchClause":
      return p.param !== node;
    case "AssignmentPattern":
      return p.left !== node;
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return false;
    default:
      return true;
  }
}

export const CLIENT_FORBIDDEN_GLOBALS = Object.freeze({ ...FORBIDDEN_GLOBALS });
