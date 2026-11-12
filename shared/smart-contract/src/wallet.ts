import { ContractError } from "./errors.js";
import type { Db } from "./sql/driver.js";
import { transaction } from "./sql/driver.js";

export interface EscrowRecord {
  id: string;
  contractId: string;
  userId: string;
  amount: number;
  createdAt: number;
  expiresAt: number;
}

export interface Settlement {
  escrowId: string;
  contractId: string;
  /** Credits returned to the caller (0 when the call ran out of gas). */
  refund: number;
  callerId: string;
  endpoint: string;
  status: "ok" | "error" | "out_of_gas";
  gasUsed: number;
  gasCharged: number;
  error: string | null;
  /** Third-party app id acting for the caller; audit only. */
  delegate?: string;
}

/**
 * Integer credit ledger plus the gas escrow that makes a call safe to run.
 *
 * The flow is deliberately two transactions:
 *
 *   1. escrow     - deduct the maximum possible cost before any guest code runs
 *   2. settlement - refund the unused gas after the state transaction commits
 *                   or rolls back
 *
 * Both are short transactions on the call's connection. The state transaction
 * in between is held open by `ContractService.call`.
 *
 * If the process dies between them, the escrow row survives. `reconcile`
 * refunds escrows past their TTL (with `FOR UPDATE SKIP LOCKED`, so two
 * reconcilers cannot refund the same row twice), so a crash cannot silently
 * keep a caller's money.
 *
 * The wallet is global per user, shared by every contract in the database.
 */
export class WalletLedger {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly statementTimeoutMs = 1_000,
  ) {}

  /**
   * `SET LOCAL`, never `SET`: the connection may be a pooled Hyperdrive
   * backend, so a session setting could leak into another request.
   */
  private async bound(tx: Db): Promise<void> {
    await tx.query(
      `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(this.statementTimeoutMs))}`,
    );
  }

  async balance(db: Db, userId: string): Promise<number> {
    this.assertUser(userId);
    const row = await db.query<{ balance: string | number }>(
      `SELECT balance FROM dsc_wallet WHERE user_id = $1`,
      [userId],
    );
    return Number(row.rows[0]?.balance ?? 0);
  }

  /** Add credits. In production this is called from a signed payment webhook. */
  async credit(db: Db, userId: string, amount: number): Promise<number> {
    this.assertUser(userId);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ContractError("invalid_request", "credit amount must be a positive integer");
    }
    await db.query(
      `INSERT INTO dsc_wallet (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = dsc_wallet.balance + EXCLUDED.balance`,
      [userId, amount],
    );
    return this.balance(db, userId);
  }

  /**
   * Deduct the maximum cost up front. Throws without touching the balance if
   * the caller cannot cover it.
   */
  async escrow(
    db: Db,
    contractId: string,
    userId: string,
    escrowId: string,
    amount: number,
    ttlMs: number,
  ): Promise<EscrowRecord> {
    this.assertUser(userId);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new ContractError("invalid_request", "escrow amount must be a non-negative integer");
    }
    const createdAt = this.now();
    const expiresAt = createdAt + ttlMs;

    await transaction(db, async (tx) => {
      await this.bound(tx);
      if (amount > 0) {
        const stats = await tx.query(
          `UPDATE dsc_wallet SET balance = balance - $1
           WHERE user_id = $2 AND balance >= $1`,
          [amount, userId],
        );
        if (stats.rowCount !== 1) {
          const balance = await this.balance(tx, userId);
          throw new ContractError(
            "insufficient_funds",
            `this call needs ${amount} credits of gas escrow, balance is ${balance}`,
          );
        }
      }
      await tx.query(
        `INSERT INTO dsc_gas_escrow
           (id, contract_id, user_id, amount, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [escrowId, contractId, userId, amount, createdAt, expiresAt],
      );
    });

    return { id: escrowId, contractId, userId, amount, createdAt, expiresAt };
  }

  /** Refund the unused escrow and write the call log, in one transaction. */
  async settle(db: Db, settlement: Settlement): Promise<void> {
    await transaction(db, async (tx) => {
      await this.bound(tx);
      const escrow = await tx.query<{ user_id: string; amount: string | number }>(
        `SELECT user_id, amount FROM dsc_gas_escrow
         WHERE id = $1 AND contract_id = $2
         FOR UPDATE`,
        [settlement.escrowId, settlement.contractId],
      );
      if (escrow.rows.length === 0) {
        throw new ContractError(
          "invalid_request",
          "escrow is missing; it may have already been reconciled",
        );
      }

      const held = Number(escrow.rows[0].amount);
      const refund = Math.max(0, Math.min(Math.floor(settlement.refund), held));
      if (refund > 0) {
        await tx.query(
          `UPDATE dsc_wallet SET balance = balance + $1 WHERE user_id = $2`,
          [refund, escrow.rows[0].user_id],
        );
      }
      await tx.query(`DELETE FROM dsc_gas_escrow WHERE id = $1`, [settlement.escrowId]);
      await tx.query(
        `INSERT INTO dsc_call_log
           (id, contract_id, caller_id, endpoint, status, gas_used, gas_charged, error, created_at, delegate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          settlement.escrowId,
          settlement.contractId,
          settlement.callerId,
          settlement.endpoint,
          settlement.status,
          Math.max(0, Math.floor(settlement.gasUsed)),
          Math.max(0, Math.floor(settlement.gasCharged)),
          settlement.error,
          this.now(),
          settlement.delegate ?? null,
        ],
      );
    });
  }

  /**
   * Refund escrows that outlived their TTL, which can only happen if the
   * process died mid-call. The contract state transaction is atomic, so no
   * state change survived and the full escrow is returned.
   */
  async reconcile(db: Db, contractId: string): Promise<number> {
    const now = this.now();
    return transaction(db, async (tx) => {
      await this.bound(tx);
      const stale = await tx.query<{
        id: string;
        user_id: string;
        amount: string | number;
      }>(
        `SELECT id, user_id, amount FROM dsc_gas_escrow
         WHERE contract_id = $1 AND expires_at <= $2
         FOR UPDATE SKIP LOCKED`,
        [contractId, now],
      );
      for (const escrow of stale.rows) {
        await tx.query(
          `UPDATE dsc_wallet SET balance = balance + $1 WHERE user_id = $2`,
          [Number(escrow.amount), escrow.user_id],
        );
        await tx.query(`DELETE FROM dsc_gas_escrow WHERE id = $1`, [escrow.id]);
      }
      return stale.rows.length;
    });
  }

  private assertUser(userId: string): void {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new ContractError("invalid_request", "userId is required");
    }
  }
}
