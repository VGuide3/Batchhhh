import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assembleEnvelope, packRecords } from "../../src/exec/envelope.js";
import { broadcast, type BroadcastRequest } from "../../src/exec/broadcaster.js";
import { BatchStateMachine } from "../../src/exec/stateMachine.js";
import { rollback, type BalanceReader } from "../../src/exec/rollback.js";
import { evaluateAlerts, type TelemetryRecord } from "../../src/telemetry/telemetry.js";
import { buildRegistry, USDC, USDT } from "../../src/registry.js";
import { asSourceOrdinal, type TransferRecord } from "../../src/plan/types.js";
import { encodeTag } from "../../src/codec/batch.js";
import { FeeGuardError, DisperserError } from "../../src/errors.js";
import { signAuthorizationList } from "../../src/auth/signer.js";

const KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467aba5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
] as const;

const TARGET: Address = getAddress(toHex(0xdead, { size: 20 }));
const APPROVED: Address = getAddress(toHex(0xacce, { size: 20 }));

async function makePlan() {
  const authorities = KEYS.map((k) => privateKeyToAccount(k).address);
  const registry = buildRegistry({
    delegationTarget: TARGET,
    authorities,
    approvedSources: [APPROVED],
  });
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
    records.push({
      sourceOrdinal: asSourceOrdinal(i),
      token: USDT,
      to: getAddress(toHex(BigInt(0xa000 + i), { size: 20 })),
      amount: i === 7 ? 2997n : 2991n,
      tag: encodeTag(i),
    });
  }
  return { registry, authorities, records };
}

describe("envelope assembler", () => {
  it("produces a 1156-byte eip7702 envelope with 7 auth tuples", async () => {
    const { registry, authorities, records } = await makePlan();
    const signers = Object.fromEntries(
      KEYS.map((k) => {
        const a = privateKeyToAccount(k);
        return [a.address.toLowerCase(), a];
      }),
    );
    const authList = await signAuthorizationList(
      signers,
      authorities,
      authorities.map((_, i) => BigInt(i)),
      TARGET,
      1n,
    );
    const envelope = assembleEnvelope({
      batch: { plan: planOf(records, registry), groups: [], sourceCount: 8 },
      chainId: 1n,
      entryPoint: registry.entryPoint,
      authorizationList: authList,
    });
    expect(envelope.byteLength).toBe(1156);
    expect(envelope.type).toBe("eip7702");
    expect(envelope.authorizationList).toHaveLength(7);
    expect(envelope.recordCount).toBe(14);
    expect(envelope.sourceCount).toBe(8);
  });

  it("rejects an empty authorization list", () => {
    expect(() =>
      assembleEnvelope({
        batch: {
          plan: {
            salt: keccak256(toHex("s")),
            records: [],
            allowPartial: false,
            sweepMode: false,
            maxFeePerGas: 1n,
            gasCap: 600_000n,
            sourceBalancesSnapshot: {},
          },
          groups: [],
          sourceCount: 0,
        },
        chainId: 1n,
        entryPoint: getAddress(toHex(0xebba, { size: 20 })),
        authorizationList: [],
      }),
    ).toThrow(DisperserError);
  });

  it("packRecords yields the reference length", () => {
    const records = Array.from({ length: 14 }, (_, i) => ({
      token: USDC,
      to: getAddress(toHex(BigInt(0x100 + i), { size: 20 })),
      amount: 1n,
      ordinal: 0,
    }));
    const packed = packRecords(records, 1, keccak256(toHex("s")), 1n, getAddress(toHex(0xebba, { size: 20 })));
    expect((packed.length - 2) / 2).toBe(1156);
  });
});

function planOf(records: TransferRecord[], registry: ReturnType<typeof buildRegistry>) {
  return {
    salt: keccak256(toHex("plan")),
    records,
    allowPartial: false,
    sweepMode: false,
    maxFeePerGas: 1n,
    gasCap: 600_000n,
    sourceBalancesSnapshot: {},
    registry,
  } as never;
}

