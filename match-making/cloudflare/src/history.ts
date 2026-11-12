import type { Db, OpenDb, SqlValue } from "@roster-lock/smart-contract";
import type { MatchHistoryEntry, MatchResult } from "@roster-lock/match-making";

export interface MatchHistoryQuery {
  rosterId: string;
  /** Only matches that include this player. */
  userId?: string;
  limit?: number;
  beforeFinishedAt?: number;
}

export async function listMatchHistory(
  openDb: OpenDb,
  query: MatchHistoryQuery,
): Promise<MatchHistoryEntry[]> {
  const connection = await openDb();
  try {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 500);
    const params: SqlValue[] = [query.rosterId, limit];
    let where = "roster_id = $1";
    if (query.userId !== undefined) {
      params.push(query.userId);
      where += ` AND $${params.length} = ANY(participants)`;
    }
    if (query.beforeFinishedAt !== undefined) {
      params.push(query.beforeFinishedAt);
      where += ` AND finished_at < $${params.length}`;
    }
    const rows = await connection.db.query<{
      id: string;
      roster_id: string;
      deployment_id: string | null;
      finished_at: string | number;
      participants: string[];
      result: string;
    }>(
      `SELECT id, roster_id, deployment_id, finished_at, participants, result
       FROM dsc_match_history
       WHERE ${where}
       ORDER BY finished_at DESC
       LIMIT $2`,
      params,
    );
    return rows.rows.map((row) => ({
      matchId: row.id,
      rosterId: row.roster_id,
      deploymentId: row.deployment_id ?? undefined,
      finishedAt: Number(row.finished_at),
      participants: row.participants,
      result: JSON.parse(row.result) as MatchResult,
    }));
  } finally {
    await connection.close();
  }
}

export async function recordMatchHistory(
  db: Db,
  input: {
    rosterId: string;
    deploymentId?: string;
    finishedAt: number;
    result: MatchResult;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO dsc_match_history
       (id, roster_id, deployment_id, finished_at, participants, result)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.result.matchId,
      input.rosterId,
      input.deploymentId ?? null,
      input.finishedAt,
      input.result.players,
      JSON.stringify(input.result),
    ],
  );
}
