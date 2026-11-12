import { getQuickJS } from "quickjs-emscripten";
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSWASMModule,
} from "quickjs-emscripten";
import { ContractError, QuickJSError } from "../errors.js";
import { parseEvents, type CompiledEvents } from "../events.js";
import type { GasMeter } from "../gas.js";
import type { Db } from "../sql/driver.js";
import { ContractStorage, type StorageTarget } from "../state/collections.js";
import {
  isPlainObject,
  parseStorage,
  rejectRefs,
} from "../storage/declaration.js";
import { Validator } from "@cfworker/json-schema";
import type { CompiledMap, CompiledStorage } from "../storage/declaration.js";
import type {
  ContractConfig,
  ContractEvent,
  ContractManifest,
  EndpointAccess,
  EndpointManifest,
  JsonValue,
} from "../types.js";
import { utf8ByteLength } from "../util/bytes.js";
import { PRELUDE_SOURCE } from "./prelude.js";
import type { StorageSnapshot } from "../state/snapshot.js";

const ENDPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The common shape of QuickJS eval/call results. */
interface HandleResult {
  readonly error?: QuickJSHandle | undefined;
  unwrap(): QuickJSHandle;
  dispose(): void;
}

export interface ContractHandleInfo {
  handle: string;
  contractId: string;
  storage: StorageSnapshot;
}

export type ContractCallHandler = (
  targetId: string,
  endpoint: string,
  input: JsonValue,
) => Promise<JsonValue>;

export interface SandboxOptions {
  db: Db;
  contractId: string;
  /** Escrow id for a call, or an init-specific id. Stored on emitted events. */
  callId: string;
  meter: GasMeter;
  config: ContractConfig;
  callerId: string;
  /** Immediate sender id; defaults to callerId. */
  senderId?: string;
  /** The original human; defaults to callerId for a root call. */
  originId?: string;
  /** Who is calling: human, a contract, or the roster-lock platform. */
  callerKind?: "human" | "contract" | "roster-lock";
  /** Third-party app id acting with the owner's grant; audit only. */
  delegate?: string;
  contractName: string;
  /** Deployment mode: the sandbox may never write. */
  readOnly?: boolean;
  /** Read-only named handles for sibling contracts in the same roster. */
  contracts?: ContractHandleInfo[];
  /** Cross-contract endpoint invocation. */
  callContract?: ContractCallHandler;
  now?: () => number;
}

interface Outcome {
  ok: boolean;
  payload: string;
}

interface ParsedManifest {
  manifest: ContractManifest;
  storage: CompiledStorage;
  events: CompiledEvents;
}

interface HandleDescriptor {
  h: string;
  k: "value" | "map" | "array";
  c: "value" | "map" | "array" | null;
}

/**
 * One QuickJS isolate for one execution.
 *
 * Postgres is asynchronous, so the guest's storage calls return QuickJS
 * promises. A host call starts the query immediately and returns a deferred
 * promise; the driver loop below awaits the query, resolves the deferred, and
 * drains the QuickJS job queue. That is what lets an async contract run while
 * its transaction remains open.
 *
 * The contract's top-level code runs read-only; only an endpoint invocation
 * (or the one-time init hook) can write.
 */
export class Sandbox {
  private readonly ctx: QuickJSContext;
  private readonly storage: ContractStorage;
  private readonly db: Db;
  private readonly contractId: string;
  private readonly callId: string;
  private readonly logs: string[];
  private readonly events: ContractEvent[] = [];
  private readonly config: ContractConfig;
  private readonly meter: GasMeter;
  private readonly callerId: string;
  private readonly originId: string;
  private readonly callerKind: "human" | "contract" | "roster-lock";
  private readonly delegate: string | undefined;
  private readonly contractName: string;
  private readonly allowWrites: boolean;
  private readonly contracts: ContractHandleInfo[];
  private readonly callContract: ContractCallHandler | undefined;

  private manifestReader: QuickJSHandle | undefined;
  private invokeHandler: QuickJSHandle | undefined;
  private initHandler: QuickJSHandle | undefined;
  private outcome: Outcome | undefined;
  private backgroundError: unknown;
  private readonly pending: Promise<void>[] = [];
  private logBytes = 0;
  private writable = false;
  private closed = false;

