/**
 * Off-chain data model for SPEC-7702-BATCH-001 (§6).
 */

import type { Hex } from "viem";

/** Branded source ordinal: 0..6 → authorities, 7+ → approved sources. */
export type SourceOrdinal = number & { readonly __brand: "sourceOrdinal" };

export function asSourceOrdinal(n: number): SourceOrdinal {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`invalid source ordinal: ${n}`);
  }
  return n as SourceOrdinal;
}

export interface TransferRecord {
  readonly sourceOrdinal: SourceOrdinal;
  readonly token: Hex;
  readonly to: Hex;
  readonly amount: bigint; // base units (6dp for USDC/USDT)
  readonly tag: Hex; // 8 bytes
}

export interface SourceBalances {
  readonly [token: Hex]: bigint;
}

export interface TransferPlan {
  readonly salt: Hex; // keccak of canonical plan JSON
  readonly records: readonly TransferRecord[]; // 1..64
  readonly allowPartial: boolean;
  readonly sweepMode: boolean;
  readonly maxFeePerGas: bigint;
  readonly gasCap: bigint; // hard ceiling, default 600_000
  readonly sourceBalancesSnapshot: Readonly<globalThis.Record<string, SourceBalances>>;
}

export interface AuthTuple {
  readonly chainId: bigint;
  readonly address: Hex; // delegationTarget
  readonly nonce: bigint; // authority's CURRENT nonce, pre-increment
  readonly yParity: 0 | 1;
  readonly r: Hex;
  readonly s: Hex;
}

export interface PlannedBatch {
  readonly plan: TransferPlan;
  /** Records grouped by source ordinal, in auth-list order. */
  readonly groups: readonly (readonly TransferRecord[])[];
  readonly sourceCount: number;
}

/** Default hard gas ceiling for a batch. */
export const DEFAULT_GAS_CAP = 600_000n;

/** v1 batch-wide record ceiling. */
export const MAX_RECORDS = 64;
