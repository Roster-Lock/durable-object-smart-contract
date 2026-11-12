import { parse, type Node as AcornNode } from "acorn";
import * as walk from "acorn-walk";
import type { AnalysisIssue, AnalysisResult } from "./types.js";

/**
 * Globals that would let a contract talk to the outside world. QuickJS does
 * not provide these anyway - the analyzer is a second, visible line of
 * defence, so an owner cannot deploy a contract that *expects* the network.
 */
export const FORBIDDEN_GLOBALS: Record<string, string> = {
  fetch: "network access is not available to contracts",
  XMLHttpRequest: "network access is not available to contracts",
  WebSocket: "network access is not available to contracts",
  WebSocketStream: "network access is not available to contracts",
  EventSource: "network access is not available to contracts",
  importScripts: "loading external scripts is not allowed",
  require: "modules are not available to contracts",
  process: "process access is not available to contracts",
  Deno: "runtime access is not available to contracts",
  Bun: "runtime access is not available to contracts",
  navigator: "browser globals are not available to contracts",
  window: "browser globals are not available to contracts",
  document: "browser globals are not available to contracts",
  localStorage: "browser globals are not available to contracts",
  indexedDB: "browser globals are not available to contracts",
};

export const RESERVED_GLOBALS: Record<string, string> = {
  __ds_host: "sandbox internals are reserved",
  __ds_contract: "sandbox internals are reserved",
  __ds_invoke: "sandbox internals are reserved",
  __ds_readManifest: "sandbox internals are reserved",
};

export const UNAVAILABLE_GLOBALS: Record<string, string> = {
  setTimeout: "timers are not available in the contract sandbox",
  setInterval: "timers are not available in the contract sandbox",
  clearTimeout: "timers are not available in the contract sandbox",
  clearInterval: "timers are not available in the contract sandbox",
  queueMicrotask: "use await and Promise.resolve instead",
  structuredClone: "structuredClone is not available; use JSON values",
};

export interface AnalyzeOptions {
  maxSourceBytes?: number;
}

/**
 * Static checks run before a contract is allowed to deploy.
 *
 * The analyzer is deliberately conservative: errors block deployment,
 * warnings are recorded and shown to the owner. It is not the security
 * boundary - gas metering and the QuickJS sandbox are - so a missed check is a
 * lint failure, not a sandbox escape.
 */
