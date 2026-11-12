import type { JsonValue } from "@roster-lock/deployed-types";

export type { JsonValue };

/** Access modes available to a living-roster endpoint. */
export type LivingRosterAccess = "public" | "human" | "contract" | "roster-lock";

export interface Sender {
  kind: "human" | "contract" | "roster-lock";
  id: string;
}

export interface Origin {
  kind: "human";
  id: string;
  delegate?: string;
}

/** Read-only async storage handles for a sibling contract. */
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

/**
 * A named sibling contract. Endpoint calls run in the same transaction as the
 * caller; storage is a read-only snapshot taken at the start of the call.
 */
export interface ContractHandle {
  name: string;
  id: string;
  storage: Record<
    string,
    StoredValue<JsonValue> | StoredMap<JsonValue> | StoredArray<JsonValue>
  >;
  call(endpoint: string, input?: JsonValue): Promise<JsonValue>;
}

/** The subset of the guest context this package types for authors. */
export interface ContractContext {
  storage: Record<string, unknown>;
  /** Sibling contracts in the same roster, keyed by their handle. */
  contracts: Record<string, ContractHandle>;
  emit(name: string, payload: JsonValue): Promise<void>;
  msgSender: Sender;
  txOrigin: Origin;
  contract: string;
  contractId: string;
  callId: string;
  endpoint: string;
}

export interface EndpointDefinition<Input = JsonValue, Output = JsonValue> {
  input?: JsonValue;
  access?: LivingRosterAccess;
  mutates?: boolean;
  gasLimit?: number;
  run(input: Input, ctx: ContractContext): Output | Promise<Output>;
}

export interface ContractDefinition {
  name?: string;
  version?: string;
  storage?: Record<string, unknown>;
  events?: Record<string, { schema: JsonValue; description?: string }>;
  init?(ctx: ContractContext, args?: JsonValue): void | Promise<void>;
  endpoints: Record<string, EndpointDefinition>;
}

/**
 * The runtime installs this as a global before evaluating the bundle. This
 * declaration exists so TypeScript authors can import the type/name; it emits
 * no JavaScript.
 */
export declare function defineContract(definition: ContractDefinition): void;
