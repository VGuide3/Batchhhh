/**
 * Chain adapter (I/O boundary). Everything the pipeline needs from a node sits behind
 * this narrow port so the orchestration in `runner.ts` is testable with a fake and so
 * the concrete transport (viem HTTP) is swappable.
 */

import type { Address, Hex } from "viem";
import type { AuthTuple } from "../plan/types.js";
import type { RawLog, RawReceipt } from "../exec/reconciler.js";

export interface SendType4Request {
  readonly to: Address;
  readonly data: Hex;
  readonly authorizationList: readonly AuthTuple[];
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly nonce: number;
  readonly chainId: bigint;
}

export interface NodeReceipt {
  readonly status: 0 | 1;
  readonly type: number;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly logs: readonly RawLog[];
  readonly authorizationList: readonly { address: Address; recovered: Address }[];
}

export interface ChainPort {
  chainId(): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  /** Latest base fee in wei/gas. */
  baseFeePerGas(): Promise<bigint>;
  /** Account nonce; pass a block tag for a pinned read. */
  getTransactionCount(address: Address, blockTag?: bigint | "latest" | "pending"): Promise<number>;
  /** Deployed bytecode length (0 for EOA). */
  codeLength(address: Address): Promise<number>;
  /** ERC-20 balance in base units. */
  erc20Balance(token: Address, account: Address): Promise<bigint>;
  /** ERC-20 allowance owner→spender in base units. */
  erc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** eth_estimateGas for a type-4 request. */
  estimateGas(req: SendType4Request): Promise<bigint>;
  /** Sends the type-4 transaction; returns its hash. */
  sendType4(req: SendType4Request): Promise<Hex>;
  /** Waits for and returns the receipt. */
  waitForReceipt(hash: Hex): Promise<NodeReceipt>;
  /** Live 7702 delegation target for an account (parsed from its designator), or null. */
  delegationTargetOf(account: Address): Promise<Address | null>;
}

/** Re-exported so adapters can build `NodeReceipt` values without a second import. */
export type { RawLog, RawReceipt };
