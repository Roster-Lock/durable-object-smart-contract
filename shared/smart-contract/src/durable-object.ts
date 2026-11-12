import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten";
import { ContractError } from "./errors.js";
import { ContractService } from "./contract.js";
import type { ContractServiceOptions } from "./contract.js";
import { SandboxRuntime } from "./runtime/sandbox.js";
import type { OpenDb } from "./sql/driver.js";
import { openPostgres } from "./sql/postgres.js";

export interface SmartContractEnv {
  /** Cloudflare Hyperdrive binding pointing at the website's Postgres. */
  HYPERDRIVE?: { connectionString: string };
  /** Optional default roster for contracts deployed through this object. */
  ROSTER_ID?: string;
  /**
   * Optional shared secret checked against `x-dsc-secret`. Leave it unset in
   * local dev; set it in production so only the front Worker can reach the
   * Durable Object.
   */
  SMART_CONTRACT_SECRET?: string;
  /**
   * `[[wasm_modules]]` binding for the QuickJS wasm, e.g.
   * `binding = "QUICKJS_WASM"`. workerd cannot fetch the package's wasm from a
   * relative URL, so production must pass the compiled module in.
   */
  QUICKJS_WASM?: WebAssembly.Module;
  /** JSON overrides for `ContractConfig`, e.g. gas prices per environment. */
  CONTRACT_CONFIG?: string;
}

/** Test seam: a Durable Object is otherwise constructed by the runtime. */
export interface SmartContractOptions {
  openDb?: OpenDb;
  contractId?: string;
}

/**
 * One Durable Object instance per contract.
 *
 * The object no longer owns the data - Postgres does - but it still owns the
 * execution. Two things serialise a call:
 *
 *   1. `blockConcurrencyWhile` keeps this object to one request at a time,
 *      which matters now that the call awaits Postgres.
 *   2. `pg_advisory_xact_lock` inside the state transaction makes that true
 *      even if two isolates ever ran the same contract id.
 *
 * Authentication of `callerId` / `ownerId` belongs to the Worker in front of
 * this object; the DO trusts those fields only after the shared secret check.
 */
export class SmartContractDurableObject implements DurableObject {
  private readonly service: ContractService;
  private readonly secret: string | undefined;
  private readonly state: DurableObjectState;