export function analyzeContract(
  source: string,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const issues: AnalysisIssue[] = [];
  const maxBytes = options.maxSourceBytes ?? 262_144;

  if (typeof source !== "string" || source.trim().length === 0) {
    return {
      ok: false,
      nodes: 0,
      issues: [
        {
          severity: "error",
          code: "source.empty",
          message: "contract source is empty",
        },
      ],
    };
  }
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > maxBytes) {
    issues.push({
      severity: "error",
      code: "source.too_large",
      message: `contract source is ${bytes} bytes, limit is ${maxBytes}`,
    });
    return { ok: false, nodes: 0, issues };
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true,
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
    });
  } catch (error) {
    const located = error as { message?: string; loc?: { line: number; column: number } };
    issues.push({
      severity: "error",
      code: "source.parse_error",
      message: located.message ?? "could not parse contract source",
      line: located.loc?.line,
      column: located.loc ? located.loc.column + 1 : undefined,
    });
    return { ok: false, nodes: 0, issues };
  }

  let nodes = 0;
  const loopLabels = collectLoopLabels(ast);
  const contractInfo = collectContractInfo(ast, issues);

  walk.fullAncestor(ast, (node, _state, ancestors) => {
    nodes++;
    const parent = ancestors[ancestors.length - 2];

    if (node.type === "Identifier" && isReference(node, parent)) {
      const name = node.name;
      if (name in FORBIDDEN_GLOBALS) {
        pushOnce(issues, {
          severity: "error",
          code: "global.forbidden",
          message: FORBIDDEN_GLOBALS[name],
          ...location(node),
        });
      } else if (name in RESERVED_GLOBALS) {
        pushOnce(issues, {
          severity: "error",
          code: "global.reserved",
          message: RESERVED_GLOBALS[name],
          ...location(node),
        });
      } else if (name in UNAVAILABLE_GLOBALS) {
        pushOnce(issues, {
          severity: "error",
          code: "global.unavailable",
          message: UNAVAILABLE_GLOBALS[name],
          ...location(node),
        });
      }
    }

    if (node.type === "ImportExpression") {
      issues.push({
        severity: "error",
        code: "module.dynamic_import",
        message: "dynamic import is not available to contracts",
        ...location(node),
      });
    }

    if (node.type === "MemberExpression" && !node.computed) {
      const object = node.object;
      const property = node.property;
      if (
        object.type === "Identifier" &&
        (object.name === "globalThis" || object.name === "global") &&
        property.type === "Identifier" &&
        (property.name in FORBIDDEN_GLOBALS || property.name in RESERVED_GLOBALS)
      ) {
        const message =
          FORBIDDEN_GLOBALS[property.name] ?? RESERVED_GLOBALS[property.name];
        pushOnce(issues, {
          severity: "error",
          code: "global.forbidden",
          message,
          ...location(node),
        });
      }
    }

    if (
      node.type === "CallExpression" ||
      node.type === "NewExpression"
    ) {
      const callee = node.callee;
      if (callee.type === "Identifier" && callee.name === "eval") {
        pushOnce(issues, {
          severity: "warning",
          code: "eval.dynamic",
          message: "eval() prevents meaningful static analysis; prefer plain code",
          ...location(node),
        });
      }
      if (callee.type === "Identifier" && callee.name === "Function") {
        pushOnce(issues, {
          severity: "warning",
          code: "eval.constructor",
          message: "the Function constructor prevents meaningful static analysis",
          ...location(node),
        });
      }
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.property.type === "Identifier"
      ) {
        const owner = callee.object.name;
        const method = callee.property.name;
        if (owner === "Math" && method === "random") {
          pushOnce(issues, {
            severity: "warning",
            code: "nondeterminism.random",
            message: "Math.random() makes a call non-deterministic; store the value instead",
            ...location(node),
          });
        }
        if (owner === "Date" && (method === "now" || method === "parse")) {
          pushOnce(issues, {
            severity: "warning",
            code: "nondeterminism.clock",
            message: "reading the clock makes a call non-deterministic",
            ...location(node),
          });
        }
      }
    }

    if (node.type === "CallExpression") {
      if (isPromiseChain(node, contractInfo)) {
        issues.push({
          severity: "error",
          code: "promise.chained_effect",
          message:
            "do not chain storage/emit calls with then/catch/finally; await them and use try/catch",
          ...location(node),
        });
      }
      if (isEffectCall(node, contractInfo) && !isHandled(node, ancestors)) {
        issues.push({
          severity: "error",
          code: "promise.unawaited_effect",
          message:
            "storage/emit calls are async and must be awaited (an unawaited effect can run out of order)",
          ...location(node),
        });
      }
    }

    if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Date") {
      pushOnce(issues, {
        severity: "warning",
        code: "nondeterminism.clock",
        message: "creating a Date reads the clock, which makes a call non-deterministic",
        ...location(node),
      });
    }

    if (isLoop(node) && isUnconditional(node) && !loopExits(node, loopLabels.get(node))) {
      issues.push({
        severity: "warning",
        code: "loop.unbounded",
        message:
          "unconditional loop with no break, return or await; termination relies on the gas meter",
        ...location(node),
      });
    }
  });

  const errors = issues.filter((issue) => issue.severity === "error");
  return { ok: errors.length === 0, issues, nodes };
}

// ---------------------------------------------------------------- async rules

interface ContractInfo {
  contextNames: Set<string>;
  storageAliases: Set<string>;
  handleNames: Set<string>;
}

/**
 * Collects the names that refer to the endpoint context (`ctx`) and to stored
 * handles (`const roster = ctx.storage.roster`, `const votes = await
 * ctx.storage.votes.get(id)`). A small alias analysis is enough to catch the
 * common unawaited-effect mistakes without a type checker.
 */
