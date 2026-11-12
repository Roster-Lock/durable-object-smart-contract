import {
  DEFAULT_CONFIG,
  GasMeter,
  Sandbox,
  SandboxRuntime,
  transaction,
  type ContractConfig,
  type Db,
  type OpenDb,
} from "@roster-lock/smart-contract";
import { validateJavaScript } from "@roster-lock/smart-contract/validator";
import { recordMatchHistory } from "./history.js";
import type {
  MatchResult,
  MatchmakingPlan,
  MatchmakerStorageSnapshot,
  QueuedPlayer,
  StorageConfig,
  UserId,
} from "@roster-lock/match-making";

export interface MatchmakerRunnerOptions {
  openDb: OpenDb;
  config?: Partial<ContractConfig>;
  runtime?: SandboxRuntime;
  now?: () => number;
}

export interface MatchmakerCallBase {
  rosterId: string;
  /** Stable id for a selected matchmaker version; scopes the storage. */
  deploymentId?: string;
  source: string;
  now?: number;
  random?: number;
  queue?: QueuedPlayer[];
  cooldownMs?: number;
  maxWaitMs?: number;
  /** Previous matchmaker storage when updating a deployment. */
  previous?: {
    storage: StorageConfig;
    data: MatchmakerStorageSnapshot;
  };
}

export interface HandleMatchInput extends MatchmakerCallBase {
  result: MatchResult;
}

export interface FindPlayersInput extends MatchmakerCallBase {
  pool: QueuedPlayer[];
}

/**
 * Runs matchmaker code in the contract sandbox.
 *
 * The matchmaker is wrapped in a synthetic contract whose endpoints call
 * `handleMatchResult` and `findOtherPlayers`. That reuses the declared storage
 * classes, gas meter, QuickJS bridge and Postgres transaction instead of
 * maintaining a second runtime.
 */
export class MatchmakerRunner {
  private readonly openDb: OpenDb;
  private readonly config: ContractConfig;
  private readonly runtime: SandboxRuntime;
  private readonly now: () => number;

  constructor(options: MatchmakerRunnerOptions) {
    this.openDb = options.openDb;
    this.config = mergeConfig(options.config);
    this.runtime = options.runtime ?? new SandboxRuntime();
    this.now = options.now ?? Date.now;
  }

  async handleMatchResult(input: HandleMatchInput): Promise<void> {
    const finishedAt = input.now ?? this.now();
    await this.execute(
      input,
      "__matchmaker_handle",
      {
        result: input.result,
        now: finishedAt,
        random: input.random ?? Math.random(),
        queue: input.queue ?? [],
        cooldownMs: input.cooldownMs ?? 0,
        maxWaitMs: input.maxWaitMs ?? 300_000,
      },
      true,
      (tx) =>
        recordMatchHistory(tx, {
          rosterId: input.rosterId,
          deploymentId: input.deploymentId,
          finishedAt,
          result: input.result,
        }),
    );
  }

  /** Run the one-time init hook for a fresh deployment namespace. */
  async initialize(input: MatchmakerCallBase): Promise<void> {
    await this.execute(
      input,
      "__matchmaker_init",
      {
        now: input.now ?? this.now(),
        random: input.random ?? Math.random(),
        queue: input.queue ?? [],
        cooldownMs: input.cooldownMs ?? 0,
        maxWaitMs: input.maxWaitMs ?? 300_000,
        previous: input.previous,
      },
      true,
    );
  }

  async findOtherPlayers(input: FindPlayersInput): Promise<MatchmakingPlan> {
    const result = await this.execute(
      input,
      "__matchmaker_find",
      {
        pool: input.pool,
        now: input.now ?? this.now(),
        random: input.random ?? Math.random(),
        queue: input.pool,
        cooldownMs: input.cooldownMs ?? 0,
        maxWaitMs: input.maxWaitMs ?? 300_000,
      },
      false,
    );
    const plan = result as MatchmakingPlan;
    if (!plan || !Array.isArray(plan.matches)) {
      throw new Error("findOtherPlayers must return { matches: UserId[][] }");
    }
    return {
      matches: plan.matches.map((group) => group.map(String)),
      timedOut: (plan.timedOut ?? []).map(String),
    };
  }

