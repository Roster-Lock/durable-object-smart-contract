/**
 * Public types for durable-smart-contract.
 *
 * A "contract" is a single JavaScript program owned by one account and run
 * inside a QuickJS sandbox that is embedded in a Cloudflare Durable Object.
 * Postgres is the contract's state; every contract's rows are namespaced by
 * its contract id in the shared website database.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface GasCosts {
  /** Charged every time QuickJS polls the interrupt handler. */
  tick: number;
  /** Charged once per endpoint call before any guest code runs. */
  baseCall: number;
  /** Charged per KiB of contract source that is compiled. */
  loadPerKiB: number;
  /** Charged on entering any storage host function. */
  hostCall: number;
  /** Charged per SELECT / INSERT / UPDATE / DELETE statement. */
  statement: number;
  /** Charged per row a query returned, or per row counted by a COUNT(*). */
  rowRead: number;
  /** Charged per row a write affected. */
  rowWritten: number;
  /** Charged per byte read from or written to the database. */
  byte: number;
  /** Charged per byte of the JSON input or result. */
  payloadByte: number;
  /** Charged per log entry emitted by the contract. */
  logEntry: number;
  /** Charged once per value/key validated against a JSON Schema. */
  schemaValidation: number;
  /** Charged once per emitted event, plus bytes. */
  event: number;
}

export interface ContractConfig {
  gasCosts: GasCosts;
  /** Gas limit used when an endpoint does not declare one. */
  defaultGasLimit: number;
  /** Hard ceiling for a single call, regardless of the endpoint's ask. */
  maxGasPerCall: number;
  /** Smallest gas limit a call may be started with. */
  minGasLimit: number;
  /** Gas budget for the deploy-time dry run that extracts the manifest. */
  deployGasLimit: number;
  /**
   * Price in credits per 1,000,000 gas. Escrow and charges are integers, so
   * a call can never cost a fraction of a credit.
   */
  gasPricePerMillion: number;
  maxSourceBytes: number;
  maxInputBytes: number;
  maxResultBytes: number;
  maxValueBytes: number;
  maxKeyBytes: number;
  maxNameBytes: number;
  /** Largest page a single get/add/remove may touch. */
  maxPageSize: number;
  /** Largest number of items a single add or remove may touch. */
  maxItemsPerOperation: number;
  /** Largest offset a page operation will scan; also the renumber ceiling. */
  maxArrayOffset: number;
  maxEndpoints: number;
  /** Gas budget for the one-time `init` hook. Not billed to a wallet. */
  initGasLimit: number;
  /** Wall-clock budget for the one-time `init` hook. */
  initTimeoutMs: number;
  /** Deepest storage declaration accepted. */
  maxStorageDepth: number;
  maxStorageCollections: number;
  /** Total bytes of all JSON Schemas in a contract. */
  maxSchemaBytes: number;
  /** Encoded path limit for nested collections. */
  maxPathBytes: number;
  /** Events a single call may emit. */
  maxEventsPerCall: number;
  /** Events a contract may declare. */
  maxEvents: number;
  /** Largest serialized event payload. */
  maxEventBytes: number;
  /** Largest init args payload accepted at deploy. */
  maxInitArgsBytes: number;
  memoryLimitBytes: number;
  maxStackBytes: number;
  /** Wall-clock backstop; hitting it is treated like running out of gas. */
  hardTimeoutMs: number;
  /** Escrows older than this are refunded by reconciliation. */
  escrowTtlMs: number;
  maxLogBytes: number;
}

export const DEFAULT_CONFIG: ContractConfig = {
  gasCosts: {
    tick: 10_000,
    baseCall: 20_000,
    loadPerKiB: 200,
    hostCall: 200,
    statement: 100,
    rowRead: 100,
    rowWritten: 500,
    byte: 1,
    payloadByte: 1,
    logEntry: 100,
    schemaValidation: 500,
    event: 500,
  },
  defaultGasLimit: 2_000_000,
  maxGasPerCall: 10_000_000,
  minGasLimit: 50_000,
  deployGasLimit: 5_000_000,
  gasPricePerMillion: 1,
  maxSourceBytes: 262_144,
  maxInputBytes: 262_144,
  maxResultBytes: 1_048_576,
  maxValueBytes: 65_536,
  maxKeyBytes: 256,
  maxNameBytes: 128,
  maxPageSize: 1_000,
  maxItemsPerOperation: 1_000,
  maxArrayOffset: 100_000,
  maxEndpoints: 64,
  initGasLimit: 10_000_000,
  initTimeoutMs: 5_000,
  maxStorageDepth: 8,
  maxStorageCollections: 64,
  maxSchemaBytes: 65_536,
  maxPathBytes: 1_024,
  maxEventsPerCall: 64,
  maxEvents: 64,
  maxEventBytes: 16_384,
  maxInitArgsBytes: 65_536,
  memoryLimitBytes: 33_554_432,
  maxStackBytes: 512 * 1024,
  hardTimeoutMs: 1_000,
  escrowTtlMs: 300_000,
  maxLogBytes: 16_384,
};

export type EndpointAccess = "public" | "human" | "contract" | "roster-lock";

