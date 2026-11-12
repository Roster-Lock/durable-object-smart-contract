import { beforeEach, describe, expect, it } from "vitest";
import { ContractError } from "../src/errors.js";
import { WalletLedger } from "../src/wallet.js";
import { freshTestDatabase, type TestDatabase } from "@roster-lock/smart-contract-test-client";

const CONTRACT = "contract-a";

let db: TestDatabase;
let now: number;
let ledger: WalletLedger;

beforeEach(async () => {
  db = await freshTestDatabase();
  now = 1_000;
  ledger = new WalletLedger(() => now);
});

function settlement(
  overrides: Partial<Parameters<WalletLedger["settle"]>[1]> = {},
): Parameters<WalletLedger["settle"]>[1] {
  return {
    escrowId: "e1",
    contractId: CONTRACT,
    refund: 0,
    callerId: "alice",
    endpoint: "join",
    status: "ok",
    gasUsed: 100,
    gasCharged: 1,
    error: null,
    ...overrides,
  };
}

describe("WalletLedger", () => {
  it("credits and reports a balance", async () => {
    expect(await ledger.balance(db, "alice")).toBe(0);
    expect(await ledger.credit(db, "alice", 100)).toBe(100);
    expect(await ledger.credit(db, "alice", 25)).toBe(125);
    await expect(ledger.credit(db, "alice", -1)).rejects.toThrow(ContractError);
    await expect(ledger.credit(db, "alice", 1.5)).rejects.toThrow(ContractError);
  });

  it("escrows up front and refuses what the balance cannot cover", async () => {
    await ledger.credit(db, "alice", 100);
    const record = await ledger.escrow(db, CONTRACT, "alice", "e1", 40, 60_000);
    expect(record.expiresAt).toBe(61_000);
    expect(await ledger.balance(db, "alice")).toBe(60);

    await expect(
      ledger.escrow(db, CONTRACT, "alice", "e2", 61, 60_000),
    ).rejects.toThrow(ContractError);
    expect(await ledger.balance(db, "alice")).toBe(60);
    expect(
      (await ledger.escrow(db, CONTRACT, "alice", "e3", 60, 60_000)).amount,
    ).toBe(60);
    expect(await ledger.balance(db, "alice")).toBe(0);
  });

  it("refunds the unused escrow and writes a call log", async () => {
    await ledger.credit(db, "alice", 100);
    await ledger.escrow(db, CONTRACT, "alice", "e1", 40, 60_000);

    await ledger.settle(
      db,
      settlement({ refund: 25, gasUsed: 15, gasCharged: 15 }),
    );
    expect(await ledger.balance(db, "alice")).toBe(85);

    const calls = await db.query<{ status: string; gas_charged: string }>(
      `SELECT status, gas_charged::int AS gas_charged FROM dsc_call_log`,
    );
    expect(calls.rows).toEqual([{ status: "ok", gas_charged: 15 }]);

    await expect(ledger.settle(db, settlement())).rejects.toThrow(ContractError);
  });

  it("never refunds more than the escrow", async () => {
    await ledger.credit(db, "alice", 100);
    await ledger.escrow(db, CONTRACT, "alice", "e1", 40, 60_000);
    await ledger.settle(db, settlement({ refund: 1_000 }));
    expect(await ledger.balance(db, "alice")).toBe(100);
  });

  it("reconciles only this contract's expired escrows", async () => {
    await ledger.credit(db, "alice", 100);
    await ledger.escrow(db, CONTRACT, "alice", "old", 40, 10);
    await ledger.escrow(db, CONTRACT, "alice", "fresh", 20, 10_000);
    await ledger.escrow(db, "contract-b", "alice", "other", 10, 10);
    expect(await ledger.balance(db, "alice")).toBe(30);

    now = 5_000;
    expect(await ledger.reconcile(db, CONTRACT)).toBe(1);
    expect(await ledger.balance(db, "alice")).toBe(70);

    // The other contract's expired escrow is untouched.
    expect(await ledger.reconcile(db, "contract-b")).toBe(1);
    expect(await ledger.balance(db, "alice")).toBe(80);

    // The fresh escrow is still held and can settle normally.
    await ledger.settle(db, settlement({ escrowId: "fresh", refund: 20 }));
    expect(await ledger.balance(db, "alice")).toBe(100);
  });

  it("supports a free call when gas has no price", async () => {
    expect(
      (await ledger.escrow(db, CONTRACT, "nobody", "free", 0, 60_000)).amount,
    ).toBe(0);
    await ledger.settle(
      db,
      settlement({ escrowId: "free", refund: 0, callerId: "nobody" }),
    );
    expect(await ledger.balance(db, "nobody")).toBe(0);
  });
});
