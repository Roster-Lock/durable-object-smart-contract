import { describe, expect, it } from "vitest";
import { GasMeter, gasToCredits } from "../src/gas.js";
import { OutOfGasError } from "../src/errors.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const costs = DEFAULT_CONFIG.gasCosts;

describe("GasMeter", () => {
  it("charges and clamps to the limit", () => {
    const meter = new GasMeter(1_000, costs, { timeoutMs: 1_000_000 });
    meter.charge(400);
    expect(meter.used).toBe(400);
    meter.charge(600);
    expect(meter.used).toBe(1_000);
    expect(meter.exhausted).toBe(true);
    expect(() => meter.charge(1)).toThrow(OutOfGasError);
    expect(meter.burned).toBe(true);
    expect(meter.billed()).toBe(1_000);
  });

  it("counts a tick per interrupt and stops at the limit", () => {
    const meter = new GasMeter(25_000, costs, { timeoutMs: 1_000_000 });
    expect(meter.poll()).toBe(false);
    expect(meter.used).toBe(costs.tick);
    expect(meter.poll()).toBe(false);
    expect(meter.poll()).toBe(true);
    expect(meter.outOfGas).toBe(true);
    expect(meter.billed()).toBe(25_000);
  });

  it("uses wall clock only as a backstop", () => {
    let now = 0;
    const meter = new GasMeter(10_000_000, costs, {
      now: () => now,
      timeoutMs: 100,
    });
    expect(meter.poll()).toBe(false);
    now = 500;
    expect(meter.poll()).toBe(true);
    expect(meter.timedOut).toBe(true);
    expect(meter.burned).toBe(true);
  });

  it("converts gas to whole credits, rounding up", () => {
    expect(gasToCredits(0, 1000)).toBe(0);
    expect(gasToCredits(1, 1000)).toBe(1);
    expect(gasToCredits(1_000_000, 1)).toBe(1);
    expect(gasToCredits(1, 1)).toBe(1);
    expect(gasToCredits(2_500_000, 1)).toBe(3);
  });
});