function collectContractInfo(ast: AcornNode, issues: AnalysisIssue[]): ContractInfo {
  const info: ContractInfo = {
    contextNames: new Set(),
    storageAliases: new Set(),
    handleNames: new Set(),
  };

  walk.full(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const call = node as unknown as {
      callee?: { type: string; name?: string };
      arguments?: unknown[];
    };
    if (call.callee?.type !== "Identifier" || call.callee.name !== "defineContract") return;
    const definition = call.arguments?.[0] as {
      type?: string;
      properties?: unknown[];
    } | undefined;
    if (!definition || definition.type !== "ObjectExpression") return;

    for (const raw of definition.properties ?? []) {
      const property = raw as {
        type?: string;
        key?: { type: string; name?: string; value?: unknown };
        value?: unknown;
      };
      if (property.type !== "Property") continue;
      const name = propertyName(property);
      if (name === "init" && isFunctionNode(property.value)) {
        requireAsyncHandler(property.value, "init", issues);
        addContextParam(property.value, 0, info);
      }
      if (name !== "endpoints") continue;
      const endpoints = property.value as {
        type?: string;
        properties?: unknown[];
      } | undefined;
      if (!endpoints || endpoints.type !== "ObjectExpression") continue;
      for (const rawEndpoint of endpoints.properties ?? []) {
        const endpoint = rawEndpoint as {
          type?: string;
          value?: { type?: string; properties?: unknown[] };
        };
        if (endpoint.type !== "Property" || endpoint.value?.type !== "ObjectExpression") {
          continue;
        }
        for (const rawMethod of endpoint.value.properties ?? []) {
          const method = rawMethod as {
            type?: string;
            key?: { type: string; name?: string; value?: unknown };
            value?: unknown;
          };
          if (method.type !== "Property" || propertyName(method) !== "run") continue;
          if (!isFunctionNode(method.value)) continue;
          requireAsyncHandler(method.value, "endpoint run", issues);
          addContextParam(method.value, 1, info);
        }
      }
    }
  });

  const declarators: Array<{
    id: { name: string };
    init: unknown;
  }> = [];
  walk.full(ast, (node) => {
    const declarator = node as unknown as {
      type?: string;
      id?: { type?: string; name?: string };
      init?: unknown;
    };
    if (
      declarator.type === "VariableDeclarator" &&
      declarator.id?.type === "Identifier" &&
      typeof declarator.id.name === "string" &&
      declarator.init !== undefined &&
      declarator.init !== null
    ) {
      declarators.push({ id: { name: declarator.id.name }, init: declarator.init });
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const declarator of declarators) {
      const name = declarator.id.name;
      if (!info.handleNames.has(name) && isHandleExpression(declarator.init, info)) {
        info.handleNames.add(name);
        changed = true;
      }
      if (
        !info.storageAliases.has(name) &&
        isStorageObjectExpression(declarator.init, info)
      ) {
        info.storageAliases.add(name);
        changed = true;
      }
    }
  }

  return info;
}

function propertyName(property: {
  key?: { type: string; name?: string; value?: unknown };
}): string | undefined {
  if (property.key?.type === "Identifier") return property.key.name;
  if (property.key?.type === "Literal") return String(property.key.value);
  return undefined;
}

function isFunctionNode(node: unknown): node is {
  type: string;
  async?: boolean;
  params?: unknown[];
} {
  const record = node as { type?: string } | undefined;
  return (
    record?.type === "FunctionExpression" ||
    record?.type === "ArrowFunctionExpression" ||
    record?.type === "FunctionDeclaration"
  );
}

function requireAsyncHandler(
  fn: { async?: boolean },
  label: string,
  issues: AnalysisIssue[],
): void {
  if (fn.async === true) return;
  issues.push({
    severity: "error",
    code: "function.not_async",
    message: `${label} must be an async function; effect calls must be awaited`,
    ...location(fn as unknown as AcornNode),
  });
}

