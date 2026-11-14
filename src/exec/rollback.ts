/**
 * Rollback handler (§7, §10). A REVERTED/DROPPED batch is dead: its tuples are
 * nonce-bound and single-use, so recovery means re-reading balances and rebuilding
 * the plan from scratch with fresh nonces and a new salt.
 */

import type { Address, Hex } from "viem";
import { DisperserError } from "../errors.js";
import type { SourceBalances } from "../plan/types.js";

export interface RollbackInput {
  readonly batchId: Hex;
  readonly reason: string;
  readonly authorities: readonly Address[];
}

export interface RollbackPlan {
  readonly deadBatchId: Hex;
  readonly reason: string;
  readonly /** New salt must be derived off-chain; the old one is poisoned. */ freshSalt: Hex;
  readonly balances: Readonly<Record<string, SourceBalances>>;
}

export interface BalanceReader {
  readBalances(
    sources: readonly Address[],
    tokens: readonly Address[],
  ): Promise<Readonly<Record<string, SourceBalances>>>;
}

export interface RollbackDeps {
  readonly reader: BalanceReader;
  readonly sources: readonly Address[];
  readonly tokens: readonly Address[];
  readonly saltSource: () => Hex;
}

/**
 * Marks a batch dead, re-reads live balances, and returns a fresh plan seed.
 * The caller re-runs the planner with the returned balances + salt.
 */
export async function rollback(
  input: RollbackInput,
  deps: RollbackDeps,
): Promise<RollbackPlan> {
  if (input.authorities.length === 0) {
    throw new DisperserError("rollback requires at least one authority");
  }
  const balances = await deps.reader.readBalances(deps.sources, deps.tokens);
  return {
    deadBatchId: input.batchId,
    reason: input.reason,
    freshSalt: deps.saltSource(),
    balances,
  };
}