describe("broadcaster guards", () => {
  const baseCtx = {
    baseFeePerGas: 1_000n,
    maxFeePerGas: 2_000n,
    gas: 600_000n,
    predictedGas: 510_676n,
    gasCap: 600_000n,
    simulatedGas: 510_676n,
    nonce: 0,
    chainId: 1n,
    maxPriorityFeePerGas: 1n,
  };
  const envelope = {
    to: getAddress(toHex(0xebba, { size: 20 })),
    type: "eip7702" as const,
    data: "0x" as `0x${string}`,
    authorizationList: [],
    salt: keccak256(toHex("s")),
    batchId: "0x" as `0x${string}`,
    recordCount: 0,
    sourceCount: 0,
    byteLength: 0,
  };

  it("refuses when baseFee × 1.125 exceeds maxFeePerGas", async () => {
    const wallet = { sendTransaction: async () => "0x" as `0x${string}` };
    await expect(
      broadcast(wallet, envelope, { ...baseCtx, baseFeePerGas: 2_000n, maxFeePerGas: 2_000n }),
    ).rejects.toThrow(FeeGuardError);
  });

  it("refuses when simulated gas exceeds the cap", async () => {
    const wallet = { sendTransaction: async () => "0x" as `0x${string}` };
    await expect(
      broadcast(wallet, envelope, { ...baseCtx, simulatedGas: 700_000n }),
    ).rejects.toThrow(FeeGuardError);
  });

  it("sends exactly once on success", async () => {
    const seen: BroadcastRequest[] = [];
    const wallet = {
      sendTransaction: async (req: BroadcastRequest) => {
        seen.push(req);
        return "0xabc" as `0x${string}`;
      },
    };
    const res = await broadcast(wallet, envelope, baseCtx);
    expect(res.hash).toBe("0xabc");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("eip7702");
  });
});

describe("rollback", () => {
  it("re-reads balances and issues a fresh salt", async () => {
    const reader: BalanceReader = {
      async readBalances() {
        return { [APPROVED.toLowerCase()]: { [USDC.toLowerCase()]: 5n } };
      },
    };
    const plan = await rollback(
      { batchId: keccak256(toHex("dead")), reason: "reverted", authorities: [APPROVED] },
      { reader, sources: [APPROVED], tokens: [USDC], saltSource: () => keccak256(toHex("fresh")) },
    );
    expect(plan.freshSalt).toBe(keccak256(toHex("fresh")));
    expect(plan.reason).toBe("reverted");
  });

  it("refuses with no authorities", async () => {
    const reader: BalanceReader = { async readBalances() { return {}; } };
    await expect(
      rollback(
        { batchId: keccak256(toHex("x")), reason: "r", authorities: [] },
        { reader, sources: [], tokens: [], saltSource: () => keccak256(toHex("f")) },
      ),
    ).rejects.toThrow(DisperserError);
  });
});

describe("telemetry alerts", () => {
  const okRecord: TelemetryRecord = {
    planId: keccak256(toHex("p")),
    recordCount: 14,
    sourceCount: 8,
    predictedGas: 510_676n,
    gasUsed: 510_676n,
    effectiveGasPrice: 104_452_598n,
    ethCost: 53_341_434_936_248n,
    authRecoverySuccessRate: 1,
    leafRevertCount: 0,
    invariants: [{ id: "INV-5", ok: true, detail: "" }],
    logDigest: keccak256(toHex("l")),
  };

  it("emits no alerts on a clean run", () => {
    expect(evaluateAlerts(okRecord, { gasCap: 600_000n })).toHaveLength(0);
  });

  it("fires GAS_NEAR_CAP above 90% of the cap", () => {
    const alerts = evaluateAlerts({ ...okRecord, gasUsed: 560_000n }, { gasCap: 600_000n });
    expect(alerts.map((a) => a.kind)).toContain("GAS_NEAR_CAP");
  });

  it("fires INVARIANT_FAILURE and TRANSFER_COUNT_MISMATCH", () => {
    const alerts = evaluateAlerts(
      { ...okRecord, invariants: [{ id: "INV-5", ok: false, detail: "count=13" }] },
      { gasCap: 600_000n },
    );
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain("INVARIANT_FAILURE");
    expect(kinds).toContain("TRANSFER_COUNT_MISMATCH");
  });

  it("fires AUTHORITY_CODE_MISMATCH when recovery < 1", () => {
    const alerts = evaluateAlerts({ ...okRecord, authRecoverySuccessRate: 0.5 }, { gasCap: 600_000n });
    expect(alerts.map((a) => a.kind)).toContain("AUTHORITY_CODE_MISMATCH");
  });
});

describe("state machine illegal transitions", () => {
  it("cannot go from CONFIRMED anywhere", () => {
    const sm = new BatchStateMachine();
    sm.transitionTo("SIMULATED");
    sm.transitionTo("AUTH_SIGNED");
    sm.transitionTo("ASSEMBLED");
    sm.transitionTo("BROADCAST");
    sm.transitionTo("CONFIRMED");
    expect(sm.canTransitionTo("PLANNED")).toBe(false);
    expect(() => sm.transitionTo("PLANNED")).toThrow(DisperserError);
  });
});
