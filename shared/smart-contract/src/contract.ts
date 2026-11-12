import { analyzeContract } from "./analyze.js";
import { ContractError, QuickJSError } from "./errors.js";
import { GasMeter, gasToCredits } from "./gas.js";
import { SandboxRuntime } from "./runtime/sandbox.js";
import type { ContractHandleInfo, Sandbox } from "./runtime/sandbox.js";
import type { Db, OpenDb } from "./sql/driver.js";
import { readOnlyTransaction, transaction } from "./sql/driver.js";
import { migrate } from "./sql/schema.js";
import {
  DEFAULT_CONFIG,
  type CallInput,
  type CallLogEntry,
  type CallResult,
  type ContractConfig,
  type ContractEvent,
  type ContractManifest,
  type ContractRecord,
  type DeployInput,
  type DeployPreview,
  type DeployResult,
  type JsonValue,
} from "./types.js";
import { listContracts } from "./registry.js";
import type { ContractFilter, ContractSummary } from "./registry.js";
import { utf8ByteLength } from "./util/bytes.js";
import { ContractStorage } from "./state/collections.js";
import { snapshotStorage } from "./state/snapshot.js";
import { Validator } from "@cfworker/json-schema";
import { parseStorage, schemaChanged } from "./storage/declaration.js";
import { WalletLedger } from "./wallet.js";

export interface ContractServiceOptions {
  /** The Durable Object's contract id; namespaces its state in Postgres. */
  contractId: string;
  /** Default roster for deployments made through this service. */
  rosterId?: string;
  /** Opens one Postgres connection per call (Hyperdrive in production). */
  openDb: OpenDb;
  config?: Partial<Omit<ContractConfig, "gasCosts">> & {
    gasCosts?: Partial<ContractConfig["gasCosts"]>;
  };
  now?: () => number;
  runtime?: SandboxRuntime;
}

const EMPTY_LOGS: string[] = [];
const EMPTY_EVENTS: ContractEvent[] = [];

/**
 * Deploy, call and settle one contract in Postgres.
 *
 * Each call owns one connection and one Postgres transaction that stays open
 * while the guest runs. The escrow and the settlement are short transactions
 * on the same connection, before and after it - so money is never part of a
 * transaction that can be rolled back by contract code.
 */
export class ContractService {
  readonly config: ContractConfig;
  readonly contractId: string;
  readonly rosterId: string | undefined;
  private readonly openDb: OpenDb;
  private readonly runtime: SandboxRuntime;
  private readonly ledger: WalletLedger;
  private readonly now: () => number;

  constructor(options: ContractServiceOptions) {
    if (!options.contractId) {
      throw new Error("contractId is required");
    }
    this.contractId = options.contractId;
    this.rosterId = options.rosterId;
    this.openDb = options.openDb;
    this.now = options.now ?? Date.now;
    this.config = mergeConfig(options.config);
    this.runtime = options.runtime ?? new SandboxRuntime();
    this.ledger = new WalletLedger(this.now, this.config.hardTimeoutMs);
  }

  async initialize(): Promise<void> {
    await this.withDb((db) => migrate(db));
    await this.runtime.ready();
  }

  // ----------------------------------------------------------------- deploy