  private async execute(
    input: MatchmakerCallBase,
    endpoint: string,
    payload: Record<string, unknown>,
    writable: boolean,
    after?: (tx: Db) => Promise<void>,
  ): Promise<unknown> {
    const validation = validateJavaScript(input.source, { mode: "bundle" });
    if (!validation.ok) {
      throw new Error(
        `matchmaker source is not valid: ${validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.code} ${issue.message}`)
          .join("; ")}`,
      );
    }
    await this.runtime.ready();
    const namespace = `matchmaker:${input.rosterId}:${input.deploymentId ?? "default"}`;
    const source = syntheticSource(input.source);
    const connection = await this.openDb();
    try {
      return await transaction(connection.db, async (tx) => {
        await tx.query(
          `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(this.config.hardTimeoutMs))}`,
        );
        const meter = new GasMeter(this.config.maxGasPerCall, this.config.gasCosts, {
          now: this.now,
          timeoutMs: this.config.hardTimeoutMs,
        });
        const sandbox = this.runtime.create({
          db: tx,
          contractId: namespace,
          callId: crypto.randomUUID(),
          meter,
          config: this.config,
          callerId: "matchmaker",
          senderId: "matchmaker",
          originId: "matchmaker",
          callerKind: "human",
          contractName: "matchmaker",
          readOnly: false,
          now: this.now,
        });
        try {
          await sandbox.load(source);
          const result = await sandbox.invoke(endpoint, payload as never, { writable });
          if (after) await after(tx);
          return result;
        } finally {
          sandbox.dispose();
        }
      });
    } finally {
      await connection.close();
    }
  }
}

function syntheticSource(source: string): string {
  return `
    globalThis.defineMatchmaker = function (definition) {
      if (globalThis.__ds_matchmaker) {
        throw new Error("defineMatchmaker may only be called once");
      }
      if (!definition || typeof definition !== "object") {
        throw new TypeError("defineMatchmaker expects an object");
      }
      globalThis.__ds_matchmaker = definition;
    };

    ${source}

    (function () {
      var def = globalThis.__ds_matchmaker;
      if (!def) throw new Error("the matchmaker must call defineMatchmaker({ ... })");
      if (typeof def.handleMatchResult !== "function") {
        throw new Error("matchmaker.handleMatchResult must be a function");
      }
      if (typeof def.findOtherPlayers !== "function") {
        throw new Error("matchmaker.findOtherPlayers must be a function");
      }
      function transformNode(node, name) {
        if (!node || typeof node !== "object") {
          throw new Error("storage." + name + " must be an object");
        }
        if (node.kind === "map") {
          return {
            kind: "map",
            key: node.key,
            value: transformNode(node.value, name + ".value"),
          };
        }
        if (node.kind === "array") {
          return {
            kind: "array",
            item: transformNode(node.value, name + ".value"),
          };
        }
        if (node.kind === "value") {
          return {
            kind: "value",
            schema: node.schema,
            validateReads: node.validateReads,
          };
        }
        throw new Error("storage." + name + ".kind must be map, array or value");
      }

      function matchmakerStorage(config) {
        var out = {};
        if (!config) return out;
        for (var name in config) {
          out[name] = transformNode(config[name], name);
        }
        return out;
      }

      class PreviousValue {
        constructor(value) { this.value = value; }
        async get() { return this.value; }
        async set() { throw new Error("previous storage is read-only"); }
        async delete() { throw new Error("previous storage is read-only"); }
      }
      function childPrevious(node, value) {
        if (!node) return value;
        if (node.kind === "value") return value;
        if (node.kind === "map") return new PreviousMap(node.value, value || {});
        if (node.kind === "array") return new PreviousArray(node.value, value || []);
        throw new Error("invalid previous storage node");
      }
      class PreviousMap {
        constructor(valueNode, data) {
          this.valueNode = valueNode;
          this.data = data || {};
        }
        async get(key) { return childPrevious(this.valueNode, this.data[key]); }
        async has(key) {
          return Object.prototype.hasOwnProperty.call(this.data, key);
        }
        async keys() { return Object.keys(this.data); }
        async entries() {
          var self = this;
          return Object.keys(this.data).map(function (key) {
            return [key, childPrevious(self.valueNode, self.data[key])];
          });
        }
        async size() { return Object.keys(this.data).length; }
        async set() { throw new Error("previous storage is read-only"); }
        async delete() { throw new Error("previous storage is read-only"); }
      }
      class PreviousArray {
        constructor(valueNode, data) {
          this.valueNode = valueNode;
          this.data = data || [];
        }
        async get(index) {
          return childPrevious(this.valueNode, this.data[index]);
        }
        async slice(start, count) {
          var out = [];
          for (var i = start; i < start + count && i < this.data.length; i++) {
            out.push(childPrevious(this.valueNode, this.data[i]));
          }
          return out;
        }
        async length() { return this.data.length; }
        async set() { throw new Error("previous storage is read-only"); }
        async insert() { throw new Error("previous storage is read-only"); }
        async removeAt() { throw new Error("previous storage is read-only"); }
      }
      function makePreviousStorage(config, data) {
        if (!config) return undefined;
        var out = {};
        for (var name in config) {
          var node = config[name];
          if (node.kind === "map") {
            out[name] = new PreviousMap(node.value, data ? data[name] : undefined);
          } else if (node.kind === "array") {
            out[name] = new PreviousArray(node.value, data ? data[name] : undefined);
          } else if (node.kind === "value") {
            out[name] = new PreviousValue(data ? data[name] : undefined);
          } else {
            throw new Error("previous storage." + name + " has an invalid kind");
          }
        }
        return out;
      }

      function makeContext(ctx, input) {
        return {
          storage: ctx.storage,
          now: function () { return input.now; },
          random: function () { return input.random; },
          queue: function () { return Promise.resolve(input.queue || []); },
          cooldownMs: input.cooldownMs || 0,
          maxWaitMs: input.maxWaitMs || 300000,
        };
      }
      defineContract({
        name: def.name || "matchmaker",
        version: def.version || "0",
        storage: matchmakerStorage(def.storage),
        endpoints: {
          __matchmaker_init: {
            run: async function (input, ctx) {
              if (typeof def.init !== "function") return null;
              var previous = input.previous
                ? makePreviousStorage(input.previous.storage, input.previous.data)
                : undefined;
              var result = await def.init(makeContext(ctx, input), previous);
              return result === undefined ? null : result;
            },
          },
          __matchmaker_handle: {
            run: async function (input, ctx) {
              var result = await def.handleMatchResult(input.result, makeContext(ctx, input));
              return result === undefined ? null : result;
            },
          },
          __matchmaker_find: {
            run: async function (input, ctx) {
              return await def.findOtherPlayers(input.pool, makeContext(ctx, input));
            },
          },
        },
      });
    })();
  `;
}

function mergeConfig(overrides: Partial<ContractConfig> | undefined): ContractConfig {
  if (!overrides) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    gasCosts: { ...DEFAULT_CONFIG.gasCosts, ...overrides.gasCosts },
  };
}
