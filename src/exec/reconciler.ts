/**
 * Reconciler (§7, §9). Consumes raw receipt/log data and a plan, builds a
 * `ReceiptDigest`, and runs the invariants.
 *
 * Raw input shape mirrors what an `eth_getTransactionReceipt` + `eth_getLogs` +
 * `eth_getCode`/`eth_call` sweep produces. Keeping it as plain data makes the
 * reconciler testable without a live node.
 */

import { getAddress, type Address, type Hex } from "viem";
import {
  assertAll,
  checkAll,
  type ApprovalLog,
  type InvariantContext,
  type InvariantResult,
  type ReceiptDigest,
  type TransferLog,
} from "../invariants/invariants.js";
import { keccak256, toHex } from "viem";
import type { TransferPlan } from "../plan/types.js";

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = keccak256(
  toHex("Transfer(address,address,uint256)"),
) as Hex;

/** keccak256("Approval(address,address,uint256)"). */
export const APPROVAL_TOPIC = keccak256(toHex("Approval(address,address,uint256)")) as Hex;

export interface RawLog {
  readonly address: Address; // token
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface RawReceipt {
  readonly status: 0 | 1;
  readonly type: number;
  readonly gasUsed: bigint;
  readonly authorizationList: readonly { readonly address: Address; readonly recovered: Address }[];
  readonly logs: readonly RawLog[];
}

export interface ReconcilerEnv {
  readonly authorities: readonly Address[];
  readonly delegationTarget: Address;
  readonly allowedTokens: readonly Address[];
  readonly entryPoint: Address;
  readonly gasCap: bigint;
  readonly usdc: Address;
  readonly usdt: Address;
  readonly usdcTotal: bigint;
  readonly usdtTotal: bigint;
  /** Post-tx code per authority, keyed lowercase. */
  readonly authorityCode: Readonly<Record<string, Hex>>;
  /** Pre/post balances keyed `address → token → balance`, addresses lowercase. */
  readonly balancesBefore: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
  readonly balancesAfter: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
}

export interface ReconcileResult {
  readonly digest: ReceiptDigest;
  readonly results: readonly InvariantResult[];
}

/** Parses Transfer/Approval logs into typed structures. */
export function parseLogs(logs: readonly RawLog[]): {
  transfers: TransferLog[];
  approvals: ApprovalLog[];
} {
  const transfers: TransferLog[] = [];
  const approvals: ApprovalLog[] = [];

  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 === TRANSFER_TOPIC.toLowerCase()) {
      // Transfer(address indexed from, address indexed to, uint256 amount)
      const from = topicToAddress(log.topics[1]!);
      const to = topicToAddress(log.topics[2]!);
      transfers.push({ token: getAddress(log.address), from, to, amount: hexToBigInt(log.data) });
    } else if (topic0 === APPROVAL_TOPIC.toLowerCase()) {
      // Approval(address indexed owner, address indexed spender, uint256 amount)
      const owner = topicToAddress(log.topics[1]!);
      const spender = topicToAddress(log.topics[2]!);
      approvals.push({
        token: getAddress(log.address),
        owner,
        spender,
        amount: hexToBigInt(log.data),
      });
    }
  }
  return { transfers, approvals };
}

/** Builds a `ReceiptDigest` from raw receipt data. */
export function buildDigest(receipt: RawReceipt, env: ReconcilerEnv): ReceiptDigest {
  const { transfers, approvals } = parseLogs(receipt.logs);
  return {
    status: receipt.status,
    type: receipt.type,
    gasUsed: receipt.gasUsed,
    authorizationList: receipt.authorizationList,
    transfers,
    approvals,
    authorityCode: env.authorityCode,
    recipientBalances: env.balancesAfter,
    recipientBalancesBefore: env.balancesBefore,
  };
}

/** Reconciles a raw receipt against a plan and runs all invariants. */
export function reconcile(
  receipt: RawReceipt,
  plan: TransferPlan,
  env: ReconcilerEnv,
): ReconcileResult {
  const digest = buildDigest(receipt, env);
  const ctx = toInvariantContext(plan, env);
  const results = checkAll(digest, ctx);
  return { digest, results };
}

/** Reconciles and throws on the first invariant failure (halt + page). */
export function reconcileStrict(
  receipt: RawReceipt,
  plan: TransferPlan,
  env: ReconcilerEnv,
): ReconcileResult {
  const digest = buildDigest(receipt, env);
  const ctx = toInvariantContext(plan, env);
  assertAll(digest, ctx);
  return { digest, results: checkAll(digest, ctx) };
}

function toInvariantContext(plan: TransferPlan, env: ReconcilerEnv): InvariantContext {
  return {
    plan,
    authorities: env.authorities,
    delegationTarget: env.delegationTarget,
    allowedTokens: env.allowedTokens,
    entryPoint: env.entryPoint,
    gasCap: env.gasCap,
    usdc: env.usdc,
    usdt: env.usdt,
    usdcTotal: env.usdcTotal,
    usdtTotal: env.usdtTotal,
  };
}

function topicToAddress(topic: Hex): Address {
  // Address topics are left-padded to 32 bytes; the last 20 bytes are the address.
  return getAddress(`0x${topic.slice(-40)}`);
}

function hexToBigInt(hex: Hex): bigint {
  if (hex === "0x") return 0n;
  return BigInt(hex);
}