  private compiledStorage: CompiledStorage | undefined;
  private compiledEvents: CompiledEvents | undefined;
  private readonly handles = new Map<string, StorageTarget>();
  private nextHandle = 0;

  manifest: ContractManifest | undefined;

  constructor(module: QuickJSWASMModule, options: SandboxOptions) {
    this.config = options.config;
    this.meter = options.meter;
    this.db = options.db;
    this.contractId = options.contractId;
    this.callId = options.callId;
    this.callerId = options.senderId ?? options.callerId;
    this.originId = options.originId ?? options.callerId;
    this.callerKind = options.callerKind ?? "human";
    this.delegate = options.delegate;
    this.contractName = options.contractName;
    this.allowWrites = !(options.readOnly ?? false);
    this.contracts = options.contracts ?? [];
    this.callContract = options.callContract;
    this.logs = [];

    this.storage = new ContractStorage(
      options.db,
      options.contractId,
      options.meter,
      options.config.gasCosts,
      options.config,
      true,
      options.now ?? Date.now,
    );

    this.ctx = module.newContext();
    try {
      this.ctx.runtime.setMemoryLimit(options.config.memoryLimitBytes);
      this.ctx.runtime.setMaxStackSize(options.config.maxStackBytes);
      this.ctx.runtime.setInterruptHandler(() => options.meter.poll());
      this.installHost();
      this.evalGuarded(PRELUDE_SOURCE, "prelude.js");

      this.manifestReader = this.takeGlobal("__ds_readManifest");
      this.invokeHandler = this.takeGlobal("__ds_invoke");
      this.initHandler = this.takeGlobal("__ds_run_init");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get outOfGas(): boolean {
    return this.meter.burned;
  }

  get callLogs(): readonly string[] {
    return this.logs;
  }

  get callEvents(): readonly ContractEvent[] {
    return this.events;
  }

  /** Compile the contract, extract its manifest and compile its storage. */
  async load(source: string): Promise<ContractManifest> {
    const bytes = utf8ByteLength(source);
    if (bytes > this.config.maxSourceBytes) {
      throw new ContractError(
        "too_large",
        `contract source is ${bytes} bytes, limit is ${this.config.maxSourceBytes}`,
      );
    }
    this.meter.charge(Math.ceil(bytes / 1024) * this.config.gasCosts.loadPerKiB);

    this.writable = false;
    this.storage.setReadOnly(true);
    this.evalGuarded(source, "contract.js");
    await this.settlePending();
    this.throwIfFailed();

    if (!this.manifestReader) {
      throw new QuickJSError("internal error: manifest reader is missing");
    }
    const result = this.ctx.callFunction(this.manifestReader, this.ctx.undefined);
    const handle = this.unwrapOrThrow(result);
    try {
      const json = this.ctx.getString(handle);
      const parsed = parseManifest(json, this.config);
      this.manifest = parsed.manifest;
      this.compiledStorage = parsed.storage;
      this.compiledEvents = parsed.events;
      return this.manifest;
    } finally {
      handle.dispose();
    }
  }

  /**
   * Call one endpoint. The job queue and in-flight queries are driven until
   * nothing is left; a guest that awaits something unresolvable has no pending
   * work and no outcome, and is reported as an execution error.
   */
  async invoke(
    endpoint: string,
    input: JsonValue,
    options: { writable?: boolean } = {},
  ): Promise<JsonValue> {
    if (!this.invokeHandler) {
      throw new QuickJSError("internal error: endpoint dispatcher is missing");
    }
    if (!this.allowWrites) {
      throw new ContractError("invalid_request", "this sandbox is read-only");
    }

    this.writable = options.writable !== false;
    this.storage.setReadOnly(!this.writable);
    this.meter.charge(this.config.gasCosts.baseCall);

    const meta = JSON.stringify({
      msgSender: { kind: this.callerKind, id: this.callerId },
      txOrigin: {
        kind: "human",
        id: this.originId,
        ...(this.delegate === undefined ? {} : { delegate: this.delegate }),
      },
      contract: this.contractName,
      contractId: this.contractId,
      callId: this.callId,
      endpoint,
      contracts: this.contracts,
    });
    const inputJson = JSON.stringify(input === undefined ? null : input);
    if (utf8ByteLength(inputJson) > this.config.maxInputBytes) {
      throw new ContractError("too_large", "input is too large");
    }

    const nameHandle = this.ctx.newString(endpoint);
    const inputHandle = this.ctx.newString(inputJson);
    const metaHandle = this.ctx.newString(meta);
    try {
      this.meter.charge(utf8ByteLength(inputJson) * this.config.gasCosts.payloadByte);
      const result = this.ctx.callFunction(
        this.invokeHandler,
        this.ctx.undefined,
        nameHandle,
        inputHandle,
        metaHandle,
      );
      this.unwrapOrThrow(result).dispose();
    } finally {
      nameHandle.dispose();
      inputHandle.dispose();
      metaHandle.dispose();
    }

    await this.settlePending();
    this.throwIfFailed();
    return this.finishOutcome();
  }

  /** Run the one-time init hook. Used by deploy, inside the deploy transaction. */
  async runInit(callerId: string, initArgs: JsonValue = null): Promise<void> {
    if (!this.initHandler) {
      throw new ContractError("execution_failed", "the contract has no init hook");
    }
    if (!this.allowWrites) {
      throw new ContractError("invalid_request", "this sandbox is read-only");
    }
    this.writable = true;
    this.storage.setReadOnly(false);
    this.meter.charge(this.config.gasCosts.baseCall);

    const metaHandle = this.ctx.newString(
      JSON.stringify({
        msgSender: { kind: "human", id: callerId },
        txOrigin: { kind: "human", id: callerId },
        contract: this.contractName,
        contractId: this.contractId,
        callId: this.callId,
        initArgs,
        contracts: this.contracts,
      }),
    );
    try {
      const result = this.ctx.callFunction(
        this.initHandler,
        this.ctx.undefined,
        metaHandle,
      );
      this.unwrapOrThrow(result).dispose();
    } finally {
      metaHandle.dispose();
    }

    await this.settlePending();
    this.throwIfFailed();
    const outcome = this.finishOutcome();
    void outcome;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.manifestReader?.dispose();
    this.manifestReader = undefined;
    this.invokeHandler?.dispose();
    this.invokeHandler = undefined;
    this.initHandler?.dispose();
    this.initHandler = undefined;
    this.ctx.dispose();
  }

  // -------------------------------------------------------------- internals

  private finishOutcome(): JsonValue {
    if (!this.outcome) {
      throw new ContractError(
        "execution_failed",
        "the endpoint never settled (it awaited something that cannot resolve)",
      );
    }
    if (!this.outcome.ok) {
      throw new ContractError("execution_failed", this.outcome.payload);
    }
    if (utf8ByteLength(this.outcome.payload) > this.config.maxResultBytes) {
      throw new ContractError("too_large", "endpoint result is too large");
    }
    return JSON.parse(this.outcome.payload) as JsonValue;
  }

  private installHost(): void {
    const ctx = this.ctx;
    const host = ctx.newObject();
    try {
      this.defineHost(host, "collectionNames", () =>
        ctx.newString(JSON.stringify([...(this.compiledStorage?.keys() ?? [])])),
      );
      this.defineHost(host, "root", (name) => {
        const collectionName = this.string(name, "collection name");
        const collection = this.compiledStorage?.get(collectionName);
        if (!collection) {
          throw new Error(`unknown storage collection: ${collectionName}`);
        }
        const target: StorageTarget = {
          collection,
          path: "",
          node: collection.node,
          lineage: [],
        };
        return ctx.newString(JSON.stringify(this.describe(target)));
      });

      this.defineHost(host, "valueGet", (id) =>
        this.hostPromise(
          () => this.storage.valueGet(this.handle(id)),
          (value) => this.stringOrUndefined(value),
        ),
      );
      this.defineHost(host, "valueSet", (id, json) => {
        const target = this.handle(id);
        const value = this.string(json, "value");
        return this.hostPromise(
          () => this.storage.valueSet(target, value),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "valueDelete", (id) =>
        this.hostPromise(
          () => this.storage.valueDelete(this.handle(id)),
          () => ctx.undefined,
        ),
      );

      this.defineHost(host, "mapGet", (id, key) => {
        const target = this.handle(id);
        const mapKey = this.string(key, "key");
        return this.hostPromise(
          () => this.storage.mapGet(target, mapKey),
          (value) => this.stringOrUndefined(value),
        );
      });
      this.defineHost(host, "mapChild", (id, key) => {
        const child = this.storage.mapChild(
          this.handle(id),
          this.string(key, "key"),
        );
        return ctx.newString(JSON.stringify(this.describe(child)));
      });
      this.defineHost(host, "mapSet", (id, key, json) => {
        const target = this.handle(id);
        const mapKey = this.string(key, "key");
        const value = this.string(json, "value");
        return this.hostPromise(
          () => this.storage.mapSet(target, mapKey, value),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "mapDelete", (id, key) => {
        const target = this.handle(id);
        const mapKey = this.string(key, "key");
        return this.hostPromise(
          () => this.storage.mapDelete(target, mapKey),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "mapHas", (id, key) => {
        const target = this.handle(id);
        const mapKey = this.string(key, "key");
        return this.hostPromise(
          () => this.storage.mapHas(target, mapKey),
          (present) => (present ? ctx.true : ctx.false),
        );
      });
      this.defineHost(host, "mapKeys", (id, limit, offset) => {
        const target = this.handle(id);
        const pageLimit = this.number(limit, "limit");
        const pageOffset = this.number(offset, "offset");
        return this.hostPromise(
          () => this.storage.mapKeys(target, pageLimit, pageOffset),
          (keys) => ctx.newString(JSON.stringify(keys)),
        );
      });
      this.defineHost(host, "mapEntries", (id, limit, offset) => {
        const target = this.handle(id);
        const map = target.node as CompiledMap;
        const pageLimit = this.number(limit, "limit");
        const pageOffset = this.number(offset, "offset");
        return this.hostPromise(
          () => this.storage.mapEntries(target, pageLimit, pageOffset),
          (entries) =>
            ctx.newString(
              JSON.stringify(
                entries.map((entry) => {
                  if (entry.kind === "value") {
                    return { key: entry.key, t: "v", s: entry.value };
                  }
                  const child: StorageTarget = {
                    collection: target.collection,
                    path: entry.path,
                    node: entry.node,
                    lineage: [
                      ...target.lineage,
                      { path: target.path, key: entry.key, maxEntries: map.maxEntries },
                    ],
                  };
                  return { key: entry.key, t: "h", d: this.describe(child) };
                }),
              ),
            ),
        );
      });
      this.defineHost(host, "mapSize", (id) =>
        this.hostPromise(
          () => this.storage.mapSize(this.handle(id)),
          (size) => ctx.newNumber(size),
        ),
      );
      this.defineHost(host, "mapClear", (id) =>
        this.hostPromise(
          () => this.storage.mapClear(this.handle(id)),
          () => ctx.undefined,
        ),
      );

      this.defineHost(host, "arrayGet", (id, index) => {
        const target = this.handle(id);
        const at = this.number(index, "index");
        return this.hostPromise(
          () => this.storage.arrayGet(target, at),
          (entry) => this.encodeArrayEntry(target, entry),
        );
      });
      this.defineHost(host, "arraySlice", (id, start, count) => {
        const target = this.handle(id);
        const from = this.number(start, "start");
        const take = this.number(count, "count");
        return this.hostPromise(
          () => this.storage.arraySlice(target, from, take),
          (entries) =>
            ctx.newString(
              JSON.stringify(
                entries.map((entry) => this.arrayEntryValue(target, entry)),
              ),
            ),
        );
      });
      this.defineHost(host, "arrayInsert", (id, index, items) => {
        const target = this.handle(id);
        const at = this.number(index, "index");
        const values = this.stringArray(items, "items");
        return this.hostPromise(
          () => this.storage.arrayInsert(target, at, values),
          (length) => ctx.newNumber(length),
        );
      });
      this.defineHost(host, "arrayCreate", (id, index) => {
        const target = this.handle(id);
        const at = this.number(index, "index");
        return this.hostPromise(
          () => this.storage.arrayCreate(target, at),
          (child) => ctx.newString(JSON.stringify(this.describe(child))),
        );
      });
      this.defineHost(host, "arraySet", (id, index, json) => {
        const target = this.handle(id);
        const at = this.number(index, "index");
        const value = this.string(json, "value");
        return this.hostPromise(
          () => this.storage.arraySet(target, at, value),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "arrayRemoveAt", (id, index, count) => {
        const target = this.handle(id);
        const at = this.number(index, "index");
        const take = this.number(count, "count");
        return this.hostPromise(
          () => this.storage.arrayRemoveAt(target, at, take),
          (values) => ctx.newString(JSON.stringify(values)),
        );
      });
      this.defineHost(host, "arrayMove", (id, from, to) => {
        const target = this.handle(id);
        const source = this.number(from, "from");
        const destination = this.number(to, "to");
        return this.hostPromise(
          () => this.storage.arrayMove(target, source, destination),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "arrayMoveToTop", (id, from) => {
        const target = this.handle(id);
        const source = this.number(from, "from");
        return this.hostPromise(
          () => this.storage.arrayMoveToTop(target, source),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "arrayMoveToBottom", (id, from) => {
        const target = this.handle(id);
        const source = this.number(from, "from");
        return this.hostPromise(
          () => this.storage.arrayMoveToBottom(target, source),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "arrayLength", (id) =>
        this.hostPromise(
          () => this.storage.arrayLength(this.handle(id)),
          (length) => ctx.newNumber(length),
        ),
      );
      this.defineHost(host, "arrayClear", (id) =>
        this.hostPromise(
          () => this.storage.arrayClear(this.handle(id)),
          () => ctx.undefined,
        ),
      );

      this.defineHost(host, "contractCall", (target, endpoint, input) => {
        if (!this.callContract) {
          throw new Error("cross-contract calls are not available here");
        }
        const targetId = this.string(target, "contract id");
        const endpointName = this.string(endpoint, "endpoint");
        const inputJson = this.string(input, "input");
        return this.hostPromise(
          () => this.callContract!(targetId, endpointName, JSON.parse(inputJson) as JsonValue),
          (result) => ctx.newString(JSON.stringify(result)),
        );
      });

      this.defineHost(host, "emit", (name, payload) => {
        const eventName = this.string(name, "event name");
        const eventPayload = this.string(payload, "event payload");
        return this.hostPromise(
          () => this.emitEvent(eventName, eventPayload),
          () => ctx.undefined,
        );
      });
      this.defineHost(host, "log", (level, message) => {
        this.appendLog(this.string(level, "level"), this.string(message, "message"));
        return ctx.undefined;
      });
      this.defineHost(host, "finish", (status, payload) => {
        this.finish(this.number(status, "status"), this.string(payload, "payload"));
        return ctx.undefined;
      });

      ctx.setProp(ctx.global, "__ds_host", host);
    } finally {
      host.dispose();
    }
  }

  private defineHost(
    host: QuickJSHandle,
    name: string,
    implementation: (...args: QuickJSHandle[]) => QuickJSHandle,
  ): void {
    const handle = this.ctx.newFunction(name, implementation);
    try {
      this.ctx.setProp(host, name, handle);
    } finally {
      handle.dispose();
    }
  }

  private describe(target: StorageTarget): HandleDescriptor {
    const id = `h${++this.nextHandle}`;
    this.handles.set(id, target);
    const node = target.node;
    const child =
      node.kind === "map"
        ? node.value.kind
        : node.kind === "array"
          ? node.item.kind
          : null;
    return { h: id, k: node.kind, c: child };
  }

  private handle(id: QuickJSHandle): StorageTarget {
    const key = this.string(id, "handle");
    const target = this.handles.get(key);
    if (!target) throw new Error("unknown or expired storage handle");
    return target;
  }

  private encodeArrayEntry(
    target: StorageTarget,
    entry: { kind: "value"; value: string } | { kind: "node"; path: string; node: StorageTarget["node"] } | undefined,
  ): QuickJSHandle {
    if (entry === undefined) return this.ctx.undefined;
    return this.ctx.newString(JSON.stringify(this.arrayEntryValue(target, entry)));
  }

  private arrayEntryValue(
    target: StorageTarget,
    entry: { kind: "value"; value: string } | { kind: "node"; path: string; node: StorageTarget["node"] },
  ): unknown {
    if (entry.kind === "value") {
      return { t: "v", s: entry.value };
    }
    const child: StorageTarget = {
      collection: target.collection,
      path: entry.path,
      node: entry.node,
      lineage: target.lineage,
    };
    return { t: "h", d: this.describe(child) };
  }

  private stringArray(handle: QuickJSHandle, label: string): string[] {
    const dumped = this.ctx.dump(handle);
    if (!Array.isArray(dumped)) throw new TypeError(`${label} must be an array`);
    return dumped.map((item, index) => {
      if (typeof item !== "string") {
        throw new TypeError(`${label}[${index}] must be JSON text`);
      }
      return item;
    });
  }

  /**
   * Start `work` and hand the guest a promise for it. `work` starts
   * immediately; the driver loop awaits it before draining the queue again.
   */
  private hostPromise<T>(
    work: () => Promise<T>,
    encode: (value: T) => QuickJSHandle,
  ): QuickJSHandle {
    const deferred = this.ctx.newPromise();
    const started = work().then(
      (value) => {
        try {
          if (!this.closed) deferred.resolve(encode(value));
        } catch (error) {
          this.backgroundError ??= error;
        } finally {
          this.disposeDeferred(deferred);
        }
      },
      (error) => {
        try {
          if (!this.closed) this.rejectDeferred(deferred, error);
        } finally {
          this.disposeDeferred(deferred);
        }
      },
    );
    this.pending.push(started);
    return deferred.handle;
  }

  private rejectDeferred(deferred: QuickJSDeferredPromise, error: unknown): void {
    try {
      const message = error instanceof Error ? error.message : String(error);
      const handle = this.ctx.newError({ name: "Error", message });
      try {
        deferred.reject(handle);
      } finally {
        handle.dispose();
      }
    } catch {
      // The context is going away; nothing left to reject.
    }
  }

  private disposeDeferred(deferred: QuickJSDeferredPromise): void {
    try {
      deferred.dispose();
    } catch {
      // Already disposed with the context.
    }
  }

  private string(handle: QuickJSHandle, label: string): string {
    if (this.ctx.typeof(handle) !== "string") {
      throw new TypeError(`${label} must be a string`);
    }
    return this.ctx.getString(handle);
  }

  private number(handle: QuickJSHandle, label: string): number {
    if (this.ctx.typeof(handle) !== "number") {
      throw new TypeError(`${label} must be a number`);
    }
    return this.ctx.getNumber(handle);
  }

  private stringOrUndefined(value: string | undefined): QuickJSHandle {
    return value === undefined ? this.ctx.undefined : this.ctx.newString(value);
  }

  private async emitEvent(name: string, payload: string): Promise<void> {
    if (!this.writable) {
      throw new Error("events cannot be emitted by a read-only endpoint");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new TypeError(`invalid event name: ${name}`);
    }
    const bytes = utf8ByteLength(payload);
    if (bytes > this.config.maxEventBytes) {
      throw new RangeError(
        `event payload is ${bytes} bytes, limit is ${this.config.maxEventBytes}`,
      );
    }
    if (this.events.length >= this.config.maxEventsPerCall) {
      throw new RangeError(
        `at most ${this.config.maxEventsPerCall} events can be emitted per call`,
      );
    }
    const declaration = this.compiledEvents?.get(name);
    if (!declaration) {
      throw new Error(`event ${name} is not declared by the contract`);
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(payload) as JsonValue;
    } catch {
      throw new TypeError("event payload is not valid JSON");
    }
    const validation = declaration.validator.validate(parsed);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw new TypeError(
        `event ${name} does not match its schema: ${
          first ? `${first.instanceLocation}: ${first.error}` : "invalid"
        }`,
      );
    }
    this.meter.charge(
      this.config.gasCosts.schemaValidation +
        this.config.gasCosts.hostCall +
        this.config.gasCosts.statement +
        this.config.gasCosts.rowWritten +
        this.config.gasCosts.event +
        bytes * this.config.gasCosts.byte,
    );
    const createdAt = Date.now();
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO dsc_event
         (contract_id, name, payload, caller_id, call_id, created_at, delegate)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        this.contractId,
        name,
        payload,
        this.callerId,
        this.callId,
        createdAt,
        this.delegate ?? null,
      ],
    );
    this.events.push({
      id: String(rows.rows[0].id),
      contractId: this.contractId,
      name,
      payload: parsed,
      callerId: this.callerId,
      callId: this.callId,
      createdAt,
      ...(this.delegate === undefined ? {} : { delegate: this.delegate }),
    });
  }

  private appendLog(level: string, message: string): void {
    this.meter.charge(this.config.gasCosts.logEntry);
    const line = `[${level}] ${message}`;
    const bytes = utf8ByteLength(line);
    if (this.logBytes + bytes > this.config.maxLogBytes) return;
    this.logBytes += bytes;
    this.logs.push(line);
  }

  private finish(status: number, payload: string): void {
    if (this.outcome) return;
    if (status !== 0 && status !== 1) throw new TypeError("invalid finish status");
    this.meter.charge(utf8ByteLength(payload) * this.config.gasCosts.payloadByte);
    this.outcome = { ok: status === 0, payload };
  }

  private throwIfFailed(): void {
    if (this.meter.burned) {
      throw new ContractError("out_of_gas", "the contract ran out of gas");
    }
    if (this.backgroundError) {
      const message =
        this.backgroundError instanceof Error
          ? this.backgroundError.message
          : String(this.backgroundError);
      throw new ContractError("execution_failed", message);
    }
  }

  private async settlePending(): Promise<void> {
    for (;;) {
      this.drainJobs();
      if (this.closed || this.backgroundError || this.meter.burned) return;
      if (this.pending.length === 0) return;
      this.meter.checkDeadline();
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
  }

  private drainJobs(): void {
    for (;;) {
      if (this.closed || this.meter.burned || this.backgroundError) return;
      const result = this.ctx.runtime.executePendingJobs(256);
      if (result.error) {
        const dumped = this.ctx.dump(result.error) as { message?: unknown } | undefined;
        result.dispose();
        this.backgroundError ??= new Error(
          dumped && typeof dumped.message === "string"
            ? dumped.message
            : "unhandled error in the job queue",
        );
        return;
      }
      if (result.unwrap() === 0) return;
    }
  }

  private evalGuarded(source: string, filename: string): void {
    const result = this.ctx.evalCode(source, filename);
    const handle = this.unwrapOrThrow(result);
    handle.dispose();
  }

  private unwrapOrThrow(result: HandleResult): QuickJSHandle {
    try {
      return this.ctx.unwrapResult(result as never);
    } catch (error) {
      if (this.meter.burned) {
        throw new ContractError("out_of_gas", "the contract ran out of gas");
      }
      const dumped = error as { name?: string; message?: string; stack?: string };
      throw new QuickJSError(dumped.message ?? String(error), dumped.stack);
    }
  }

  private takeGlobal(name: string): QuickJSHandle {
    const handle = this.ctx.getProp(this.ctx.global, name);
    try {
      this.ctx.setProp(this.ctx.global, name, this.ctx.undefined);
      return handle;
    } catch (error) {
      handle.dispose();
      throw error;
    }
  }
}

function parseManifest(json: string, config: ContractConfig): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ContractError("analysis_failed", "the contract manifest is not valid JSON");
  }
  if (!raw || typeof raw !== "object") {
    throw new ContractError("analysis_failed", "the contract manifest must be an object");
  }
  const record = raw as Record<string, unknown>;
  const endpointsRaw = record.endpoints;
  if (!endpointsRaw || typeof endpointsRaw !== "object") {
    throw new ContractError("analysis_failed", "the contract must define endpoints");
  }
  const entries = Object.entries(endpointsRaw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ContractError("analysis_failed", "the contract must define at least one endpoint");
  }
  if (entries.length > config.maxEndpoints) {
    throw new ContractError("analysis_failed", "the contract defines too many endpoints");
  }

  const budget = { schemaBytes: 0 };
  const endpoints: ContractManifest["endpoints"] = {};
  for (const [name, value] of entries) {
    if (!ENDPOINT_NAME.test(name)) {
      throw new ContractError("analysis_failed", `invalid endpoint name: ${name}`);
    }
    if (!value || typeof value !== "object") {
      throw new ContractError("analysis_failed", `endpoint ${name} has no metadata`);
    }
    const endpoint = value as Record<string, unknown>;
    const gasLimit = endpoint.gasLimit;
    if (
      typeof gasLimit !== "number" ||
      !Number.isInteger(gasLimit) ||
      gasLimit < 0
    ) {
      throw new ContractError("analysis_failed", `endpoint ${name} has an invalid gasLimit`);
    }
    const access = endpoint.access;
    if (
      access !== "public" &&
      access !== "human" &&
      access !== "contract" &&
      access !== "roster-lock"
    ) {
      throw new ContractError("analysis_failed", `endpoint ${name} has an invalid access mode`);
    }
    const mutates = endpoint.mutates === undefined ? true : endpoint.mutates;
    if (typeof mutates !== "boolean") {
      throw new ContractError("analysis_failed", `endpoint ${name} has an invalid mutates flag`);
    }
    let input: EndpointManifest["input"];
    if (endpoint.input !== undefined) {
      if (!isPlainObject(endpoint.input)) {
        throw new ContractError(
          "analysis_failed",
          `endpoint ${name}.input must be a JSON Schema object`,
        );
      }
      rejectRefs(endpoint.input, `endpoint.${name}.input`, 0, "endpoint input schema");
      budget.schemaBytes += JSON.stringify(endpoint.input).length;
      if (budget.schemaBytes > config.maxSchemaBytes) {
        throw new ContractError(
          "analysis_failed",
          `storage, event and input schemas exceed ${config.maxSchemaBytes} bytes`,
        );
      }
      try {
        new Validator(endpoint.input, "2020-12");
      } catch (error) {
        throw new ContractError(
          "analysis_failed",
          `endpoint ${name}.input is not a valid JSON Schema: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      input = endpoint.input as EndpointManifest["input"];
    }
    endpoints[name] = {
      gasLimit,
      access: access as EndpointAccess,
      mutates,
      ...(input === undefined ? {} : { input }),
    };
  }

  const storage = parseStorage(record.storage, config, budget);
  const events = parseEvents(record.events, config, budget);

  return {
    manifest: {
      name: typeof record.name === "string" ? record.name : "",
      version: typeof record.version === "string" ? record.version : "0",
      endpoints,
      storage: storage.declarations,
      events: events.declarations,
      hasInit: record.hasInit === true,
    },
    storage: storage.compiled,
    events: events.compiled,
  };
}

/**
 * Loads the QuickJS WASM module once per isolate. A sandbox is cheap; the
 * module load is the only expensive, async part.
 */
export class SandboxRuntime {
  private module: QuickJSWASMModule | undefined;
  private loading: Promise<QuickJSWASMModule> | undefined;

  constructor(private readonly loader: () => Promise<QuickJSWASMModule> = getQuickJS) {}

  async ready(): Promise<void> {
    if (this.module) return;
    this.loading ??= this.loader();
    this.module = await this.loading;
  }

  create(options: SandboxOptions): Sandbox {
    if (!this.module) {
      throw new Error("SandboxRuntime.create() called before ready()");
    }
    return new Sandbox(this.module, options);
  }
}
