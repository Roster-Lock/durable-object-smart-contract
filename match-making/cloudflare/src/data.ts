import { transaction, type Db } from "@roster-lock/smart-contract";

/**
 * Delete all declared-storage rows for a matchmaker namespace.
 * The namespace is the matchmaker's contract id (e.g. `matchmaker:r1:commit`).
 */
export async function clearMatchmakerData(db: Db, namespace: string): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(`DELETE FROM dsc_state_value WHERE contract_id = $1`, [namespace]);
    await tx.query(`DELETE FROM dsc_state_map WHERE contract_id = $1`, [namespace]);
    await tx.query(`DELETE FROM dsc_state_array WHERE contract_id = $1`, [namespace]);
    await tx.query(`DELETE FROM dsc_state_size WHERE contract_id = $1`, [namespace]);
  });
}
