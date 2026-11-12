import { Validator } from "@cfworker/json-schema";
import { ContractError } from "../errors.js";
import type {
  ArrayNode,
  ContractConfig,
  JsonSchema,
  JsonValue,
  MapNode,
  StorageCollection,
  StorageDeclarations,
  StorageNode,
  ValueNode,
} from "../types.js";

/**
 * Compiles the `storage` block a contract declares.
 *
 * The declarations are both a type system and the storage layout: there are no
 * implicit collections, and every write is checked against the leaf schema.
 * Compilation happens at deploy time (and is re-run when the stored manifest
 * is loaded), so a schema that does not compile can never be stored.
 */

export interface CompiledValue {
  kind: "value";
  schema: JsonSchema;
  validator: Validator;
  validateReads: boolean;
  initial?: JsonValue;
}

export interface CompiledMap {
  kind: "map";
  keyValidator?: Validator;
  value: CompiledNode;
  maxEntries?: number;
  initial?: Record<string, unknown>;
}

export interface CompiledArray {
  kind: "array";
  item: CompiledNode;
  maxItems?: number;
  initial?: unknown[];
}

export type CompiledNode = CompiledValue | CompiledMap | CompiledArray;

export interface CompiledCollection {
  name: string;
  version: number;
  node: CompiledNode;
}

export type CompiledStorage = Map<string, CompiledCollection>;

export interface ParsedStorage {
  declarations: StorageDeclarations;
  compiled: CompiledStorage;
}

const COLLECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_NAMES = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "storage",
]);

/**
 * Reject `$ref` (a schema must never reach outside itself) and cap nesting, so
 * a pathological schema cannot exhaust the walk.
 */
export interface SchemaBudget {
  schemaBytes: number;
}

export function rejectRefs(
  value: unknown,
  path: string,
  depth = 0,
  label = "storage schema",
): void {
  if (depth > 64) {
    throw new ContractError(
      "analysis_failed",
      `${label} ${path} is nested too deeply`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectRefs(item, `${path}[${index}]`, depth + 1, label));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" || key === "$dynamicRef") {
      throw new ContractError(
        "analysis_failed",
        `${label} ${path} uses ${key}; references are not supported`,
      );
    }
    rejectRefs(child, `${path}.${key}`, depth + 1, label);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function nodeKind(value: unknown): "value" | "map" | "array" | undefined {
  if (!isPlainObject(value)) return undefined;
  const kind = value.kind;
  return kind === "value" || kind === "map" || kind === "array" ? kind : undefined;
}

/** A nested node may be written as a bare JSON Schema, meaning a value node. */
function normalizeNode(raw: unknown, path: string): StorageNode {
  const kind = nodeKind(raw);
  if (kind === undefined) {
    if (!isPlainObject(raw)) {
      throw new ContractError(
        "analysis_failed",
        `storage ${path} must be a JSON Schema or a { kind: "value" | "map" | "array" } node`,
      );
    }
    return { kind: "value", schema: raw as JsonSchema };
  }
  return normalizeTypedNode(raw as Record<string, unknown>, kind, path);
}

function normalizeTypedNode(
  raw: Record<string, unknown>,
  kind: "value" | "map" | "array",
  path: string,
): StorageNode {
  if (kind === "value") {
    const schema = raw.schema;
    if (!isPlainObject(schema)) {
      throw new ContractError("analysis_failed", `storage ${path}.schema must be an object`);
    }
    const node: ValueNode = { kind: "value", schema: schema as JsonSchema };
    if (raw.initial !== undefined) node.initial = raw.initial as JsonValue;
    if (raw.validateReads !== undefined) {
      if (typeof raw.validateReads !== "boolean") {
        throw new ContractError(
          "analysis_failed",
          `storage ${path}.validateReads must be a boolean`,
        );
      }
      node.validateReads = raw.validateReads;
    }
    return node;
  }

  if (kind === "map") {
    const value = raw.value;
    if (value === undefined) {
      throw new ContractError("analysis_failed", `storage ${path}.value is required`);
    }
    const node: MapNode = {
      kind: "map",
      value: normalizeNode(value, `${path}.value`),
    };
    if (raw.key !== undefined) {
      if (!isPlainObject(raw.key)) {
        throw new ContractError("analysis_failed", `storage ${path}.key must be a JSON Schema`);
      }
      node.key = raw.key as JsonSchema;
    }
    const maxEntries = parseLimit(raw.maxEntries, `${path}.maxEntries`);
    if (maxEntries !== undefined) node.maxEntries = maxEntries;
    if (raw.initial !== undefined) {
      if (!isPlainObject(raw.initial)) {
        throw new ContractError("analysis_failed", `storage ${path}.initial must be an object`);
      }
      node.initial = raw.initial as Record<string, unknown>;
    }
    return node;
  }

  const item = raw.item;
  if (item === undefined) {
    throw new ContractError("analysis_failed", `storage ${path}.item is required`);
  }
  const node: ArrayNode = {
    kind: "array",
    item: normalizeNode(item, `${path}.item`),
  };
  const maxItems = parseLimit(raw.maxItems, `${path}.maxItems`);
  if (maxItems !== undefined) node.maxItems = maxItems;
  if (raw.initial !== undefined) {
    if (!Array.isArray(raw.initial)) {
      throw new ContractError("analysis_failed", `storage ${path}.initial must be an array`);
    }
    node.initial = raw.initial;
  }
  return node;
}

function parseLimit(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ContractError(
      "analysis_failed",
      `storage ${path} must be a positive integer`,
    );
  }
  return value;
}