function addContextParam(
  fn: { params?: unknown[] },
  index: number,
  info: ContractInfo,
): void {
  const param = fn.params?.[index] as { type?: string; name?: string } | undefined;
  if (param?.type === "Identifier" && typeof param.name === "string") {
    info.contextNames.add(param.name);
  }
}

function isContextStorageObject(node: unknown, info: ContractInfo): boolean {
  const record = node as {
    type?: string;
    computed?: boolean;
    object?: { type?: string; name?: string };
    property?: { type?: string; name?: string };
  } | undefined;
  if (!record || record.type !== "MemberExpression" || record.computed) return false;
  if (record.property?.type !== "Identifier" || record.property.name !== "storage") {
    return false;
  }
  const object = record.object;
  if (object?.type === "ThisExpression") return true;
  if (
    object?.type === "Identifier" &&
    typeof object.name === "string" &&
    (info.contextNames.has(object.name) || info.storageAliases.has(object.name))
  ) {
    return true;
  }
  return false;
}

function containsStorage(node: unknown, info: ContractInfo): boolean {
  let current = node as {
    type?: string;
    name?: string;
    object?: unknown;
  } | undefined;
  while (current && current.type === "MemberExpression") {
    if (isContextStorageObject(current, info)) return true;
    current = current.object as typeof current;
  }
  return Boolean(
    current &&
      current.type === "Identifier" &&
      typeof current.name === "string" &&
      info.storageAliases.has(current.name),
  );
}

function isStorageObjectExpression(node: unknown, info: ContractInfo): boolean {
  return isContextStorageObject(node, info);
}

function isHandleExpression(node: unknown, info: ContractInfo): boolean {
  const record = node as { type?: string; name?: string; argument?: unknown } | undefined;
  if (!record) return false;
  if (record.type === "Identifier" && typeof record.name === "string") {
    return info.handleNames.has(record.name) || info.storageAliases.has(record.name);
  }
  if (record.type === "MemberExpression") return containsStorage(record, info);
  if (record.type === "AwaitExpression") return isEffectCall(record.argument, info);
  if (record.type === "CallExpression") return isEffectCall(record, info);
  return false;
}

function isEffectCall(node: unknown, info: ContractInfo): boolean {
  const call = node as {
    type?: string;
    callee?: {
      type?: string;
      computed?: boolean;
      object?: { type?: string; name?: string; argument?: unknown };
      property?: { type?: string; name?: string };
    };
  } | undefined;
  if (!call || call.type !== "CallExpression" || call.callee?.type !== "MemberExpression") {
    return false;
  }
  const callee = call.callee;
  if (
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    (callee.property.name === "emit" || callee.property.name === "call")
  ) {
    if (callee.object?.type === "ThisExpression") return true;
    if (
      callee.object?.type === "Identifier" &&
      typeof callee.object.name === "string" &&
      info.contextNames.has(callee.object.name)
    ) {
      return true;
    }
  }
  if (containsStorage(callee, info)) return true;
  const object = callee.object;
  if (
    object?.type === "Identifier" &&
    typeof object.name === "string" &&
    (info.handleNames.has(object.name) || info.storageAliases.has(object.name))
  ) {
    return true;
  }
  if (object?.type === "AwaitExpression" && isEffectCall(object.argument, info)) {
    return true;
  }
  return false;
}

function isPromiseChain(node: unknown, info: ContractInfo): boolean {
  const call = node as {
    type?: string;
    callee?: {
      type?: string;
      computed?: boolean;
      object?: unknown;
      property?: { type?: string; name?: string };
    };
  } | undefined;
  if (!call || call.type !== "CallExpression") return false;
  const callee = call.callee;
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return false;
  const name = callee.property?.type === "Identifier" ? callee.property.name : undefined;
  if (name !== "then" && name !== "catch" && name !== "finally") return false;
  return isEffectCall(callee.object, info) || isHandleExpression(callee.object, info);
}