  constructor(
    state: DurableObjectState,
    env: SmartContractEnv,
    options: SmartContractOptions = {},
  ) {
    this.state = state;
    this.secret = env.SMART_CONTRACT_SECRET;

    const contractId = options.contractId ?? state.id.name ?? state.id.toString();
    const openDb =
      options.openDb ??
      (() => {
        if (!env.HYPERDRIVE) {
          throw new Error("HYPERDRIVE binding is required");
        }
        return openPostgres(env.HYPERDRIVE.connectionString);
      });

    const runtime = env.QUICKJS_WASM
      ? new SandboxRuntime(() =>
          newQuickJSWASMModuleFromVariant(
            newVariant(RELEASE_SYNC, { wasmModule: env.QUICKJS_WASM! }),
          ),
        )
      : undefined;

    this.service = new ContractService({
      contractId,
      rosterId: env.ROSTER_ID,
      openDb,
      config: parseConfig(env.CONTRACT_CONFIG),
      runtime,
    });

    state.blockConcurrencyWhile(async () => {
      await this.service.initialize();
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (this.secret && request.headers.get("x-dsc-secret") !== this.secret) {
        throw new ContractError("forbidden", "invalid shared secret");
      }
      // One request at a time: the call awaits Postgres, so without this two
      // requests could interleave between the escrow and the state transaction.
      return await this.state.blockConcurrencyWhile(() => this.route(request));
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "POST" && path === "/deploy/preview") {
      const body = await readJson<{
        ownerId: string;
        name: string;
        source: string;
      }>(request);
      const result = await this.service.preview({
        ownerId: body.ownerId,
        name: body.name,
        source: body.source,
      });
      return json(result, 200);
    }

    if (method === "POST" && path === "/deploy") {
      const body = await readJson<{
        ownerId: string;
        name: string;
        version?: string;
        contractId?: string;
        rosterId?: string;
        initArgs?: unknown;
        source: string;
      }>(request);
      const result = await this.service.deploy({
        ownerId: body.ownerId,
        name: body.name,
        contractId: body.contractId,
        initArgs: body.initArgs as never,
        source: body.source,
      });
      return json(result, 200);
    }

    if (method === "GET" && path === "/contracts") {
      const rosterId = url.searchParams.get("rosterId") ?? undefined;
      const ownerId = url.searchParams.get("ownerId") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return json(
        {
          contracts: await this.service.listContracts({
            rosterId,
            ownerId,
            limit: Number.isFinite(limit) ? limit : 50,
          }),
        },
        200,
      );
    }

    if (method === "GET" && path === "/events") {
      const after = url.searchParams.get("after") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const names = url.searchParams.getAll("event");
      return json(
        {
          events: await this.service.listEvents(
            after,
            Number.isFinite(limit) ? limit : 100,
            names.length > 0 ? names : undefined,
          ),
        },
        200,
      );
    }

    if (method === "POST" && path.startsWith("/platform/call/")) {
      // Platform-originated calls (match reports, scheduled jobs). This route
      // is disabled unless a shared secret is configured; the normal call route
      // can never set the roster-lock caller kind.
      if (!this.secret) {
        throw new ContractError("forbidden", "platform calls are disabled");
      }
      const endpoint = decodeURIComponent(path.slice("/platform/call/".length));
      const body = await readJson<{ input?: unknown }>(request);
      const record = await this.service.getContract();
      if (!record) {
        throw new ContractError("contract_not_deployed", "no contract has been deployed");
      }
      const result = await this.service.call({
        callerId: record.ownerId,
        endpoint,
        input: body.input as never,
        callerKind: "roster-lock",
        senderId: "roster-lock",
      });
      return json(result, 200);
    }

    if (method === "POST" && path.startsWith("/call/")) {
      const endpoint = decodeURIComponent(path.slice("/call/".length));
      const body = await readJson<{ callerId: string; input?: unknown }>(request);
      const result = await this.service.call({
        callerId: body.callerId,
        endpoint,
        input: body.input as never,
      });
      return json(result, 200);
    }

    if (method === "GET" && path === "/contract") {
      const record = await this.service.getContract();
      if (!record) return json({ deployed: false }, 200);
      return json(
        {
          deployed: true,
          contract: {
            contractId: record.contractId,
            ownerId: record.ownerId,
            name: record.name,
            version: record.version,
            rosterId: record.rosterId,
            sourceHash: record.sourceHash,
            manifest: record.manifest,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        },
        200,
      );
    }

    if (method === "GET" && path === "/calls") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return json(
        { calls: await this.service.listCalls(Number.isFinite(limit) ? limit : 50) },
        200,
      );
    }

    if (method === "GET" && path === "/wallet") {
      const userId = url.searchParams.get("userId");
      if (!userId) throw new ContractError("invalid_request", "userId is required");
      return json({ userId, balance: await this.service.balance(userId) }, 200);
    }

    if (method === "POST" && path === "/wallet/credit") {
      const body = await readJson<{ userId: string; amount: number }>(request);
      return json(
        { userId: body.userId, balance: await this.service.credit(body.userId, body.amount) },
        200,
      );
    }

    if (method === "POST" && path === "/reconcile") {
      return json({ refunded: await this.service.reconcile() }, 200);
    }

    throw new ContractError("invalid_request", `no route for ${method} ${path}`);
  }
}

function parseConfig(
  value: string | undefined,
): ContractServiceOptions["config"] | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as ContractServiceOptions["config"];
  } catch {
    throw new Error("CONTRACT_CONFIG is not valid JSON");
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ContractError("invalid_request", "request body must be JSON");
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  invalid_request: 400,
  analysis_failed: 422,
  contract_not_deployed: 404,
  unknown_endpoint: 404,
  forbidden: 403,
  invalid_input: 400,
  insufficient_funds: 402,
  out_of_gas: 400,
  execution_failed: 422,
  contract_changed: 409,
  schema_changed: 409,
  too_large: 413,
};

function errorResponse(error: unknown): Response {
  if (error instanceof ContractError) {
    return json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          issues: error.issues,
        },
      },
      STATUS_BY_CODE[error.code] ?? 500,
    );
  }
  return json(
    {
      ok: false,
      error: {
        code: "internal",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    500,
  );
}