  async deploy(input: DeployInput): Promise<DeployResult> {
    requireString(input.ownerId, "ownerId");
    requireString(input.name, "name");
    if (typeof input.source !== "string" || input.source.length === 0) {
      throw new ContractError("invalid_request", "source is required");
    }
    if (input.contractId !== undefined && input.contractId !== this.contractId) {
      throw new ContractError(
        "invalid_request",
        "contractId does not match this contract object",
      );
    }
    const rosterId = this.rosterId;
    if (
      rosterId !== undefined &&
      (typeof rosterId !== "string" || rosterId.length > 128)
    ) {
      throw new ContractError("invalid_request", "rosterId must be a string of at most 128 chars");
    }
    let handle: string | undefined;
    let deployedHandle: string | undefined;
    let deployedRosterId: string | undefined;
    if (rosterId !== undefined) {
      handle = input.handle ?? input.name;
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(handle)) {
        throw new ContractError(
          "invalid_request",
          "handle must start with a letter/underscore and contain only letters, numbers, _ or -",
        );
      }
    } else if (input.handle !== undefined) {
      throw new ContractError("invalid_request", "handle requires the service to know its roster");
    }
    let initArgsJson: string | null = null;
    if (input.initArgs !== undefined) {
      try {
        initArgsJson = JSON.stringify(input.initArgs);
      } catch {
        throw new ContractError("invalid_request", "initArgs is not JSON-serializable");
      }
      if (utf8ByteLength(initArgsJson) > this.config.maxInitArgsBytes) {
        throw new ContractError("too_large", "initArgs is too large");
      }
    }

    const analysis = analyzeContract(input.source, {
      maxSourceBytes: this.config.maxSourceBytes,
    });
    if (!analysis.ok) {
      throw new ContractError(
        "analysis_failed",
        "static analysis rejected the contract",
        analysis.issues,
      );
    }

    await this.runtime.ready();
    const sourceHash = await sha256Hex(input.source);
    const timestamp = this.now();

