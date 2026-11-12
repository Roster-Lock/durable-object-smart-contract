import { PGlite } from "@electric-sql/pglite";
import {
  ContractService,
  type ContractConfig,
  type ContractServiceOptions,
  type Db,
  type QueryResult,
  type SqlValue,
} from "@roster-lock/smart-contract";

export interface LocalRosterOptions {
  contractId?: string;
  config?: ContractServiceOptions["config"];
  now?: () => number;
}

export interface LocalRoster {
  service: ContractService;
  db: Db;
  close(): Promise<void>;
}

/**
 * Run a living-roster contract against an in-process Postgres (PGlite).
 * Intended for local tests and the dev CLI; production uses Hyperdrive.
 */
export async function createLocalRoster(
  options: LocalRosterOptions = {},
): Promise<LocalRoster> {
  const pg = new PGlite();
  const db: Db = {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: readonly SqlValue[],
    ): Promise<QueryResult<T>> {
      const result = await pg.query(text, params ? [...params] : undefined);
      return {
        rows: result.rows as T[],
        rowCount: result.affectedRows ?? 0,
      };
    },
  };
  const service = new ContractService({
    contractId: options.contractId ?? "local-contract",
    openDb: async () => ({ db, close: async () => {} }),
    config: options.config as ContractConfig | undefined,
    now: options.now,
  });
  await service.initialize();
  return {
    service,
    db,
    close: async () => {
      await pg.close();
    },
  };
}
