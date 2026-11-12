import type {
  MatchResult,
  QueuedPlayer,
  UserId,
} from "@roster-lock/deployed-types";

/** JSON Schema shape used for storage values. */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  [key: string]: unknown;
}

/** Basic JSON-Schema-to-TypeScript inference for authoring convenience. */
export type SchemaValue<S> =
  S extends { type: "integer" | "number" }
    ? number
    : S extends { type: "string" }
      ? string
      : S extends { type: "boolean" }
        ? boolean
        : S extends { type: "array"; items: infer I }
          ? SchemaValue<I>[]
          : S extends { type: "object"; properties: infer P }
            ? { [K in keyof P]: SchemaValue<P[K]> }
            : unknown;

export interface MapStorageConfig<V extends StorageNodeConfig = StorageNodeConfig> {
  kind: "map";
  /** The node stored at each key. Keys are always strings. */
  value: V;
  key?: JsonSchema;
}

export interface ArrayStorageConfig<V extends StorageNodeConfig = StorageNodeConfig> {
  kind: "array";
  /** The node stored at each index. */
  value: V;
}

export interface ValueStorageConfig<S extends JsonSchema = JsonSchema> {
  kind: "value";
  /** Value nodes always have a schema. */
  schema: S;
  validateReads?: boolean;
}

export type StorageNodeConfig =
  | MapStorageConfig
  | ArrayStorageConfig
  | ValueStorageConfig;

/** Storage declarations are recursive: map/array values are themselves nodes. */
export type StorageConfig = Record<string, StorageNodeConfig>;

/** The subset of the declared storage API a matchmaker uses. */
export interface StoredValue<T> {
  get(): Promise<T | undefined>;
  set(value: T): Promise<void>;
  delete(): Promise<void>;
}

export interface StoredMap<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys?(): Promise<string[]> | AsyncIterable<string>;
}

export interface StoredArray<T> {
  get(index: number): Promise<T | undefined>;
  set(index: number, value: T): Promise<void>;
  insert(index: number, values: T[]): Promise<void>;
  removeAt(index: number): Promise<void>;
  length(): Promise<number>;
  slice(start: number, count: number): Promise<T[]>;
}

/** The value returned by map.get/array.get for a node. */
type ChildValue<N> = N extends { kind: "value"; schema: infer S }
  ? SchemaValue<S>
  : N extends { kind: "map"; value: infer V }
    ? StoredMap<ChildValue<V>>
    : N extends { kind: "array"; value: infer V }
      ? StoredArray<ChildValue<V>>
      : never;

/** The handle for a top-level collection. */
type NodeHandle<N> = N extends { kind: "map"; value: infer V }
  ? StoredMap<ChildValue<V>>
  : N extends { kind: "array"; value: infer V }
    ? StoredArray<ChildValue<V>>
    : N extends { kind: "value"; schema: infer S }
      ? StoredValue<SchemaValue<S>>
      : never;

/**
 * Runtime storage handles for a declaration.
 *
 * - map/array children are handles when nested and raw values when leaves;
 * - only a top-level value is a StoredValue;
 * - value nodes always carry a schema.
 */
export type UsableStorage<Storage extends StorageConfig> = {
  [K in keyof Storage]: NodeHandle<Storage[K]>;
};

/** Host services available to a matchmaker. */
export interface MatchmakerContext<Storage = Record<string, unknown>> {
  storage: Storage;
  now(): number;
  random(): number;
  queue(): Promise<QueuedPlayer[]>;
  cooldownMs: number;
  maxWaitMs: number;
}

export interface MatchmakingPlan {
  matches: UserId[][];
  timedOut?: UserId[];
}

/** Host-owned match history; independent of what the algorithm stores. */
export interface MatchHistoryEntry {
  matchId: string;
  rosterId: string;
  deploymentId?: string;
  finishedAt: number;
  participants: UserId[];
  result: MatchResult;
}

/**
 * Raw data for a previous matchmaker storage tree. The runner wraps this in
 * read-only async handles before handing it to init.
 */
export type MatchmakerStorageSnapshot = Record<string, unknown>;

export interface MatchmakerDefinition<
  Storage extends StorageConfig = StorageConfig,
  Previous extends StorageConfig = StorageConfig,
> {
  name: string;
  version?: string;
  /** Must match the generic Storage type. */
  storage?: Storage;
  /**
   * Run once when a fresh matchmaker deployment is created. `previous` is a
   * read-only set of async storage handles over the previous deployment when
   * this is an update.
   */
  init?(
    ctx: MatchmakerContext<UsableStorage<Storage>>,
    previous?: UsableStorage<Previous>,
  ): void | Promise<void>;
  handleMatchResult(
    result: MatchResult,
    ctx: MatchmakerContext<UsableStorage<Storage>>,
  ): void | Promise<void>;
  findOtherPlayers(
    pool: QueuedPlayer[],
    ctx: MatchmakerContext<UsableStorage<Storage>>,
  ): MatchmakingPlan | Promise<MatchmakingPlan>;
}

/**
 * The runtime installs this as a global before evaluating the bundle.
 * Authoring code imports this name and the types; it emits no JavaScript.
 */
export declare function defineMatchmaker<
  const Storage extends StorageConfig = StorageConfig,
  const Previous extends StorageConfig = StorageConfig,
>(definition: MatchmakerDefinition<Storage, Previous>): void;

export type {
  MatchId,
  MatchResult,
  PieceId,
  PieceType,
  QueuedPlayer,
  RosterId,
  UserId,
} from "@roster-lock/deployed-types";
