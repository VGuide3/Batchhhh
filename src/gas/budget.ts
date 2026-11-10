/**
 * Gas budget model (§8).
 *
 *   Tx base                             21 000
 *   Authorization intrinsic (7 × 12 500) 87 500
 *   Calldata intrinsic (≤ 16/B)          ≤ 18 496
 *   Execution residual                   ≈ 383 680
 *   Total (reference)                    510 676
 *
 * The broadcaster aborts if simulation exceeds `1.15 × predicted` or the hard cap.
 */

import { GasCeilingError } from "../errors.js";

export const TX_BASE_GAS = 21_000n;
export const PER_AUTHORIZATION_GAS = 12_500n;

/** Per-transfer execution budget derived from the reference: 383680 / 14. */
export const REFERENCE_EXECUTION_GAS = 383_680n;
export const REFERENCE_TOTAL_GAS = 510_676n;
export const REFERENCE_CALLDATA_LENGTH = 1156;

/** Upper bound used for calldata intrinsic (non-zero byte = 16). */
export const CALLDATA_BYTE_GAS = 16n;

/** Default hard ceiling. */
export const DEFAULT_GAS_CAP = 600_000n;

/** Simulation must not exceed this multiple of the prediction. */
export const SIMULATION_SLACK = 1.15;

export interface GasPredictionInput {
  readonly authorizationCount: number;
  readonly calldataLength: number;
  /** Optional measured execution residual; falls back to the per-transfer model. */
  readonly executionGas?: bigint;
  readonly recordCount: number;
}

export interface GasPrediction {
  readonly txBase: bigint;
  readonly authorizationIntrinsic: bigint;
  readonly calldataIntrinsic: bigint;
  readonly execution: bigint;
  readonly total: bigint;
  /** Per-record execution budget. */
  readonly perTransfer: bigint;
}

/** Predicts total gas from the batch shape. */
export function predictGas(input: GasPredictionInput): GasPrediction {
  const authorizationIntrinsic = BigInt(input.authorizationCount) * PER_AUTHORIZATION_GAS;
  const calldataIntrinsic = BigInt(input.calldataLength) * CALLDATA_BYTE_GAS;
  const execution =
    input.executionGas ??
    (input.recordCount > 0
      ? (REFERENCE_EXECUTION_GAS * BigInt(input.recordCount)) / 14n
      : 0n);
  const perTransfer = input.recordCount > 0 ? execution / BigInt(input.recordCount) : 0n;
  const total = TX_BASE_GAS + authorizationIntrinsic + calldataIntrinsic + execution;
  return { txBase: TX_BASE_GAS, authorizationIntrinsic, calldataIntrinsic, execution, total, perTransfer };
}

/**
 * Enforces the gas ceiling. Throws if the simulated gas exceeds the hard cap or the
 * prediction by more than SIMULATION_SLACK.
 */
export function enforceGasCeiling(
  simulated: bigint,
  predicted: bigint,
  gasCap: bigint = DEFAULT_GAS_CAP,
): void {
  if (simulated > gasCap) {
    throw new GasCeilingError(`simulated gas ${simulated} exceeds gasCap ${gasCap}`);
  }
  const ceiling = (predicted * BigInt(Math.round(SIMULATION_SLACK * 1000))) / 1000n;
  if (simulated > ceiling) {
    throw new GasCeilingError(
      `simulated gas ${simulated} exceeds 1.15× prediction ${predicted} (ceiling ${ceiling})`,
    );
  }
}

/**
 * Reference effective gas price for the observed tx, in wei per gas:
 * 5.3341434936248e-5 ETH / 510676 ≈ 104_452_598 wei/gas ≈ 0.1044 gwei.
 */
export function effectiveGasPrice(ethCostWei: bigint, gasUsed: bigint): bigint {
  if (gasUsed === 0n) throw new GasCeilingError("gasUsed is zero");
  return ethCostWei / gasUsed;
}

/** Converts a wei-per-gas price to gwei (scaled by 1e9, i.e. an integer gwei). */
export function weiToGwei(weiPerGas: bigint): bigint {
  return weiPerGas / 1_000_000_000n;
}

/** True if `baseFee * 1.125 <= maxFeePerGas` (broadcaster guard). */
export function feeGuardOk(baseFee: bigint, maxFeePerGas: bigint): boolean {
  return (baseFee * 1125n) / 1000n <= maxFeePerGas;
}