export interface EndpointManifest {
  /** Declared gas ceiling; 0 means "use the host default". */
  gasLimit: number;
  access: EndpointAccess;
  /** Optional JSON Schema for the call input, checked before escrow. */
  input?: JsonSchema;
  /**
   * False when the endpoint promises not to write. The platform enforces it:
   * storage is read-only for the call and the usual advisory lock is skipped.
   */
  mutates: boolean;
}

/**
 * A stored value schema: JSON Schema draft 2020-12, compiled on the host.
 * `$ref` is rejected at deploy so a schema can never reach the network.
 */
export type JsonSchema = Record<string, unknown>;

export interface ValueNode {
  kind: "value";
  schema: JsonSchema;
  /** Seeded on first deploy, validated before it is written. */
  initial?: JsonValue;
  /** Re-validate values when they are read (useful after a schema change). */
  validateReads?: boolean;
}

export interface MapNode {
  kind: "map";
  /** Schema for map keys. Keys are strings. */
  key?: JsonSchema;
  value: StorageNode;
  maxEntries?: number;
  /** `{ key: initialValue }`, seeded on first deploy. */
  initial?: { [key: string]: unknown };
}

export interface ArrayNode {
  kind: "array";
  item: StorageNode;
  maxItems?: number;
  /** Items in top-to-bottom order, seeded on first deploy. */
  initial?: unknown[];
}

export type StorageNode = ValueNode | MapNode | ArrayNode;

/** A root collection; `version` guards schema changes on redeploy. */
export type StorageCollection = StorageNode & { version?: number };

export type StorageDeclarations = Record<string, StorageCollection>;

export interface EventManifest {
  schema: JsonSchema;
  description?: string;
}

export interface ContractManifest {
  name: string;
  version: string;
  storage: StorageDeclarations;
  events: Record<string, EventManifest>;
  endpoints: Record<string, EndpointManifest>;
  /** True when the contract defined an `init` hook. Runs once, on first deploy. */
  hasInit: boolean;
}

export interface DeployInput {
  ownerId: string;
  name: string;
  /** Optional metadata; prefer changing the handle for a new version. */
  version?: string;
  /** Stable name used by sibling contracts. Defaults to name; unique per roster. */
  handle?: string;
  /** The Durable Object's contract id; validated against the object's own id. */
  contractId?: string;
  /** Arguments passed to the contract's init hook on first deploy. */
  initArgs?: JsonValue;
  source: string;
}

export interface DeployResult {
  contractId: string;
  ownerId: string;
  name: string;
  version: string;
  handle?: string;
  rosterId?: string;
  sourceHash: string;
  manifest: ContractManifest;
  analysis: AnalysisResult;
}

export interface DeployPreview {
  contractId: string;
  name: string;
  sourceHash: string;
  manifest: ContractManifest;
  analysis: AnalysisResult;
}

export type CallerKind = "human" | "contract" | "roster-lock";

export interface CallInput {
  /** The wallet that pays for the call. */
  callerId: string;
  endpoint: string;
  input?: JsonValue;
  /**
   * Internal: who is calling. The HTTP call route always uses "human"; the
   * platform route sets "roster-lock". Defaults to "human".
   */
  callerKind?: CallerKind;
  /** Internal: msgSender id; defaults to callerId. */
  senderId?: string;
  /** Audit id for an app acting with the owner's grant. Never authorization. */
  delegate?: string;
}

export type CallStatus = "ok";

export interface ContractEvent {
  id: string;
  contractId: string;
  name: string;
  payload: JsonValue;
  callerId: string;
  callId: string;
  createdAt: number;
  /** The third-party app that acted for the caller, if any. */
  delegate?: string;
}

export interface CallResult {
  contractId: string;
  endpoint: string;
  callerId: string;
  status: CallStatus;
  /** False when the endpoint declared `mutates: false`. */
  mutates: boolean;
  result: JsonValue;
  /** Gas actually consumed, clamped to the endpoint's limit. */
  gasUsed: number;
  /** Credits taken from escrow. Zero refund when the call ran out of gas. */
  gasCharged: number;
  logs: string[];
  events: ContractEvent[];
  /** The third-party app that acted for the owner, if any. */
  delegate?: string;
}

export type AnalysisSeverity = "error" | "warning";

export interface AnalysisIssue {
  severity: AnalysisSeverity;
  code: string;
  message: string;
  line?: number;
  column?: number;
}

export interface AnalysisResult {
  ok: boolean;
  issues: AnalysisIssue[];
  /** Number of AST nodes the analyzer visited. */
  nodes: number;
}

export interface ContractRecord {
  contractId: string;
  ownerId: string;
  name: string;
  version: string;
  handle?: string;
  rosterId?: string;
  source: string;
  sourceHash: string;
  manifest: ContractManifest;
  initArgs?: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface CallLogEntry {
  id: string;
  callerId: string;
  endpoint: string;
  status: "ok" | "error" | "out_of_gas";
  gasUsed: number;
  gasCharged: number;
  error: string | null;
  createdAt: number;
  /** The third-party app that acted for the caller, if any. */
  delegate?: string;
}

export interface WalletBalance {
  userId: string;
  balance: number;
}
