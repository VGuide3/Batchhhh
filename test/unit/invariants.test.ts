import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { BatchStateMachine } from "../../src/exec/stateMachine.js";
import {
  checkAll,
  inv1,
  inv5,
  inv6,
  inv8,
  inv9,
  type InvariantContext,
  type ReceiptDigest,
} from "../../src/invariants/invariants.js";
import { parseLogs, TRANSFER_TOPIC, APPROVAL_TOPIC, type RawLog } from "../../src/exec/reconciler.js";
import { USDC, USDT } from "../../src/registry.js";
import { encodeTag } from "../../src/codec/batch.js";
import { asSourceOrdinal, type TransferRecord } from "../../src/plan/types.js";

const AUTHORITIES: Address[] = Array.from({ length: 7 }, (_, i) =>
  getAddress(toHex(BigInt(0x1000 + i + 1), { size: 20 })),
);
const APPROVED_SOURCE: Address = getAddress(toHex(0xacce, { size: 20 }));
const SOURCES: Address[] = [...AUTHORITIES, APPROVED_SOURCE];
const TARGET: Address = getAddress(toHex(0xdead, { size: 20 }));
const ENTRY: Address = getAddress("0xebbabfc2019a312e3615196e9ac517c6bee2a5f6");

describe("state machine", () => {
  it("walks the happy path", () => {
    const sm = new BatchStateMachine();
    sm.transitionTo("SIMULATED");
    sm.transitionTo("AUTH_SIGNED");
    sm.transitionTo("ASSEMBLED");
    sm.transitionTo("BROADCAST");
    sm.transitionTo("CONFIRMED");
    expect(sm.state).toBe("CONFIRMED");
    expect(sm.transitions).toEqual([
      "PLANNED",
      "SIMULATED",
      "AUTH_SIGNED",
      "ASSEMBLED",
      "BROADCAST",
      "CONFIRMED",
    ]);
  });

  it("allows reverting back to PLANNED for a rebuild", () => {
    const sm = new BatchStateMachine();
    sm.transitionTo("SIMULATED");
    sm.transitionTo("AUTH_SIGNED");
    sm.transitionTo("PLANNED");
    expect(sm.state).toBe("PLANNED");
  });

  it("rejects illegal transitions", () => {
    const sm = new BatchStateMachine();
    expect(() => sm.transitionTo("BROADCAST")).toThrow();
    expect(() => sm.transitionTo("CONFIRMED")).toThrow();
  });
});

describe("log parsing", () => {
  it("parses Transfer and Approval topics", () => {
    const from = AUTHORITIES[0]!;
    const to = getAddress(toHex(0x9000, { size: 20 }));
    const logs: RawLog[] = [
      {
        address: USDC,
        topics: [
          TRANSFER_TOPIC,
          `0x000000000000000000000000${from.slice(2)}` as Hex,
          `0x000000000000000000000000${to.slice(2)}` as Hex,
        ],
        data: toHex(3940n, { size: 32 }),
      },
      {
        address: USDC,
        topics: [
          APPROVAL_TOPIC,
          `0x000000000000000000000000${from.slice(2)}` as Hex,
          `0x000000000000000000000000${to.slice(2)}` as Hex,
        ],
        data: toHex(1n, { size: 32 }),
      },
    ];
    const { transfers, approvals } = parseLogs(logs);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.amount).toBe(3940n);
    expect(transfers[0]!.from).toBe(getAddress(from));
    expect(approvals).toHaveLength(1);
  });
});

function makePlan(): TransferRecord[] {
  const records: TransferRecord[] = [];
  for (let i = 0; i < 6; i++) {
    records.push({
      sourceOrdinal: asSourceOrdinal(i),
      token: USDC,
      to: getAddress(toHex(BigInt(0x9000 + i), { size: 20 })),
      amount: 3940n,
      tag: encodeTag(i),
    });
  }
  for (let i = 0; i < 8; i++) {
    const amount = i === 7 ? 2997n : 2991n;
    records.push({
      sourceOrdinal: asSourceOrdinal(i),
      token: USDT,
      to: getAddress(toHex(BigInt(0xa000 + i), { size: 20 })),
      amount,
      tag: encodeTag(i),
    });
  }
  return records;
}

function ctx(records: TransferRecord[]): InvariantContext {
  return {
    plan: {
      salt: keccak256(toHex("s")),
      records,
      allowPartial: false,
      sweepMode: false,
      maxFeePerGas: 100n,
      gasCap: 600_000n,
      sourceBalancesSnapshot: {},
    },
    authorities: AUTHORITIES,
    delegationTarget: TARGET,
    allowedTokens: [USDC, USDT],
    entryPoint: ENTRY,
    gasCap: 600_000n,
    usdc: USDC,
    usdt: USDT,
    usdcTotal: 23_640n,
    usdtTotal: 23_934n,
  };
}

