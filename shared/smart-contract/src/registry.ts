import type { Db, SqlValue } from "./sql/driver.js";

/**
 * A row in the shared contract registry. Every contract lives in its own
 * Durable Object, but the `dsc_contract` table is the discoverable index: the
 * website can list the contracts deployed for a roster or an owner without
 * calling any of them.
 */
export interface ContractSummary {
  contractId: string;
  ownerId: string;
  name: string;
  version: string;
  handle?: string;
  rosterId?: string;
  sourceHash: string;
  updatedAt: number;
}

export interface ContractFilter {
  ownerId?: string;
  rosterId?: string;
  limit?: number;
}

export async function listContracts(
  db: Db,
  filter: ContractFilter = {},
): Promise<ContractSummary[]> {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (filter.ownerId !== undefined) {
    params.push(filter.ownerId);
    clauses.push(`owner_id = $${params.length}`);
  }
  if (filter.rosterId !== undefined) {
    params.push(filter.rosterId);
    clauses.push(`roster_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 50), 1), 500);
  params.push(limit);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db.query<{
    contract_id: string;
    owner_id: string;
    name: string;
    version: string;
    handle: string | null;
    roster_id: string | null;
    source_hash: string;
    updated_at: string | number;
  }>(
    `SELECT contract_id, owner_id, name, version, handle, roster_id, source_hash, updated_at
     FROM dsc_contract ${where}
     ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );

  return rows.rows.map((row) => ({
    contractId: row.contract_id,
    ownerId: row.owner_id,
    name: row.name,
    version: row.version,
    handle: row.handle ?? undefined,
    rosterId: row.roster_id ?? undefined,
    sourceHash: row.source_hash,
    updatedAt: Number(row.updated_at),
  }));
}
