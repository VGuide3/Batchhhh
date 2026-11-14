import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toHex, type Address } from "viem";
import { buildRegistry } from "../../src/registry.js";
import { PlanError } from "../../src/errors.js";
import { encodeTag } from "../../src/codec/batch.js";
import { asSourceOrdinal, type TransferRecord } from "../../src/plan/types.js";
import { planBatch } from "../../src/plan/planner.js";
import { USDC, USDT } from "../../src/registry.js";

const AUTHORITIES: Address[] = Array.from({ length: 7 }, (_, i) =>
  getAddress(toHex(BigInt(0x1000 + i + 1), { size: 20 })),
);
const APPROVED: Address = getAddress(toHex(0xacce, { size: 20 }));
const DELEGATION_TARGET: Address = getAddress(toHex(0xdead, { size: 20 }));

function registry() {
  return buildRegistry({
    delegationTarget: DELEGATION_TARGET,
    authorities: AUTHORITIES,
    approvedSources: [APPROVED],
  });
}

function rec(ordinal: number, to: Address, amount: bigint, token = USDC): TransferRecord {
  return { sourceOrdinal: asSourceOrdinal(ordinal), token, to, amount, tag: encodeTag(ordinal) };
}

function balances(amount: bigint) {
  const snap: Record<string, Record<string, bigint>> = {};
  for (const a of [...AUTHORITIES, APPROVED]) {
    snap[a.toLowerCase()] = { [USDC.toLowerCase()]: amount, [USDT.toLowerCase()]: amount };
  }
  return snap;
}

describe("planner: validation gates", () => {
  it("accepts a valid multi-source plan", async () => {
    const records = [
      rec(0, getAddress(toHex(0x9000, { size: 20 })), 1000n),
      rec(1, getAddress(toHex(0x9001, { size: 20 })), 2000n, USDT),
    ];
    const { batch, warnings } = await planBatch({
      registry: registry(),
      records,
      maxFeePerGas: 100n,
      sourceBalancesSnapshot: balances(1_000_000n),
    });
    expect(batch.sourceCount).toBe(2);
    expect(batch.groups.flat()).toHaveLength(2);
    // 5 authorities carry zero records → warned.
    expect(warnings).toHaveLength(5);
  });

  it("rejects a zero amount", async () => {
    await expect(
      planBatch({
        registry: registry(),
        records: [rec(0, getAddress(toHex(0x9000, { size: 20 })), 0n)],
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
      }),
    ).rejects.toThrow(PlanError);
  });

  it("rejects outflow above the source balance", async () => {
    await expect(
      planBatch({
        registry: registry(),
        records: [rec(0, getAddress(toHex(0x9000, { size: 20 })), 2_000_000n)],
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
      }),
    ).rejects.toThrow(PlanError);
  });

  it("rejects an approved source without sufficient allowance", async () => {
    await expect(
      planBatch({
        registry: registry(),
        records: [rec(7, getAddress(toHex(0x9000, { size: 20 })), 1000n)],
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
        allowances: { [APPROVED.toLowerCase()]: 500n },
      }),
    ).rejects.toThrow(PlanError);
  });

  it("rejects a non-allowlisted token", async () => {
    const dai = getAddress(toHex(0xda1, { size: 20 }));
    await expect(
      planBatch({
        registry: registry(),
        records: [rec(0, getAddress(toHex(0x9000, { size: 20 })), 1n, dai)],
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
      }),
    ).rejects.toThrow(PlanError);
  });

  it("rejects a self-referential recipient", async () => {
    await expect(
      planBatch({
        registry: registry(),
        records: [rec(0, AUTHORITIES[0]!, 1n)],
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
      }),
    ).rejects.toThrow(PlanError);
  });

  it("rejects the zero recipient", async () => {
    await expect(
      planBatch({
        registry: registry(),
        records: [rec(0, "0x0000000000000000000000000000000000000000", 1n)],
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
      }),
    ).rejects.toThrow(PlanError);
  });

  it("rejects more than 64 records", async () => {
    const records = Array.from({ length: 65 }, (_, i) =>
      rec(i % 7, getAddress(toHex(BigInt(0x9000 + i), { size: 20 })), 1n),
    );
    await expect(
      planBatch({
        registry: registry(),
        records,
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
      }),
    ).rejects.toThrow(PlanError);
  });

  it("rejects a per-source slice above 8 records", async () => {
    const records = Array.from({ length: 9 }, (_, i) =>
      rec(0, getAddress(toHex(BigInt(0x9000 + i), { size: 20 })), 1n),
    );
    await expect(
      planBatch({
        registry: registry(),
        records,
        maxFeePerGas: 100n,
        sourceBalancesSnapshot: balances(1_000_000n),
      }),
    ).rejects.toThrow(PlanError);
  });

  it("derives a deterministic salt from the record set", async () => {
    const records = [rec(0, getAddress(toHex(0x9000, { size: 20 })), 1n)];
    const a = await planBatch({
      registry: registry(),
      records,
      maxFeePerGas: 100n,
      sourceBalancesSnapshot: balances(1_000_000n),
    });
    const b = await planBatch({
      registry: registry(),
      records,
      maxFeePerGas: 100n,
      sourceBalancesSnapshot: balances(1_000_000n),
    });
    expect(a.batch.plan.salt).toBe(b.batch.plan.salt);
    expect((a.batch.plan.salt.length - 2) / 2).toBe(32);
  });
});

describe("registry: invariants", () => {
  it("requires exactly 7 authorities", () => {
    expect(() =>
      buildRegistry({
        delegationTarget: DELEGATION_TARGET,
        authorities: AUTHORITIES.slice(0, 6),
        approvedSources: [],
      }),
    ).toThrow();
  });

  it("rejects duplicate authorities", () => {
    const dup = [...AUTHORITIES.slice(0, 6), AUTHORITIES[0]!];
    expect(() =>
      buildRegistry({
        delegationTarget: DELEGATION_TARGET,
        authorities: dup,
        approvedSources: [],
      }),
    ).toThrow();
  });

  it("rejects an approved source that is also an authority", () => {
    expect(() =>
      buildRegistry({
        delegationTarget: DELEGATION_TARGET,
        authorities: AUTHORITIES,
        approvedSources: [AUTHORITIES[0]!],
      }),
    ).toThrow();
  });

  it("checksums all addresses", () => {
    const reg = registry();
    for (const a of reg.sources) expect(a).toBe(getAddress(a));
    expect(reg.chainId).toBe(1n);
    expect(reg.entryPoint).toBe(getAddress("0xebbabfc2019a312e3615196e9ac517c6bee2a5f6"));
    expect(reg.outerSigner).toBe(getAddress("0x693b06215df13832feeaee61f35860c372603be2"));
  });

  it("exports registry tokens with correct decimals", async () => {
    const { TOKENS } = await import("../../src/registry.js");
    expect(TOKENS.USDC.decimals).toBe(6);
    expect(TOKENS.USDT.decimals).toBe(6);
  });
});

describe("planner: salt canonicalization", () => {
  it("normalizes addresses so case does not change the salt", async () => {
    const { deriveSalt } = await import("../../src/plan/planner.js");
    const lower = [rec(0, getAddress(toHex(0x9000, { size: 20 })).toLowerCase() as Address, 1n)];
    const upper = [rec(0, getAddress(toHex(0x9000, { size: 20 })), 1n)];
    expect(deriveSalt(lower, { allowPartial: false, sweepMode: false })).toBe(
      deriveSalt(upper, { allowPartial: false, sweepMode: false }),
    );
  });
});

void keccak256;
