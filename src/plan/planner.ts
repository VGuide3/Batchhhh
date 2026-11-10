/**
 * Planner (§6). Builds and validates a `TransferPlan`, then groups records by
 * source ordinal in auth-list order.
 *
 * Validation gates (§6):
 *   1. records.length <= 64
 *   2. every amount > 0
 *   3. Σ per (source, token) ≤ sourceBalancesSnapshot[source][token]
 *   4. for non-authority sources, Σ ≤ live allowance(source, impl)
 *   5. to != source, to != 0x0, to is EOA or non-reentrant contract
 *   6. all 7 authorities present even if zero records (warn only)
 */

import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { PlanError } from "../errors.js";
import type { Registry } from "../registry.js";
import {
  asSourceOrdinal,
  DEFAULT_GAS_CAP,
  MAX_RECORDS,
  type PlannedBatch,
  type TransferRecord,
  type SourceBalances,
  type TransferPlan,
} from "./types.js";

export interface PlanInput {
  readonly registry: Registry;
  readonly records: readonly TransferRecord[];
  readonly allowPartial?: boolean;
  readonly sweepMode?: boolean;
  readonly maxFeePerGas: bigint;
  readonly gasCap?: bigint;
  readonly sourceBalancesSnapshot: Readonly<Record<string, SourceBalances>>;
  /** Live allowance(source, delegationTarget) for non-authority sources, keyed lowercase. */
  readonly allowances?: Readonly<Record<string, bigint>>;
  /** Optional code probe; returns deployed bytecode length for an address. */
  readonly codeLength?: (address: Address) => Promise<number> | number;
  /** Addresses that must be treated as non-reentrant contracts (allowlist). */
  readonly approvedContracts?: readonly Address[];
}

/** Warning surfaced by the planner (non-fatal). */
export interface PlanWarning {
  readonly code: "ZERO_RECORD_AUTHORITY";
  readonly message: string;
}

export interface PlanResult {
  readonly batch: PlannedBatch;
  readonly warnings: readonly PlanWarning[];
}

/** Canonical JSON of a plan's record set; the salt is its keccak hash. */
export function canonicalPlanJson(records: readonly TransferRecord[], flags: { allowPartial: boolean; sweepMode: boolean }): string {
  const normalized = records.map((r) => ({
    s: r.sourceOrdinal,
    token: getAddress(r.token),
    to: getAddress(r.to),
    amount: r.amount.toString(),
    tag: r.tag,
  }));
  return JSON.stringify({ records: normalized, flags });
}

export function deriveSalt(records: readonly TransferRecord[], flags: { allowPartial: boolean; sweepMode: boolean }): Hex {
  return keccak256(toHex(canonicalPlanJson(records, flags)));
}