    return this.withDb(async (db) => {
      const meter = new GasMeter(this.config.deployGasLimit, this.config.gasCosts, {
        now: this.now,
        timeoutMs: this.config.initTimeoutMs,
      });

      let manifest: ContractManifest | undefined;
      await readOnlyTransaction(db, async (tx) => {
        await setLocalTimeout(tx, this.config.initTimeoutMs);
        const sandbox = this.runtime.create({
          db: tx,
          contractId: this.contractId,
          callId: `deploy:${this.contractId}`,
          meter,
          config: this.config,
          callerId: input.ownerId,
          contractName: input.name,
          readOnly: true,
          now: this.now,
        });
        try {
          manifest = await sandbox.load(input.source);
        } catch (error) {
          if (meter.burned) {
            throw new ContractError(
              "out_of_gas",
              "the contract used its whole deploy gas budget while loading",
            );
          }
          throw asContractError(error, "analysis_failed");
        } finally {
          sandbox.dispose();
        }
      });

      if (!manifest) {
        throw new ContractError("analysis_failed", "the contract produced no manifest");
      }

      await transaction(db, async (tx) => {
        await setLocalTimeout(tx, this.config.initTimeoutMs);
        await lockContract(tx, this.contractId);
        const existing = await this.getContractFrom(tx);
        if (existing && existing.ownerId !== input.ownerId) {
          throw new ContractError(
            "forbidden",
            "only the owner who deployed this contract can replace it",
          );
        }

        if (existing) {
          for (const [name, collection] of Object.entries(manifest!.storage)) {
            const previous = existing.manifest.storage[name];
            if (
              previous &&
              schemaChanged(previous, collection) &&
              (collection.version ?? 1) <= (previous.version ?? 1)
            ) {
              throw new ContractError(
                "schema_changed",
                `storage.${name} changed; increment its version to acknowledge the migration`,
              );
            }
          }
        }

        if (
          existing?.handle !== undefined &&
          input.handle !== undefined &&
          input.handle !== existing.handle
        ) {
          throw new ContractError(
            "invalid_request",
            "handle cannot change after the contract is deployed",
          );
        }
        const resolvedHandle = existing?.handle ?? handle ?? null;
        deployedHandle = resolvedHandle ?? undefined;
        deployedRosterId = existing?.rosterId ?? rosterId;
        const deployedVersion = input.version ?? manifest!.version ?? existing?.version ?? "0";
        try {
          await tx.query(
            `INSERT INTO dsc_contract
               (contract_id, owner_id, name, version, handle, roster_id, init_args,
                source, source_hash, manifest, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (contract_id) DO UPDATE SET
               owner_id = EXCLUDED.owner_id,
               name = EXCLUDED.name,
               version = EXCLUDED.version,
               handle = COALESCE(dsc_contract.handle, EXCLUDED.handle),
               roster_id = EXCLUDED.roster_id,
               init_args = EXCLUDED.init_args,
               source = EXCLUDED.source,
               source_hash = EXCLUDED.source_hash,
               manifest = EXCLUDED.manifest,
               updated_at = EXCLUDED.updated_at`,
            [
              this.contractId,
              input.ownerId,
              input.name,
              deployedVersion,
              resolvedHandle,
              existing?.rosterId ?? rosterId ?? null,
              initArgsJson,
              input.source,
              sourceHash,
              JSON.stringify(manifest),
              existing?.createdAt ?? timestamp,
              timestamp,
            ],
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/duplicate key|unique constraint|dsc_contract_handle/i.test(message)) {
            throw new ContractError(
              "handle_taken",
              `handle ${handle ?? resolvedHandle} is already used in this roster`,
            );
          }
          throw error;
        }

        if (!existing) {
          const compiled = parseStorage(manifest!.storage, this.config).compiled;
          const seedStorage = new ContractStorage(
            tx,
            this.contractId,
            meter,
            this.config.gasCosts,
            this.config,
            false,
            this.now,
          );
          try {
            for (const collection of compiled.values()) {
              if (collection.node.initial !== undefined) {
                await seedStorage.seed(collection, collection.node.initial);
              }
            }
          } catch (error) {
            if (meter.burned) {
              throw new ContractError(
                "out_of_gas",
                "the contract used its whole deploy gas budget while seeding initial values",
              );
            }
            throw error;
          }

          if (manifest!.hasInit) {
            const initMeter = new GasMeter(this.config.initGasLimit, this.config.gasCosts, {
              now: this.now,
              timeoutMs: this.config.initTimeoutMs,
            });
            await setLocalTimeout(tx, this.config.initTimeoutMs);
            const initSandbox = this.runtime.create({
              db: tx,
              contractId: this.contractId,
              callId: `init:${this.contractId}`,
              meter: initMeter,
              config: this.config,
              callerId: input.ownerId,
              contractName: input.name,
              readOnly: false,
              now: this.now,
            });
            try {
              await initSandbox.load(input.source);
              await initSandbox.runInit(input.ownerId, input.initArgs ?? null);
            } catch (error) {
              if (initMeter.burned) {
                throw new ContractError(
                  "out_of_gas",
                  "the contract's init hook ran out of gas",
                );
              }
              throw asContractError(error, "execution_failed");
            } finally {
              initSandbox.dispose();
            }
          }
        }
      });

      return {
        contractId: this.contractId,
        ownerId: input.ownerId,
        name: input.name,
        version: input.version ?? manifest!.version ?? "0",
        handle: deployedHandle,
        rosterId: deployedRosterId,
        sourceHash,
        manifest,
        analysis,
      };
    });
  }

  // ---------------------------------------------------------------- preview

  /**
   * Analyze and dry-run a contract without storing it. The deploy UI can show
   * the endpoint list (and which ones mutate), the storage schemas and the
   * analysis warnings before the owner commits.
   */
  async preview(input: {
    ownerId: string;
    name: string;
    source: string;
  }): Promise<DeployPreview> {
    requireString(input.ownerId, "ownerId");
    requireString(input.name, "name");
    if (typeof input.source !== "string" || input.source.length === 0) {
      throw new ContractError("invalid_request", "source is required");
    }
    const analysis = analyzeContract(input.source, {
      maxSourceBytes: this.config.maxSourceBytes,
    });
    if (!analysis.ok) {
      throw new ContractError(
        "analysis_failed",
        "static analysis rejected the contract",
        analysis.issues,
      );
    }
    await this.runtime.ready();
    const sourceHash = await sha256Hex(input.source);

    return this.withDb(async (db) => {
      const meter = new GasMeter(this.config.deployGasLimit, this.config.gasCosts, {
        now: this.now,
        timeoutMs: this.config.initTimeoutMs,
      });
      let manifest: ContractManifest | undefined;
      await readOnlyTransaction(db, async (tx) => {
        await setLocalTimeout(tx, this.config.initTimeoutMs);
        const sandbox = this.runtime.create({
          db: tx,
          contractId: this.contractId,
          callId: `preview:${this.contractId}`,
          meter,
          config: this.config,
          callerId: input.ownerId,
          contractName: input.name,
          readOnly: true,
          now: this.now,
        });
        try {
          manifest = await sandbox.load(input.source);
        } catch (error) {
          if (meter.burned) {
            throw new ContractError(
              "out_of_gas",
              "the contract used its whole preview gas budget while loading",
            );
          }
          throw asContractError(error, "analysis_failed");
        } finally {
          sandbox.dispose();
        }
      });
      if (!manifest) {
        throw new ContractError("analysis_failed", "the contract produced no manifest");
      }
      return {
        contractId: this.contractId,
        name: input.name,
        sourceHash,
        manifest,
        analysis,
      };
    });
  }

  // ------------------------------------------------------------------- call

  async call(input: CallInput): Promise<CallResult> {
    await this.runtime.ready();
    requireString(input.callerId, "callerId");
    requireString(input.endpoint, "endpoint");

    return this.withDb(async (db) => {
      await this.ledger.reconcile(db, this.contractId);

      const record = await this.getContractFrom(db);
      if (!record) {
        throw new ContractError("contract_not_deployed", "no contract has been deployed");
      }

      const endpoint = record.manifest.endpoints[input.endpoint];
      if (!endpoint) {
        throw new ContractError(
          "unknown_endpoint",
          `the contract has no endpoint named ${input.endpoint}`,
        );
      }
      const callerKind = input.callerKind ?? "human";
      if (
        callerKind !== "human" &&
        callerKind !== "contract" &&
        callerKind !== "roster-lock"
      ) {
        throw new ContractError("invalid_request", "callerKind is not valid");
      }
      if (callerKind === "human" && input.callerId.startsWith("contract:")) {
        throw new ContractError(
          "forbidden",
          "contract: caller ids are reserved for internal cross-contract calls",
        );
      }
      if (endpoint.access === "human" && callerKind !== "human") {
        throw new ContractError(
          "forbidden",
          "this endpoint can only be called by a human",
        );
      }
      if (endpoint.access === "contract" && callerKind !== "contract") {
        throw new ContractError(
          "forbidden",
          "this endpoint can only be called by another contract",
        );
      }
      if (endpoint.access === "roster-lock" && callerKind !== "roster-lock") {
        throw new ContractError(
          "forbidden",
          "this endpoint can only be called by the roster-lock platform",
        );
      }

      const payload = input.input === undefined ? null : input.input;
      let inputJson: string;
      try {
        inputJson = JSON.stringify(payload);
      } catch {
        throw new ContractError("invalid_request", "input is not JSON-serializable");
      }
      if (utf8ByteLength(inputJson) > this.config.maxInputBytes) {
        throw new ContractError("too_large", "input is too large");
      }
      if (endpoint.input) {
        const validator = new Validator(endpoint.input, "2020-12");
        const validation = validator.validate(payload);
        if (!validation.valid) {
          const first = validation.errors[0];
          throw new ContractError(
            "invalid_input",
            `input does not match endpoint schema: ${
              first ? `${first.instanceLocation}: ${first.error}` : "invalid"
            }`,
          );
        }
      }

      const requested =
        endpoint.gasLimit > 0 ? endpoint.gasLimit : this.config.defaultGasLimit;
      const maxGas = Math.min(
        Math.max(requested, this.config.minGasLimit),
        this.config.maxGasPerCall,
      );
      const escrowAmount = gasToCredits(maxGas, this.config.gasPricePerMillion);
      const escrowId = crypto.randomUUID();
      await this.ledger.escrow(
        db,
        this.contractId,
        input.callerId,
        escrowId,
        escrowAmount,
        this.config.escrowTtlMs,
      );

      const meter = new GasMeter(maxGas, this.config.gasCosts, {
        now: this.now,
        timeoutMs: this.config.hardTimeoutMs,
      });

      let result: JsonValue = null;
      let logs: string[] = EMPTY_LOGS;
      let events: ContractEvent[] = EMPTY_EVENTS;
      let errorMessage: string | null = null;
      let status: "ok" | "error" | "out_of_gas" = "ok";
      let sandbox: Sandbox | undefined;
      // Manifests written before `mutates` existed default to mutating.
      const mutates = endpoint.mutates !== false;

      try {
        const run = async (tx: Db): Promise<void> => {
          const current = await this.getContractFrom(tx);
          if (!current) {
            throw new ContractError("contract_not_deployed", "the contract disappeared mid-call");
          }
          if (current.sourceHash !== record.sourceHash) {
            throw new ContractError(
              "contract_changed",
              "the contract was redeployed while this call was starting",
            );
          }

          const contracts = await this.buildContractHandles(tx, current, meter);
          const stack = new Set([this.contractId]);
          sandbox = this.runtime.create({
            db: tx,
            contractId: this.contractId,
            callId: escrowId,
            meter,
            config: this.config,
            callerId: input.callerId,
            senderId: input.senderId ?? input.callerId,
            originId: input.callerId,
            callerKind,
            delegate: input.delegate,
            contractName: current.name,
            contracts,
            callContract: (targetId, endpoint, payload) =>
              this.callCrossContract(
                tx,
                current,
                targetId,
                endpoint,
                payload,
                meter,
                input.callerId,
                input.delegate,
                stack,
                0,
                mutates,
              ),
            now: this.now,
          });
          try {
            await sandbox.load(current.source);
            result = await sandbox.invoke(input.endpoint, payload, {
              writable: mutates,
            });
            logs = [...sandbox.callLogs];
            events = [...sandbox.callEvents];
          } finally {
            sandbox.dispose();
          }
        };

        if (mutates) {
          // The state transaction is held open for the whole guest execution.
          // The advisory lock serializes calls for this contract even if two
          // isolates ever run one - the Durable Object already serializes them.
          await transaction(db, async (tx) => {
            await setLocalTimeout(tx, this.config.hardTimeoutMs);
            await lockContract(tx, this.contractId);
            await run(tx);
          });
        } else {
          // A view: no lock, and the sandbox runs read-only. The transaction
          // is only there for a consistent snapshot, and is rolled back.
          await readOnlyTransaction(db, async (tx) => {
            await setLocalTimeout(tx, this.config.hardTimeoutMs);
            await run(tx);
          });
        }
      } catch (error) {
        status = meter.burned ? "out_of_gas" : "error";
        errorMessage = error instanceof Error ? error.message : String(error);
        logs = sandbox ? [...sandbox.callLogs] : EMPTY_LOGS;
        events = EMPTY_EVENTS;
      }

      const gasUsed = meter.billed();
      const gasCharged = meter.burned
        ? escrowAmount
        : gasToCredits(gasUsed, this.config.gasPricePerMillion);
      const refund = Math.max(0, escrowAmount - gasCharged);

      await this.ledger.settle(db, {
        escrowId,
        contractId: this.contractId,
        refund,
        callerId: input.callerId,
        endpoint: input.endpoint,
        status,
        gasUsed,
        gasCharged,
        error: errorMessage,
        delegate: input.delegate,
      });

      if (status === "out_of_gas") {
        throw new ContractError(
          "out_of_gas",
          `endpoint ${input.endpoint} ran out of gas after ${gasUsed} gas`,
        );
      }
      if (status === "error") {
        throw new ContractError(
          "execution_failed",
          errorMessage ?? `endpoint ${input.endpoint} failed`,
        );
      }

      return {
        contractId: this.contractId,
        endpoint: input.endpoint,
        callerId: input.callerId,
        status: "ok",
        mutates,
        result,
        gasUsed,
        gasCharged,
        logs,
        events,
        ...(input.delegate === undefined ? {} : { delegate: input.delegate }),
      };
    });
  }

  // --------------------------------------------------------------- read side

  async getContract(): Promise<ContractRecord | undefined> {
    return this.withDb((db) => this.getContractFrom(db));
  }

  async listCalls(limit = 50): Promise<CallLogEntry[]> {
    return this.withDb(async (db) => {
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
      const rows = await db.query<{
        id: string;
        caller_id: string;
        endpoint: string;
        status: CallLogEntry["status"];
        gas_used: string | number;
        gas_charged: string | number;
        error: string | null;
        created_at: string | number;
        delegate: string | null;
      }>(
        `SELECT id, caller_id, endpoint, status, gas_used, gas_charged, error, created_at, delegate
         FROM dsc_call_log WHERE contract_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [this.contractId, bounded],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        callerId: row.caller_id,
        endpoint: row.endpoint,
        status: row.status,
        gasUsed: Number(row.gas_used),
        gasCharged: Number(row.gas_charged),
        error: row.error,
        createdAt: Number(row.created_at),
        ...(row.delegate === null ? {} : { delegate: row.delegate }),
      }));
    });
  }

  async balance(userId: string): Promise<number> {
    return this.withDb((db) => this.ledger.balance(db, userId));
  }

  async credit(userId: string, amount: number): Promise<number> {
    return this.withDb((db) => this.ledger.credit(db, userId, amount));
  }

  async reconcile(): Promise<number> {
    return this.withDb((db) => this.ledger.reconcile(db, this.contractId));
  }

  async listEvents(
    after: string | number | undefined = undefined,
    limit = 100,
    names?: string[],
  ): Promise<ContractEvent[]> {
    const afterValue =
      after === undefined || after === null || after === "" ? null : String(after);
    if (afterValue !== null && !/^\d+$/.test(afterValue)) {
      throw new ContractError("invalid_request", "after must be an event id");
    }
    if (
      names !== undefined &&
      (names.length > 32 || names.some((name) => typeof name !== "string" || name.length > 64))
    ) {
      throw new ContractError("invalid_request", "at most 32 event names may be filtered");
    }
    const filter = names && names.length > 0 ? names : null;
    const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
    return this.withDb(async (db) => {
      const rows = await db.query<{
        id: string;
        contract_id: string;
        name: string;
        payload: string;
        caller_id: string;
        call_id: string;
        created_at: string | number;
        delegate: string | null;
      }>(
        `SELECT id, contract_id, name, payload, caller_id, call_id, created_at, delegate
         FROM dsc_event
         WHERE contract_id = $1
           AND ($2::bigint IS NULL OR id > $2::bigint)
           AND ($3::text[] IS NULL OR name = ANY($3::text[]))
         ORDER BY id ASC LIMIT $4`,
        [this.contractId, afterValue, filter, bounded],
      );
      return rows.rows.map((row) => ({
        id: String(row.id),
        contractId: row.contract_id,
        name: row.name,
        payload: JSON.parse(row.payload) as JsonValue,
        callerId: row.caller_id,
        callId: row.call_id,
        createdAt: Number(row.created_at),
        ...(row.delegate === null ? {} : { delegate: row.delegate }),
      }));
    });
  }

  /** The shared registry: contracts deployed for a roster or an owner. */
  async listContracts(filter: ContractFilter = {}): Promise<ContractSummary[]> {
    return this.withDb((db) => listContracts(db, filter));
  }

  // -------------------------------------------------------------- internals

  private async callCrossContract(
    db: Db,
    caller: ContractRecord,
    targetId: string,
    endpointName: string,
    payload: JsonValue,
    meter: GasMeter,
    originId: string,
    delegate: string | undefined,
    stack: Set<string>,
    depth: number,
    callerWritable: boolean,
  ): Promise<JsonValue> {
    if (depth >= 8) {
      throw new ContractError("forbidden", "cross-contract call depth exceeded");
    }
    if (stack.has(targetId)) {
      throw new ContractError("forbidden", "cross-contract call cycle");
    }
    const target = await this.getContractByIdFrom(db, targetId);
    if (!target) {
      throw new ContractError("contract_not_deployed", `no contract ${targetId}`);
    }
    const endpoint = target.manifest.endpoints[endpointName];
    if (!endpoint) {
      throw new ContractError("unknown_endpoint", `unknown endpoint ${endpointName}`);
    }
    if (endpoint.access === "human") {
      throw new ContractError("forbidden", "this endpoint can only be called by a human");
    }
    if (endpoint.access === "roster-lock") {
      throw new ContractError(
        "forbidden",
        "this endpoint can only be called by the roster-lock platform",
      );
    }
    if (endpoint.mutates !== false && !callerWritable) {
      throw new ContractError(
        "forbidden",
        "a read-only call cannot invoke a mutating contract endpoint",
      );
    }
    const inputJson = JSON.stringify(payload);
    if (utf8ByteLength(inputJson) > this.config.maxInputBytes) {
      throw new ContractError("too_large", "cross-contract input is too large");
    }
    if (endpoint.input) {
      const validation = new Validator(endpoint.input, "2020-12").validate(payload);
      if (!validation.valid) {
        const first = validation.errors[0];
        throw new ContractError(
          "invalid_input",
          `input does not match endpoint schema: ${
            first ? `${first.instanceLocation}: ${first.error}` : "invalid"
          }`,
        );
      }
    }

    const targetWritable = endpoint.mutates !== false;
    if (targetWritable) await lockContract(db, target.contractId);
    const nextStack = new Set(stack);
    nextStack.add(targetId);
    const targetContracts = await this.buildContractHandles(db, target, meter);
    const targetSandbox = this.runtime.create({
      db,
      contractId: target.contractId,
      callId: `cross:${caller.contractId}:${target.contractId}`,
      meter,
      config: this.config,
      callerId: `contract:${caller.contractId}`,
      senderId: `contract:${caller.contractId}`,
      originId,
      callerKind: "contract",
      delegate,
      contractName: target.name,
      contracts: targetContracts,
      callContract: (nextId, nextEndpoint, nextPayload) =>
        this.callCrossContract(
          db,
          target,
          nextId,
          nextEndpoint,
          nextPayload,
          meter,
          originId,
          delegate,
          nextStack,
          depth + 1,
          targetWritable,
        ),
      now: this.now,
    });
    try {
      await targetSandbox.load(target.source);
      return await targetSandbox.invoke(endpointName, payload, {
        writable: targetWritable,
      });
    } finally {
      targetSandbox.dispose();
    }
  }

  private async getContractByIdFrom(db: Db, contractId: string): Promise<ContractRecord | undefined> {
    const rows = await db.query<{
      contract_id: string;
      owner_id: string;
      name: string;
      version: string;
      handle: string | null;
      roster_id: string | null;
      init_args: string | null;
      source: string;
      source_hash: string;
      manifest: string;
      created_at: string | number;
      updated_at: string | number;
    }>(`SELECT * FROM dsc_contract WHERE contract_id = $1`, [contractId]);
    const row = rows.rows[0];
    if (!row) return undefined;
    return {
      contractId: row.contract_id,
      ownerId: row.owner_id,
      name: row.name,
      version: row.version,
      handle: row.handle ?? undefined,
      rosterId: row.roster_id ?? undefined,
      source: row.source,
      sourceHash: row.source_hash,
      manifest: JSON.parse(row.manifest) as ContractManifest,
      initArgs: row.init_args === null ? undefined : (JSON.parse(row.init_args) as JsonValue),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private async buildContractHandles(
    db: Db,
    current: ContractRecord,
    meter: GasMeter,
  ): Promise<ContractHandleInfo[]> {
    if (!current.rosterId) return [];
    const rows = await db.query<{
      contract_id: string;
      handle: string | null;
      name: string;
      manifest: string;
    }>(
      `SELECT contract_id, handle, name, manifest
       FROM dsc_contract
       WHERE roster_id = $1 AND contract_id <> $2
       ORDER BY handle ASC`,
      [current.rosterId, current.contractId],
    );
    const handles: ContractHandleInfo[] = [];
    for (const row of rows.rows) {
      const handle = row.handle ?? row.name;
      const storage = await snapshotStorage(
        db,
        row.contract_id,
        JSON.parse(row.manifest) as ContractManifest,
        meter,
        this.config,
        this.now,
      );
      handles.push({ handle, contractId: row.contract_id, storage });
    }
    return handles;
  }

  private async getContractFrom(db: Db): Promise<ContractRecord | undefined> {
    const rows = await db.query<{
      contract_id: string;
      owner_id: string;
      name: string;
      version: string;
      handle: string | null;
      roster_id: string | null;
      init_args: string | null;
      source: string;
      source_hash: string;
      manifest: string;
      created_at: string | number;
      updated_at: string | number;
    }>(`SELECT * FROM dsc_contract WHERE contract_id = $1`, [this.contractId]);
    const row = rows.rows[0];
    if (!row) return undefined;
    const manifest = JSON.parse(row.manifest) as ContractManifest;
    for (const endpoint of Object.values(manifest.endpoints)) {
      if (typeof endpoint.mutates !== "boolean") endpoint.mutates = true;
      // `owner` was removed. Fail closed for a manifest written before that;
      // the old source will also fail to load, but never treat it as public.
      if (
        endpoint.access !== "public" &&
        endpoint.access !== "human" &&
        endpoint.access !== "contract" &&
        endpoint.access !== "roster-lock"
      ) {
        endpoint.access = "contract";
      }
    }
    if (!manifest.events || typeof manifest.events !== "object") {
      manifest.events = {};
    }
    return {
      contractId: row.contract_id,
      ownerId: row.owner_id,
      name: row.name,
      version: row.version,
      handle: row.handle ?? undefined,
      rosterId: row.roster_id ?? undefined,
      source: row.source,
      sourceHash: row.source_hash,
      manifest,
      initArgs:
        row.init_args === null ? undefined : (JSON.parse(row.init_args) as JsonValue),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private async withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const connection = await this.openDb();
    try {
      return await fn(connection.db);
    } finally {
      await connection.close();
    }
  }
}

function mergeConfig(partial: ContractServiceOptions["config"]): ContractConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    gasCosts: { ...DEFAULT_CONFIG.gasCosts, ...partial?.gasCosts },
  };
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractError("invalid_request", `${label} is required`);
  }
}

function asContractError(
  error: unknown,
  code: "analysis_failed" | "execution_failed",
): ContractError {
  if (error instanceof ContractError) return error;
  if (error instanceof QuickJSError) {
    return new ContractError(code, error.message);
  }
  return new ContractError(code, error instanceof Error ? error.message : String(error));
}

/** Serializes every call/deploy for one contract, across isolates. */
async function lockContract(db: Db, contractId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    contractId,
  ]);
}

/**
 * `SET LOCAL`, never `SET`: through Hyperdrive the connection may be a pooled
 * backend shared with another request, so a session setting must not leak.
 */
async function setLocalTimeout(db: Db, hardTimeoutMs: number): Promise<void> {
  await db.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(hardTimeoutMs))}`);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
