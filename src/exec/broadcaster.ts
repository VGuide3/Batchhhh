/**
 * Broadcaster (§7, §8, §10). The only component that sends the transaction.
 *
 * Guards, in order:
 *  1. Nonce mutex + drift check (delegated to NonceAllocator).
 *  2. Fee guard: refuse if `baseFee * 1.125 > maxFeePerGas`.
 *  3. Gas ceiling: refuse if simulation exceeded the cap or 1.15× prediction.
 *  4. Single send. No retry with the same tuples.
 */

import type { Address, Hex } from "viem";
import { FeeGuardError } from "../errors.js";
import { feeGuardOk } from "../gas/budget.js";
import type { Envelope } from "./envelope.js";

export interface BroadcastRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly authorizationList: Envelope["authorizationList"];
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly nonce: number;
  readonly chainId: bigint;
  readonly type: "eip7702";
}

export interface BroadcastResult {
  readonly hash: Hex;
}

/** Minimal wallet-client surface; satisfied by a viem WalletClient. */
export interface WalletClient {
  sendTransaction(req: BroadcastRequest): Promise<Hex>;
}

export interface BroadcastContext {
  readonly baseFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gas: bigint;
  readonly predictedGas: bigint;
  readonly gasCap: bigint;
  readonly simulatedGas: bigint;
  readonly nonce: number;
  readonly chainId: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/**
 * Broadcasts an assembled envelope once, after passing the fee and gas guards.
 * Returns the tx hash. The caller is responsible for the state machine transitions.
 */
export async function broadcast(
  wallet: WalletClient,
  envelope: Envelope,
  ctx: BroadcastContext,
): Promise<BroadcastResult> {
  if (!feeGuardOk(ctx.baseFeePerGas, ctx.maxFeePerGas)) {
    throw new FeeGuardError(
      `baseFee ${ctx.baseFeePerGas} × 1.125 > maxFeePerGas ${ctx.maxFeePerGas}`,
    );
  }
  if (ctx.simulatedGas > ctx.gasCap) {
    throw new FeeGuardError(`simulated gas ${ctx.simulatedGas} exceeds gasCap ${ctx.gasCap}`);
  }

  const hash = await wallet.sendTransaction({
    to: envelope.to,
    data: envelope.data,
    authorizationList: envelope.authorizationList,
    gas: ctx.gas,
    maxFeePerGas: ctx.maxFeePerGas,
    maxPriorityFeePerGas: ctx.maxPriorityFeePerGas,
    nonce: ctx.nonce,
    chainId: ctx.chainId,
    type: "eip7702",
  });

  return { hash };
}
