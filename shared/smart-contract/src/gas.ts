import { OutOfGasError } from "./errors.js";
import type { GasCosts } from "./types.js";

/**
 * Deterministic gas accounting for one call.
 *
 * Gas is charged from two places:
 *
 * 1. The QuickJS interrupt handler, on every poll. QuickJS polls every
 *    `INTERRUPT_COUNTER_INIT` bytecode instructions, so one tick is a fixed
 *    unit of interpreter work - the same source always costs the same ticks on
 *    the same QuickJS build.
 * 2. Host functions, which charge for the SQL work they perform.
 *
 * Wall-clock time is only a backstop for the platform, never the primary
 * meter: a timeout is treated exactly like running out of gas.
 */
export class GasMeter {
  private readonly limit: number;
  private readonly costs: GasCosts;
  private readonly startedAt: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private usedGas = 0;

  /** The guest was stopped by the interrupt handler. */
  outOfGas = false;
  /** The platform backstop fired; billed and refunded like running out of gas. */
  timedOut = false;

  constructor(
    limit: number,
    costs: GasCosts,
    options: { now?: () => number; timeoutMs?: number } = {},
  ) {
    this.limit = Math.max(0, Math.floor(limit));
    this.costs = costs;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.timeoutMs = options.timeoutMs ?? 1_000;
  }

  get max(): number {
    return this.limit;
  }

  get used(): number {
    return Math.min(this.usedGas, this.limit);
  }

  get exhausted(): boolean {
    return this.outOfGas || this.timedOut || this.usedGas >= this.limit;
  }

  /** True when the call failed because it ran out of gas (no refund). */
  get burned(): boolean {
    return this.outOfGas || this.timedOut;
  }

  /**
   * Charge gas or abort. Called from host functions; the throw becomes a guest
   * exception, and the interrupt handler is what guarantees the guest cannot
   * simply catch it and carry on.
   */
  charge(amount: number): void {
    if (amount <= 0) return;
    if (this.outOfGas || this.timedOut) throw new OutOfGasError();
    this.usedGas += amount;
    if (this.usedGas > this.limit) {
      this.outOfGas = true;
      throw new OutOfGasError();
    }
  }

  /**
   * Called by the QuickJS interrupt handler. Must not throw across the WASM
   * boundary; returning true tells QuickJS to abort with an interrupt.
   */
  poll(now = this.now()): boolean {
    if (this.outOfGas || this.timedOut) return true;
    // Keep one tick of headroom so that a charge at the boundary is reported
    // as out of gas rather than a silent overshoot.
    this.usedGas = Math.min(this.usedGas + this.costs.tick, this.limit + this.costs.tick);
    if (this.usedGas > this.limit) {
      this.outOfGas = true;
      return true;
    }
    if (now - this.startedAt > this.timeoutMs) {
      this.timedOut = true;
      return true;
    }
    return false;
  }

  /**
   * Checked between awaited host calls. The interrupt handler covers guest
   * bytecode; this covers a call that spends its time waiting on Postgres.
   */
  checkDeadline(): void {
    if (this.outOfGas || this.timedOut) throw new OutOfGasError();
    if (this.now() - this.startedAt > this.timeoutMs) {
      this.timedOut = true;
      throw new OutOfGasError("the call exceeded its wall-clock budget");
    }
  }

  /** Gas the caller pays for, clamped to the limit they escrowed. */
  billed(): number {
    return Math.min(this.usedGas, this.limit);
  }
}

/**
 * Convert gas to whole credits. Two calls and an integer ledger, so rounding
 * always goes up and a call never costs a fraction of a credit.
 */
export function gasToCredits(gas: number, pricePerMillion: number): number {
  if (gas <= 0 || pricePerMillion <= 0) return 0;
  return Math.ceil((gas * pricePerMillion) / 1_000_000);
}