export async function planBatch(input: PlanInput): Promise<PlanResult> {
  const { registry } = input;
  const records = input.records;

  // Gate 1: record cap.
  if (records.length === 0) throw new PlanError("plan has no records");
  if (records.length > MAX_RECORDS) {
    throw new PlanError(`recordCount ${records.length} exceeds MAX_RECORDS ${MAX_RECORDS}`);
  }

  const authorities = new Set(registry.authorities.map((a) => a.toLowerCase()));
  const tokenSet = new Set(registry.tokens.map((t) => t.toLowerCase()));

  // Aggregate planned outflow per (source, token).
  const outflow = new Map<string, Map<string, bigint>>();
  const perSourceCount = new Map<number, number>();

  for (const r of records) {
    // Gate 2: positive amount.
    if (r.amount <= 0n) {
      throw new PlanError(`amount must be > 0 (got ${r.amount}) for to=${r.to}`);
    }
    const token = getAddress(r.token);
    if (!tokenSet.has(token.toLowerCase())) {
      throw new PlanError(`token not allowlisted: ${token}`);
    }

    const ordinal = r.sourceOrdinal;
    if (ordinal < registry.sources.length) {
      // ok, known ordinal
    } else {
      throw new PlanError(`source ordinal ${ordinal} out of range`);
    }
    const source = registry.sources[ordinal]!;

    // Gate 5: recipient sanity.
    const to = getAddress(r.to);
    if (to === "0x0000000000000000000000000000000000000000") {
      throw new PlanError("recipient is the zero address");
    }
    if (to.toLowerCase() === source.toLowerCase()) {
      throw new PlanError(`recipient equals source ${source} (ordinal ${ordinal})`);
    }
    await assertRecipientAllowed(to, input);

    const key = `${ordinal}:${token.toLowerCase()}`;
    let byToken = outflow.get(key);
    if (!byToken) {
      byToken = new Map();
      outflow.set(key, byToken);
    }
    byToken.set(token.toLowerCase(), (byToken.get(token.toLowerCase()) ?? 0n) + r.amount);

    perSourceCount.set(ordinal, (perSourceCount.get(ordinal) ?? 0) + 1);
  }

  // Gate 3 + 4: per-source, per-token outflow vs balances/allowance.
  for (const [key, byToken] of outflow) {
    const ordinal = Number(key.split(":")[0]);
    const source = registry.sources[ordinal]!;
    const isAuthority = authorities.has(source.toLowerCase());

    for (const [token, amount] of byToken) {
      const balance = input.sourceBalancesSnapshot[source.toLowerCase()]?.[token as Hex] ?? 0n;
      if (amount > balance) {
        throw new PlanError(
          `outflow ${amount} exceeds balance ${balance} for ${source} / ${token}`,
        );
      }
      if (!isAuthority) {
        const allowance = input.allowances?.[source.toLowerCase()] ?? 0n;
        if (amount > allowance) {
          throw new PlanError(
            `outflow ${amount} exceeds allowance ${allowance} for approved source ${source} / ${token}`,
          );
        }
      }
    }
  }

  // Per-source record cap (mirrors the contract's MAX_RECORDS_PER_SOURCE).
  for (const [ordinal, count] of perSourceCount) {
    if (count > 8) {
      throw new PlanError(`source ordinal ${ordinal} has ${count} records (cap 8)`);
    }
  }

  // Gate 6: all authorities present in the registry (warn on zero-record ones).
  const warnings: PlanWarning[] = [];
  registry.authorities.forEach((a, i) => {
    if (!perSourceCount.has(i)) {
      warnings.push({
        code: "ZERO_RECORD_AUTHORITY",
        message: `authority ${a} (ordinal ${i}) carries zero records; authorizing it wastes gas`,
      });
    }
  });

  const flags = { allowPartial: input.allowPartial ?? false, sweepMode: input.sweepMode ?? false };
  const salt = deriveSalt(records, flags);

  const plan: TransferPlan = Object.freeze({
    salt,
    records: Object.freeze([...records]),
    allowPartial: flags.allowPartial,
    sweepMode: flags.sweepMode,
    maxFeePerGas: input.maxFeePerGas,
    gasCap: input.gasCap ?? DEFAULT_GAS_CAP,
    sourceBalancesSnapshot: input.sourceBalancesSnapshot,
  });

  const groups: TransferRecord[][] = [];
  for (let s = 0; s < registry.sources.length; s++) {
    groups.push(records.filter((r) => r.sourceOrdinal === s));
  }
  const nonEmpty = groups.filter((g) => g.length > 0).length;

  return {
    batch: {
      plan,
      groups: Object.freeze(groups.map((g) => Object.freeze(g))),
      sourceCount: nonEmpty,
    },
    warnings,
  };
}

async function assertRecipientAllowed(to: Address, input: PlanInput): Promise<void> {
  if (!input.codeLength) return;
  const len = await input.codeLength(to);
  if (len === 0) return; // EOA
  const approved = (input.approvedContracts ?? []).map((a) => getAddress(a).toLowerCase());
  if (!approved.includes(to.toLowerCase())) {
    throw new PlanError(`recipient ${to} is a contract and not on the approved-contracts list`);
  }
}

export { asSourceOrdinal };
