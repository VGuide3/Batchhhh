import { describe, expect, it } from "vitest";
import {
  DEFAULT_GAS_CAP,
  REFERENCE_TOTAL_GAS,
  effectiveGasPrice,
  enforceGasCeiling,
  feeGuardOk,
  predictGas,
} from "../../src/gas/budget.js";
import { GasCeilingError } from "../../src/errors.js";

describe("gas budget", () => {
  it("reproduces the reference total within the documented model", () => {
    const p = predictGas({ authorizationCount: 7, calldataLength: 1156, recordCount: 14 });
    // 21000 + 87500 + 18496 + 383680 = 510676 exactly when execution is the reference.
    const exact = predictGas({
      authorizationCount: 7,
      calldataLength: 1156,
      recordCount: 14,
      executionGas: 383_680n,
    });
    expect(exact.total).toBe(REFERENCE_TOTAL_GAS);
    expect(p.authorizationIntrinsic).toBe(87_500n);
    expect(p.calldataIntrinsic).toBe(18_496n);
    expect(p.txBase).toBe(21_000n);
    // Per-transfer budget ≈ 27406.
    expect(p.perTransfer).toBe(27_405n);
  });

  it("enforces the hard gas cap", () => {
    expect(() => enforceGasCeiling(700_000n, 510_676n, DEFAULT_GAS_CAP)).toThrow(GasCeilingError);
    expect(() => enforceGasCeiling(500_000n, 510_676n, DEFAULT_GAS_CAP)).not.toThrow();
  });

  it("enforces the 1.15× simulation slack", () => {
    // 1.15 × 400000 = 460000; 470000 exceeds it.
    expect(() => enforceGasCeiling(470_000n, 400_000n, 1_000_000n)).toThrow(GasCeilingError);
    expect(() => enforceGasCeiling(450_000n, 400_000n, 1_000_000n)).not.toThrow();
  });

  it("applies the fee guard at baseFee × 1.125", () => {
    expect(feeGuardOk(1_000n, 1_125n)).toBe(true);
    expect(feeGuardOk(1_000n, 1_124n)).toBe(false);
  });

  it("derives the reference effective gas price ≈ 0.1044 gwei", () => {
    // 5.3341434936248e-5 ETH = 53_341_434_936_248 wei.
    const wei = 53_341_434_936_248n;
    const price = effectiveGasPrice(wei, 510_676n);
    // ≈ 104_452_598 wei/gas ≈ 0.10445 gwei.
    expect(price).toBeGreaterThan(100_000_000n);
    expect(price).toBeLessThan(110_000_000n);
  });
});
