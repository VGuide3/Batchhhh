/**
 * Post-confirmation invariants (§9). Each INV is a pure predicate over an observed
 * `ReceiptDigest` + the plan. `checkAll` returns per-invariant results; any failure
 * halts the reconciler.
 */

import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { InvariantError } from "../errors.js";
import { decodeOrdinal } from "../codec/batch.js";
import type { TransferPlan } from "../plan/types.js";

export interface TransferLog {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly amount: bigint;
}

export interface ApprovalLog {
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly amount: bigint;
}

export interface ReceiptDigest {
  readonly status: 0 | 1;
  readonly type: number;
  readonly gasUsed: bigint;
  readonly authorizationList: readonly { readonly address: Address; readonly recovered: Address }[];
  readonly transfers: readonly TransferLog[];
  readonly approvals: readonly ApprovalLog[];
  /** Post-tx code for each authority: `0xef0100 ‖ impl` or `0x` if not delegated. */
  readonly authorityCode: Readonly<Record<string, Hex>>;
  /** Post-tx recipient balances keyed `to → token → balance`. */
  readonly recipientBalances: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
  /** Pre-tx recipient balances, same shape. */
  readonly recipientBalancesBefore: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
}

export interface InvariantContext {
  readonly plan: TransferPlan;
  readonly authorities: readonly Address[];
  readonly delegationTarget: Address;
  readonly allowedTokens: readonly Address[];
  readonly entryPoint: Address;
  readonly gasCap: bigint;
  readonly usdcTotal: bigint;
  readonly usdtTotal: bigint;
  readonly usdc: Address;
  readonly usdt: Address;
}