function compileNode(
  node: StorageNode,
  path: string,
  depth: number,
  config: ContractConfig,
  state: SchemaBudget,
): CompiledNode {
  if (depth > config.maxStorageDepth) {
    throw new ContractError(
      "analysis_failed",
      `storage ${path} is nested deeper than ${config.maxStorageDepth} levels`,
    );
  }

  if (node.kind === "value") {
    rejectRefs(node.schema, `${path}.schema`);
    state.schemaBytes += JSON.stringify(node.schema).length;
    if (state.schemaBytes > config.maxSchemaBytes) {
      throw new ContractError(
        "analysis_failed",
        `storage schemas exceed ${config.maxSchemaBytes} bytes`,
      );
    }
    let validator: Validator;
    try {
      validator = new Validator(node.schema, "2020-12");
    } catch (error) {
      throw new ContractError(
        "analysis_failed",
        `storage ${path}.schema is not a valid JSON Schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (node.initial !== undefined) {
      assertValid(validator, node.initial, `${path}.initial`);
    }
    return {
      kind: "value",
      schema: node.schema,
      validator,
      validateReads: node.validateReads ?? false,
      initial: node.initial,
    };
  }

  if (node.kind === "map") {
    let keyValidator: Validator | undefined;
    if (node.key) {
      rejectRefs(node.key, `${path}.key`);
      state.schemaBytes += JSON.stringify(node.key).length;
      try {
        keyValidator = new Validator(node.key, "2020-12");
      } catch (error) {
        throw new ContractError(
          "analysis_failed",
          `storage ${path}.key is not a valid JSON Schema: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const value = compileNode(node.value, `${path}.value`, depth + 1, config, state);
    if (node.initial !== undefined) {
      for (const [key, initial] of Object.entries(node.initial)) {
        assertKey(key, keyValidator, `${path}.initial[${JSON.stringify(key)}]`);
        assertInitial(value, initial, `${path}.initial[${JSON.stringify(key)}]`);
      }
    }
    return {
      kind: "map",
      keyValidator,
      value,
      maxEntries: node.maxEntries,
      initial: node.initial,
    };
  }

  const item = compileNode(node.item, `${path}.item`, depth + 1, config, state);
  if (node.initial !== undefined) {
    node.initial.forEach((initial, index) => {
      assertInitial(item, initial, `${path}.initial[${index}]`);
    });
  }
  return { kind: "array", item, maxItems: node.maxItems, initial: node.initial };
}

function assertValid(validator: Validator, value: unknown, label: string): void {
  const result = validator.validate(value);
  if (!result.valid) {
    const first = result.errors[0];
    throw new ContractError(
      "analysis_failed",
      `${label} does not match its schema: ${
        first ? `${first.instanceLocation}: ${first.error}` : "invalid"
      }`,
    );
  }
}

function assertKey(key: string, validator: Validator | undefined, label: string): void {
  if (!validator) return;
  const result = validator.validate(key);
  if (!result.valid) {
    const first = result.errors[0];
    throw new ContractError(
      "analysis_failed",
      `${label} key does not match its schema: ${
        first ? `${first.instanceLocation}: ${first.error}` : "invalid"
      }`,
    );
  }
}

function assertInitial(node: CompiledNode, initial: unknown, label: string): void {
  if (node.kind === "value") {
    assertValid(node.validator, initial, label);
    return;
  }
  if (node.kind === "map") {
    if (!isPlainObject(initial)) {
      throw new ContractError("analysis_failed", `${label} must be an object`);
    }
    for (const [key, child] of Object.entries(initial)) {
      assertKey(key, node.keyValidator, `${label}[${JSON.stringify(key)}]`);
      assertInitial(node.value, child, `${label}[${JSON.stringify(key)}]`);
    }
    return;
  }
  if (!Array.isArray(initial)) {
    throw new ContractError("analysis_failed", `${label} must be an array`);
  }
  initial.forEach((child, index) => assertInitial(node.item, child, `${label}[${index}]`));
}

/**
 * Normalize and compile a `storage` block.
 *
 * `declarations` is what goes into the manifest; `compiled` is what the host
 * uses to validate and route operations.
 */
export function parseStorage(
  raw: unknown,
  config: ContractConfig,
  budget: SchemaBudget = { schemaBytes: 0 },
): ParsedStorage {
  if (raw === undefined) {
    return { declarations: {}, compiled: new Map() };
  }
  if (!isPlainObject(raw)) {
    throw new ContractError("analysis_failed", "storage must be an object");
  }
  const entries = Object.entries(raw);
  if (entries.length > config.maxStorageCollections) {
    throw new ContractError(
      "analysis_failed",
      `a contract may declare at most ${config.maxStorageCollections} collections`,
    );
  }

  const declarations: StorageDeclarations = {};
  const compiled: CompiledStorage = new Map();
  const state = budget;

  for (const [name, value] of entries) {
    if (!COLLECTION_NAME.test(name)) {
      throw new ContractError(
        "analysis_failed",
        `invalid storage collection name: ${name}`,
      );
    }
    if (RESERVED_NAMES.has(name)) {
      throw new ContractError(
        "analysis_failed",
        `storage collection name ${name} is reserved`,
      );
    }
    if (!isPlainObject(value)) {
      throw new ContractError(
        "analysis_failed",
        `storage.${name} must be an object`,
      );
    }
    const kind = nodeKind(value);
    if (!kind) {
      throw new ContractError(
        "analysis_failed",
        `storage.${name}.kind must be "value", "map" or "array"`,
      );
    }
    const node = normalizeTypedNode(value, kind, `storage.${name}`);
    const version = value.version === undefined ? 1 : value.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new ContractError(
        "analysis_failed",
        `storage.${name}.version must be an integer of at least 1`,
      );
    }
    const compiledNode = compileNode(node, `storage.${name}`, 1, config, state);
    declarations[name] = { ...node, version } as StorageCollection;
    compiled.set(name, { name, version, node: compiledNode });
  }

  return { declarations, compiled };
}

/**
 * What a collection's schema *means* for stored data. `version` and `initial`
 * are excluded: changing them does not require a schema version bump.
 */
export function declarationShape(node: StorageNode): unknown {
  if (node.kind === "value") {
    return { kind: "value", schema: node.schema, validateReads: node.validateReads ?? false };
  }
  if (node.kind === "map") {
    return {
      kind: "map",
      key: node.key ?? null,
      value: declarationShape(node.value),
      maxEntries: node.maxEntries ?? null,
    };
  }
  return {
    kind: "array",
    item: declarationShape(node.item),
    maxItems: node.maxItems ?? null,
  };
}

/** Stable JSON so two equivalent schemas compare equal regardless of key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Compare a redeployed collection with the one currently stored. */
export function schemaChanged(
  previous: StorageNode | undefined,
  next: StorageNode,
): boolean {
  if (!previous) return false;
  return stableStringify(declarationShape(previous)) !== stableStringify(declarationShape(next));
}
