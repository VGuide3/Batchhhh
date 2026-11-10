/**
 * Reference-transaction audit (§16). Replays the observable shape of the on-chain
 * reference `0x853b3eab…be5f38` (captured in `test/fixtures/reference_receipt.json`)
 * through the same registry, gas model, and invariant suite the live pipeline uses.
 *
 * This is the acceptance test for the spec: if the implementation's understanding of
 * the reference drifts, these assertions fail.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { CHAIN_ID, REFERENCE_SHAPE, USDC, USDT } from "../../src/registry.js";
import { predictGas, effectiveGasPrice } from "../../src/gas/budget.js";
import {
  checkAll,
  inv2,
  inv3,
  inv4,
  inv5,
  inv6,
  inv7,
  inv8,
  inv10,
  type InvariantContext,
  type ReceiptDigest,
} from "../../src/invariants/invariants.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../fixtures/reference_receipt.json"), "utf8"),
) as {
  txHash: string;
  type: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  to: string;
  from: string;
  inputByteLength: number;
  delegationTarget: string;
  authorityCode: string;
  authorities: string[];
  authorizationList: {
    chainId: string;
    address: string;
    nonce: string;
    yParity: string;
    r: string;
    s: string;
    recovered: string;
  }[];
  transfers: { token: string; from: string; to: string; amount: string }[];
};

describe("reference transaction: observed shape", () => {
  it("is a successful type-4 tx", () => {
    expect(fixture.type).toBe("0x4");
    expect(fixture.status).toBe("0x1");
  });

  it("matches the spec's gas and calldata constants", () => {
    expect(BigInt(fixture.gasUsed)).toBe(REFERENCE_SHAPE.gasUsed);
    expect(fixture.inputByteLength).toBe(REFERENCE_SHAPE.calldataLength);
    expect(fixture.inputByteLength).toBe(1156);
  });

  it("has 7 authorizations against one shared delegation target", () => {
    expect(fixture.authorizationList).toHaveLength(7);
    const targets = new Set(fixture.authorizationList.map((a) => a.address));
    expect(targets.size).toBe(1);
    expect([...targets][0]).toBe(fixture.delegationTarget);
  });

  it("has 14 transfers over 2 tokens, 8 senders, 14 recipients", () => {
    expect(fixture.transfers).toHaveLength(14);
    const tokens = new Set(fixture.transfers.map((t) => t.token));
    const froms = new Set(fixture.transfers.map((t) => t.from));
    const tos = new Set(fixture.transfers.map((t) => t.to));
    expect(tokens.size).toBe(2);
    expect(froms.size).toBe(8);
    expect(tos.size).toBe(14);
  });

  it("sums to the spec's per-token totals", () => {
    let usdc = 0n;
    let usdt = 0n;
    for (const t of fixture.transfers) {
      if (getAddress(t.token) === USDC) usdc += BigInt(t.amount);
      else if (getAddress(t.token) === USDT) usdt += BigInt(t.amount);
    }
    expect(usdc).toBe(REFERENCE_SHAPE.usdcTotal);
    expect(usdt).toBe(REFERENCE_SHAPE.usdtTotal);
  });

  it("has the entry point as the 8th source", () => {
    const froms = new Set(fixture.transfers.map((t) => t.from.toLowerCase()));
    expect(froms.has(fixture.to.toLowerCase())).toBe(true);
  });

  it("derives the observed effective gas price", () => {
    const price = effectiveGasPrice(
      BigInt(fixture.effectiveGasPrice) * BigInt(fixture.gasUsed),
      BigInt(fixture.gasUsed),
    );
    expect(price).toBe(BigInt(fixture.effectiveGasPrice));
  });

  it("the gas model reproduces the observed gasUsed", () => {
    const prediction = predictGas({
      authorizationCount: 7,
      calldataLength: 1156,
      recordCount: 14,
      executionGas: 383_680n,
    });
    expect(prediction.total).toBe(BigInt(fixture.gasUsed));
  });
});

describe("reference transaction: invariants", () => {
  const delegationTarget = getAddress(fixture.delegationTarget) as Address;
  const authorities = fixture.authorities.map((a) => getAddress(a)) as Address[];

  // For the reference, recipients are 14 distinct fresh addresses; the planned set is
  // exactly the observed transfers.
  const digest: ReceiptDigest = {
    status: 1,
    type: 4,
    gasUsed: BigInt(fixture.gasUsed),
    authorizationList: fixture.authorizationList.map((a) => ({
      address: getAddress(a.address),
      recovered: getAddress(a.recovered),
    })),
    transfers: fixture.transfers.map((t) => ({
      token: getAddress(t.token),
      from: getAddress(t.from),
      to: getAddress(t.to),
      amount: BigInt(t.amount),
    })),
    approvals: [],
    authorityCode: Object.fromEntries(
      authorities.map((a) => [a.toLowerCase(), fixture.authorityCode as Hex]),
    ),
    recipientBalances: Object.fromEntries(
      fixture.transfers.map((t) => [
        getAddress(t.to).toLowerCase(),
        { [getAddress(t.token).toLowerCase()]: BigInt(t.amount) },
      ]),
    ),
    recipientBalancesBefore: Object.fromEntries(
      fixture.transfers.map((t) => [getAddress(t.to).toLowerCase(), {}]),
    ),
  };

  const ctx: InvariantContext = {
    plan: {
      salt: `0x${"00".repeat(32)}` as Hex,
      records: fixture.transfers.map((t) => ({
        sourceOrdinal: 0 as never,
        token: getAddress(t.token),
        to: getAddress(t.to),
        amount: BigInt(t.amount),
        tag: "0x0000000000000000" as Hex,
      })),
      allowPartial: false,
      sweepMode: false,
      maxFeePerGas: 0n,
      gasCap: 600_000n,
      sourceBalancesSnapshot: {},
    },
    authorities,
    delegationTarget,
    allowedTokens: [USDC, USDT],
    entryPoint: getAddress(fixture.to),
    gasCap: 600_000n,
    usdc: USDC,
    usdt: USDT,
    usdcTotal: REFERENCE_SHAPE.usdcTotal,
    usdtTotal: REFERENCE_SHAPE.usdtTotal,
  };

  it("passes INV-2, INV-3, INV-4 (auth list)", () => {
    expect(inv2(digest).ok).toBe(true);
    expect(inv3(digest, ctx).ok).toBe(true);
    expect(inv4(digest, ctx).ok).toBe(true);
  });

  it("passes INV-5, INV-6, INV-7 (transfer accounting)", () => {
    expect(inv5(digest).ok).toBe(true);
    expect(inv6(digest, ctx).ok).toBe(true);
    expect(inv7(digest, ctx).ok).toBe(true);
  });

  it("passes INV-8 (delegation designator) and INV-10 (gas cap)", () => {
    expect(inv8(digest, ctx).ok).toBe(true);
    expect(inv10(digest, ctx).ok).toBe(true);
  });

  it("passes the full suite (INV-1..INV-11)", () => {
    const results = checkAll(digest, ctx);
    const failed = results.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed)).toHaveLength(0);
  });

  it("pins the chain id to mainnet", () => {
    expect(CHAIN_ID).toBe(1n);
  });
});