function isHandled(node: unknown, ancestors: AcornNode[]): boolean {
  for (let index = ancestors.length - 2; index >= 0; index--) {
    const ancestor = ancestors[index] as unknown as {
      type?: string;
      body?: unknown;
    };
    if (ancestor.type === "AwaitExpression" || ancestor.type === "ReturnStatement") {
      return true;
    }
    if (ancestor.type === "ArrowFunctionExpression" && ancestor.body === node) {
      return true;
    }
    if (
      ancestor.type === "FunctionExpression" ||
      ancestor.type === "ArrowFunctionExpression" ||
      ancestor.type === "FunctionDeclaration"
    ) {
      return false;
    }
  }
  return false;
}

function isLoop(node: AcornNode): boolean {
  return (
    node.type === "WhileStatement" ||
    node.type === "DoWhileStatement" ||
    node.type === "ForStatement"
  );
}

function isUnconditional(node: AcornNode): boolean {
  const loop = node as unknown as {
    type: string;
    test?: AcornNode | null;
  };
  if (loop.type === "ForStatement") {
    return loop.test === null || isAlwaysTruthy(loop.test);
  }
  if (loop.type === "WhileStatement" || loop.type === "DoWhileStatement") {
    return isAlwaysTruthy(loop.test);
  }
  return false;
}

function isAlwaysTruthy(node: AcornNode | null | undefined): boolean {
  if (!node) return false;
  const candidate = node as unknown as { type: string; value?: unknown };
  if (candidate.type !== "Literal") return false;
  return Boolean(candidate.value);
}

/** Labels attached to loops, so `break outer` can be recognised. */
function collectLoopLabels(ast: AcornNode): Map<AcornNode, string> {
  const labels = new Map<AcornNode, string>();
  walk.full(ast, (node) => {
    if (node.type === "LabeledStatement" && isLoop(node.body)) {
      labels.set(node.body, node.label.name);
    }
  });
  return labels;
}

/**
 * Does the loop body contain a way out? Await/yield count: the guest yields
 * control and the gas meter still applies, but it is no longer a pure spin.
 */
function loopExits(loop: AcornNode, label: string | undefined): boolean {
  let found = false;

  const visit = (node: unknown, nestedLoops: number): void => {
    if (found || node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown> & { type?: string };
    if (Array.isArray(record)) {
      for (const item of record) visit(item, nestedLoops);
      return;
    }
    switch (record.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ClassDeclaration":
      case "ClassExpression":
        return;
      case "ReturnStatement":
      case "ThrowStatement":
      case "AwaitExpression":
      case "YieldExpression":
        found = true;
        return;
      case "BreakStatement": {
        const breakNode = record as unknown as { label?: { name: string } | null };
        if (breakNode.label) {
          if (label !== undefined && breakNode.label.name === label) found = true;
        } else if (nestedLoops === 0) {
          found = true;
        }
        return;
      }
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "SwitchStatement": {
        for (const key of Object.keys(record)) {
          if (key === "type") continue;
          visit(record[key], nestedLoops + 1);
        }
        return;
      }
      default: {
        for (const key of Object.keys(record)) {
          if (key === "type") continue;
          visit(record[key], nestedLoops);
        }
      }
    }
  };

  const body = (loop as unknown as { body: unknown }).body;
  visit(body, 0);
  return found;
}

function location(node: AcornNode): { line?: number; column?: number } {
  const start = (node as unknown as { loc?: { start: { line: number; column: number } } }).loc
    ?.start;
  return start ? { line: start.line, column: start.column + 1 } : {};
}

function pushOnce(issues: AnalysisIssue[], issue: AnalysisIssue): void {
  const duplicate = issues.some(
    (existing) => existing.code === issue.code && existing.message === issue.message,
  );
  if (!duplicate) issues.push(issue);
}

export function isReference(node: AcornNode, parent: AcornNode | undefined): boolean {
  if (!parent) return true;
  // Acorn's Node is not a discriminated union, so the shape is read directly.
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
    case "RestElement":
      return p.argument !== node;
    case "ArrayPattern":
    case "ObjectPattern":
      return false;
    default:
      return true;
  }
}