function goodDigest(records: TransferRecord[]): ReceiptDigest {
  const transfers = records.map((r) => ({
    token: r.token,
    from: SOURCES[r.sourceOrdinal]!,
    to: r.to,
    amount: r.amount,
  }));
  const recipientBalances: Record<string, Record<string, bigint>> = {};
  for (const r of records) {
    recipientBalances[r.to.toLowerCase()] ??= {};
    recipientBalances[r.to.toLowerCase()]![r.token.toLowerCase()] = r.amount;
  }
  const authorityCode: Record<string, Hex> = {};
  for (const a of AUTHORITIES) {
    authorityCode[a.toLowerCase()] = `0xef0100${TARGET.slice(2).toLowerCase()}` as Hex;
  }
  return {
    status: 1,
    type: 4,
    gasUsed: 510_676n,
    authorizationList: AUTHORITIES.map((a) => ({ address: TARGET, recovered: a })),
    transfers,
    approvals: [],
    authorityCode,
    recipientBalances,
    recipientBalancesBefore: Object.fromEntries(
      Object.keys(recipientBalances).map((k) => [k, {}]),
    ),
  };
}

describe("invariants on a synthetic green receipt", () => {
  it("passes all 11 invariants", () => {
    const records = makePlan();
    const results = checkAll(goodDigest(records), ctx(records));
    const failed = results.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed)).toHaveLength(0);
  });

  it("INV-5 checks log/token/from/to cardinality", () => {
    const records = makePlan();
    expect(inv5(goodDigest(records)).ok).toBe(true);
    const d = goodDigest(records);
    expect(inv5({ ...d, transfers: d.transfers.slice(0, 13) }).ok).toBe(false);
  });

  it("INV-6 checks per-token totals", () => {
    const records = makePlan();
    expect(inv6(goodDigest(records), ctx(records)).ok).toBe(true);
  });

  it("INV-8 checks the delegation designator", () => {
    const records = makePlan();
    expect(inv8(goodDigest(records), ctx(records)).ok).toBe(true);
    const d = goodDigest(records);
    const broken = { ...d, authorityCode: { ...d.authorityCode, [AUTHORITIES[0]!.toLowerCase()]: "0x" as Hex } };
    expect(inv8(broken, ctx(records)).ok).toBe(false);
  });

  it("INV-9 checks recipient deltas", () => {
    const records = makePlan();
    expect(inv9(goodDigest(records), ctx(records)).ok).toBe(true);
    const d = goodDigest(records);
    const first = records[0]!;
    const broken = {
      ...d,
      recipientBalances: {
        ...d.recipientBalances,
        [first.to.toLowerCase()]: { [first.token.toLowerCase()]: 1n },
      },
    };
    expect(inv9(broken, ctx(records)).ok).toBe(false);
  });

  it("INV-1 fails on a reverted status", () => {
    const d = goodDigest(makePlan());
    expect(inv1({ ...d, status: 0 }).ok).toBe(false);
  });
});

describe("generalized expectedShape (INV-5/INV-6)", () => {
  it("validates a non-reference shape when expectedShape is supplied", () => {
    // Two records, one token, one source — nothing like the reference batch.
    const records: TransferRecord[] = [
      {
        sourceOrdinal: asSourceOrdinal(0),
        token: USDC,
        to: getAddress(toHex(0x9000, { size: 20 })),
        amount: 5n,
        tag: encodeTag(0),
      },
      {
        sourceOrdinal: asSourceOrdinal(0),
        token: USDC,
        to: getAddress(toHex(0x9001, { size: 20 })),
        amount: 7n,
        tag: encodeTag(0),
      },
    ];
    const base = ctx(records);
    const custom: InvariantContext = {
      ...base,
      expectedShape: {
        recordCount: 2,
        tokenCount: 1,
        sourceCount: 1,
        recipientCount: 2,
        totals: { [USDC.toLowerCase()]: 12n },
      },
    };
    const results = checkAll(goodDigest(records), custom);
    const shape = results.filter((r) => r.id === "INV-5" || r.id === "INV-6");
    expect(shape.filter((r) => !r.ok), JSON.stringify(shape)).toHaveLength(0);
    expect(shape.find((r) => r.id === "INV-5")!.detail).toBe("count=2 tokens=1 from=1 to=2");
  });

  it("fails INV-5 when the observed shape drifts from expectedShape", () => {
    const records = makePlan();
    const drifted: InvariantContext = {
      ...ctx(records),
      expectedShape: {
        recordCount: 99,
        tokenCount: 2,
        sourceCount: 8,
        recipientCount: 14,
        totals: { [USDC.toLowerCase()]: 23_640n, [USDT.toLowerCase()]: 23_934n },
      },
    };
    expect(inv5(goodDigest(records), drifted).ok).toBe(false);
  });

  it("fails INV-6 when a token total drifts from expectedShape", () => {
    const records = makePlan();
    const drifted: InvariantContext = {
      ...ctx(records),
      expectedShape: {
        recordCount: 14,
        tokenCount: 2,
        sourceCount: 8,
        recipientCount: 14,
        totals: { [USDC.toLowerCase()]: 1n, [USDT.toLowerCase()]: 23_934n },
      },
    };
    expect(inv6(goodDigest(records), drifted).ok).toBe(false);
  });
});