export interface InvariantResult {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export const DELEGATION_PREFIX = "0xef0100";

/** INV-1: receipt.status === 1. */
export function inv1(d: ReceiptDigest): InvariantResult {
  return { id: "INV-1", ok: d.status === 1, detail: `status=${d.status}` };
}

/** INV-2: tx.type === 4 and authorizationList.length === 7. */
export function inv2(d: ReceiptDigest): InvariantResult {
  const ok = d.type === 4 && d.authorizationList.length === 7;
  return {
    id: "INV-2",
    ok,
    detail: `type=${d.type} authList=${d.authorizationList.length}`,
  };
}

/** INV-3: all authorizationList[i].address === delegationTarget. */
export function inv3(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  const target = getAddress(ctx.delegationTarget).toLowerCase();
  const ok = d.authorizationList.every((a) => getAddress(a.address).toLowerCase() === target);
  return {
    id: "INV-3",
    ok,
    detail: `targets=${[...new Set(d.authorizationList.map((a) => a.address))].join(",")}`,
  };
}

/** INV-4: all 7 authorities recovered, distinct. */
export function inv4(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  const expected = new Set(ctx.authorities.map((a) => getAddress(a).toLowerCase()));
  const recovered = d.authorizationList.map((a) => getAddress(a.recovered).toLowerCase());
  const distinct = new Set(recovered);
  const allRegistered = recovered.every((r) => expected.has(r));
  const ok = distinct.size === recovered.length && recovered.length === 7 && allRegistered;
  return {
    id: "INV-4",
    ok,
    detail: `recovered=${recovered.length} distinct=${distinct.size} allRegistered=${allRegistered}`,
  };
}

/** INV-5: Transfer log count 14; distinct tokens 2; distinct from 8; distinct to 14. */
export function inv5(d: ReceiptDigest): InvariantResult {
  const count = d.transfers.length;
  const tokens = new Set(d.transfers.map((t) => getAddress(t.token).toLowerCase()));
  const froms = new Set(d.transfers.map((t) => getAddress(t.from).toLowerCase()));
  const tos = new Set(d.transfers.map((t) => getAddress(t.to).toLowerCase()));
  const ok = count === 14 && tokens.size === 2 && froms.size === 8 && tos.size === 14;
  return {
    id: "INV-5",
    ok,
    detail: `count=${count} tokens=${tokens.size} from=${froms.size} to=${tos.size}`,
  };
}

/** INV-6: Σ USDC logs === usdcTotal; Σ USDT logs === usdtTotal. */
export function inv6(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  const usdc = getAddress(ctx.usdc).toLowerCase();
  const usdt = getAddress(ctx.usdt).toLowerCase();
  let usdcSum = 0n;
  let usdtSum = 0n;
  for (const t of d.transfers) {
    const tok = getAddress(t.token).toLowerCase();
    if (tok === usdc) usdcSum += t.amount;
    else if (tok === usdt) usdtSum += t.amount;
  }
  const ok = usdcSum === ctx.usdcTotal && usdtSum === ctx.usdtTotal;
  return { id: "INV-6", ok, detail: `usdc=${usdcSum} usdt=${usdtSum}` };
}

/** INV-7: authority set ⊆ source set (every authority appears as a `from`). */
export function inv7(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  const froms = new Set(d.transfers.map((t) => getAddress(t.from).toLowerCase()));
  const missing = ctx.authorities.filter((a) => !froms.has(getAddress(a).toLowerCase()));
  return { id: "INV-7", ok: missing.length === 0, detail: `missing=${missing.join(",")}` };
}

/** INV-8: post-tx code(authority) === 0xef0100 ‖ delegationTarget. */
export function inv8(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  const expected = `${DELEGATION_PREFIX}${getAddress(ctx.delegationTarget).slice(2).toLowerCase()}`;
  const bad = ctx.authorities.filter((a) => {
    const code = d.authorityCode[a.toLowerCase()] ?? d.authorityCode[getAddress(a)] ?? "0x";
    return code.toLowerCase() !== expected;
  });
  return { id: "INV-8", ok: bad.length === 0, detail: `bad=${bad.join(",")}` };
}

/** INV-9: post-tx recipient balances increased by exactly their planned amounts. */
export function inv9(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  const planned = new Map<string, bigint>();
  for (const r of ctx.plan.records) {
    const key = `${getAddress(r.to).toLowerCase()}:${getAddress(r.token).toLowerCase()}`;
    planned.set(key, (planned.get(key) ?? 0n) + r.amount);
  }
  const problems: string[] = [];
  for (const [key, amount] of planned) {
    const [to, token] = key.split(":");
    const before = d.recipientBalancesBefore[to!]?.[token!] ?? 0n;
    const after = d.recipientBalances[to!]?.[token!] ?? 0n;
    if (after - before !== amount) {
      problems.push(`${to}/${token}: Δ=${after - before} expected=${amount}`);
    }
  }
  return { id: "INV-9", ok: problems.length === 0, detail: problems.join("; ") };
}

/** INV-10: gasUsed <= gasCap. */
export function inv10(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  return { id: "INV-10", ok: d.gasUsed <= ctx.gasCap, detail: `gasUsed=${d.gasUsed}` };
}

/** INV-11: zero Approval logs and zero non-allowlisted token logs. */
export function inv11(d: ReceiptDigest, ctx: InvariantContext): InvariantResult {
  const allowed = new Set(ctx.allowedTokens.map((t) => getAddress(t).toLowerCase()));
  const badTokens = d.transfers.filter((t) => !allowed.has(getAddress(t.token).toLowerCase()));
  const ok = d.approvals.length === 0 && badTokens.length === 0;
  return {
    id: "INV-11",
    ok,
    detail: `approvals=${d.approvals.length} badTokens=${badTokens.length}`,
  };
}

export const INVARIANT_IDS = [
  "INV-1",
  "INV-2",
  "INV-3",
  "INV-4",
  "INV-5",
  "INV-6",
  "INV-7",
  "INV-8",
  "INV-9",
  "INV-10",
  "INV-11",
] as const;

/** Runs all 11 invariants and returns their results in order. */
export function checkAll(d: ReceiptDigest, ctx: InvariantContext): readonly InvariantResult[] {
  return [
    inv1(d),
    inv2(d),
    inv3(d, ctx),
    inv4(d, ctx),
    inv5(d),
    inv6(d, ctx),
    inv7(d, ctx),
    inv8(d, ctx),
    inv9(d, ctx),
    inv10(d, ctx),
    inv11(d, ctx),
  ];
}

/** Throws on the first failing invariant. Used by the reconciler to halt + page. */
export function assertAll(d: ReceiptDigest, ctx: InvariantContext): readonly InvariantResult[] {
  const results = checkAll(d, ctx);
  const failed = results.find((r) => !r.ok);
  if (failed) throw new InvariantError(failed.id, failed.detail);
  return results;
}

export { decodeOrdinal };
