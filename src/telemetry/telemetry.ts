/**
 * Telemetry (§14). A per-run record plus the alert predicates the spec calls for.
 */

import type { Hex } from "viem";
import type { InvariantResult } from "../invariants/invariants.js";

export interface TelemetryRecord {
  readonly planId: Hex;
  readonly recordCount: number;
  readonly sourceCount: number;
  readonly predictedGas: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly ethCost: bigint;
  readonly authRecoverySuccessRate: number; // 0..1
  readonly leafRevertCount: number;
  readonly invariants: readonly InvariantResult[];
  readonly logDigest: Hex;
}

export type AlertKind =
  | "INVARIANT_FAILURE"
  | "GAS_NEAR_CAP"
  | "AUTHORITY_CODE_MISMATCH"
  | "TRANSFER_COUNT_MISMATCH";

export interface Alert {
  readonly kind: AlertKind;
  readonly message: string;
}

export interface AlertThresholds {
  readonly gasCap: bigint;
  /** Fraction of gasCap above which GAS_NEAR_CAP fires (default 0.9). */
  readonly gasWarnFraction?: number;
}

/** Evaluates the alert predicates over a telemetry record. */
export function evaluateAlerts(
  record: TelemetryRecord,
  thresholds: AlertThresholds,
): readonly Alert[] {
  const alerts: Alert[] = [];
  const gasWarnFraction = thresholds.gasWarnFraction ?? 0.9;
  const gasWarn = (thresholds.gasCap * BigInt(Math.round(gasWarnFraction * 1000))) / 1000n;

  const failed = record.invariants.filter((i) => !i.ok);
  if (failed.length > 0) {
    alerts.push({
      kind: "INVARIANT_FAILURE",
      message: `failed invariants: ${failed.map((f) => f.id).join(",")}`,
    });
  }

  if (record.gasUsed > gasWarn) {
    alerts.push({
      kind: "GAS_NEAR_CAP",
      message: `gasUsed ${record.gasUsed} > ${gasWarnFraction} × gasCap ${thresholds.gasCap}`,
    });
  }

  if (record.authRecoverySuccessRate < 1) {
    alerts.push({
      kind: "AUTHORITY_CODE_MISMATCH",
      message: `auth recovery success rate ${record.authRecoverySuccessRate} < 1`,
    });
  }

  const transferCount = record.invariants.find((i) => i.id === "INV-5");
  if (transferCount && !transferCount.ok) {
    alerts.push({
      kind: "TRANSFER_COUNT_MISMATCH",
      message: `record_count (${record.recordCount}) != emitted Transfer count`,
    });
  }

  return alerts;
}
