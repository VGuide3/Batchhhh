#!/usr/bin/env node
/**
 * End-to-end off-chain dry run (§16). Exercises the whole pipeline against synthetic
 * data so the system can be audited without a live node or a funded key:
 *
 *   registry → planner → nonce snapshot → auth signing → envelope assembly →
 *   gas prediction → fee guard → broadcast (stubbed) → reconcile → invariants → telemetry
 *
 * Run: npx tsx scripts/demo.ts
 */

import { getAddress, keccak256, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildRegistry, USDC, USDT } from "../src/registry.js";
import { asSourceOrdinal, type TransferRecord } from "../src/plan/types.js";
import { planBatch } from "../src/plan/planner.js";
import { encodeTag } from "../src/codec/batch.js";
import { NonceAllocator, type NonceSource } from "../src/plan/nonceAllocator.js";
import { signAuthorizationList } from "../src/auth/signer.js";
import { assembleEnvelope } from "../src/exec/envelope.js";
import { BatchStateMachine } from "../src/exec/stateMachine.js";
import { predictGas, feeGuardOk, effectiveGasPrice } from "../src/gas/budget.js";
import { checkAll } from "../src/invariants/invariants.js";
import { buildDigest, type RawReceipt } from "../src/exec/reconciler.js";
import { evaluateAlerts, type TelemetryRecord } from "../src/telemetry/telemetry.js";

// Deterministic test keys; never use these on mainnet.
const KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
] as const;

const DELEGATION_TARGET = getAddress(toHex(0xdead, { size: 20 }));
const APPROVED_SOURCE = getAddress(toHex(0xacce, { size: 20 }));

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const authorities = KEYS.map((k) => privateKeyToAccount(k).address);

  section("1. Registry");
  const registry = buildRegistry({
    delegationTarget: DELEGATION_TARGET,
    authorities,
    approvedSources: [APPROVED_SOURCE],
  });
  console.log(`chainId=${registry.chainId} entryPoint=${registry.entryPoint}`);
  console.log(`sources=${registry.sources.length} (7 authorities + 1 approved)`);

  section("2. Plan");
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
  const balances: Record<string, Record<string, bigint>> = {};
  for (const s of registry.sources) {
    balances[s.toLowerCase()] = { [USDC.toLowerCase()]: 1_000_000n, [USDT.toLowerCase()]: 1_000_000n };
  }
  const { batch, warnings } = await planBatch({
    registry,
    records,
    maxFeePerGas: 2_000_000_000n,
    sourceBalancesSnapshot: balances,
    allowances: { [APPROVED_SOURCE.toLowerCase()]: 1_000_000n },
  });
  console.log(`records=${batch.plan.records.length} sources=${batch.sourceCount} warnings=${warnings.length}`);
  console.log(`salt=${batch.plan.salt}`);

  section("3. Nonce snapshot");
  const fakeNonces = new Map<string, number>(authorities.map((a, i) => [a.toLowerCase(), 100 + i]));
  const nonceSource: NonceSource = {
    async getTransactionCount(authority: Address) {
      return fakeNonces.get(authority.toLowerCase()) ?? 0;
    },
  };
  const allocator = new NonceAllocator(nonceSource);
  const snapshot = await allocator.snapshot(authorities);
  console.log(snapshot.entries.map((e) => `${e.authority.slice(0, 8)}:${e.nonce}`).join(" "));

  section("4. Authorization signing");
  const signers = Object.fromEntries(
    KEYS.map((k) => {
      const acct = privateKeyToAccount(k);
      return [acct.address.toLowerCase(), acct];
    }),
  );
  const authList = await signAuthorizationList(
    signers,
    authorities,
    snapshot.entries.map((e) => e.nonce),
    DELEGATION_TARGET,
    registry.chainId,
  );
  console.log(`signed ${authList.length} tuples; yParity=${authList.map((t) => t.yParity).join(",")}`);

  section("5. Envelope assembly");
  const envelope = assembleEnvelope({
    batch,
    chainId: registry.chainId,
    entryPoint: registry.entryPoint,
    authorizationList: authList,
  });
  console.log(`type=${envelope.type} to=${envelope.to} byteLength=${envelope.byteLength}`);
  console.log(`batchId=${envelope.batchId}`);

  section("6. Gas prediction + fee guard");
  const gas = predictGas({
    authorizationCount: authList.length,
    calldataLength: envelope.byteLength,
    recordCount: envelope.recordCount,
  });
  console.log(`predicted total gas=${gas.total} (per-transfer ${gas.perTransfer})`);
  console.log(`fee guard ok=${feeGuardOk(1_000_000_000n, 2_000_000_000n)}`);

  section("7. State machine + broadcast (stubbed)");
  const sm = new BatchStateMachine();
  sm.transitionTo("SIMULATED");
  sm.transitionTo("AUTH_SIGNED");
  sm.transitionTo("ASSEMBLED");
  sm.transitionTo("BROADCAST");
  sm.transitionTo("CONFIRMED");
  console.log(`state=${sm.state} history=${sm.transitions.join(" → ")}`);

  section("8. Reconcile + invariants");
  const digest = syntheticReceipt(envelope.batchId, registry, records);
  const ctx = {
    plan: batch.plan,
    authorities: registry.authorities,
    delegationTarget: DELEGATION_TARGET,
    allowedTokens: registry.tokens,
    entryPoint: registry.entryPoint,
    gasCap: 600_000n,
    usdc: USDC,
    usdt: USDT,
    usdcTotal: 23_640n,
    usdtTotal: 23_934n,
  };
  const results = checkAll(digest, ctx);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} — ${r.detail}`);

  section("9. Telemetry + alerts");
  const telemetry: TelemetryRecord = {
    planId: batch.plan.salt,
    recordCount: envelope.recordCount,
    sourceCount: envelope.sourceCount,
    predictedGas: gas.total,
    gasUsed: digest.gasUsed,
    effectiveGasPrice: effectiveGasPrice(53_341_434_936_248n, digest.gasUsed),
    ethCost: 53_341_434_936_248n,
    authRecoverySuccessRate: 1,
    leafRevertCount: 0,
    invariants: results,
    logDigest: keccak256(toHex("logs")),
  };
  const alerts = evaluateAlerts(telemetry, { gasCap: 600_000n });
  console.log(`alerts=${alerts.length === 0 ? "none" : alerts.map((a) => a.kind).join(",")}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nDEMO FAILED: ${failed.map((f) => f.id).join(",")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nDEMO OK — all invariants satisfied");
}

function syntheticReceipt(
  batchId: `0x${string}`,
  registry: ReturnType<typeof buildRegistry>,
  records: readonly TransferRecord[],
): ReturnType<typeof buildDigest> {
  const sources = registry.sources;
  const recipientBalances: Record<string, Record<string, bigint>> = {};
  for (const r of records) {
    const to = r.to.toLowerCase();
    recipientBalances[to] ??= {};
    recipientBalances[to]![r.token.toLowerCase()] =
      (recipientBalances[to]![r.token.toLowerCase()] ?? 0n) + r.amount;
  }
  const authorityCode: Record<string, `0x${string}`> = {};
  for (const a of registry.authorities) {
    authorityCode[a.toLowerCase()] = `0xef0100${DELEGATION_TARGET.slice(2).toLowerCase()}`;
  }
  const receipt: RawReceipt = {
    status: 1,
    type: 4,
    gasUsed: 510_676n,
    authorizationList: registry.authorities.map((a) => ({ address: DELEGATION_TARGET, recovered: a })),
    logs: records.map((r) => ({
      address: r.token,
      topics: [
        keccak256(toHex("Transfer(address,address,uint256)")),
        `0x000000000000000000000000${sources[r.sourceOrdinal]!.slice(2)}` as `0x${string}`,
        `0x000000000000000000000000${r.to.slice(2)}` as `0x${string}`,
      ],
      data: toHex(r.amount, { size: 32 }),
    })),
  };
  void batchId;
  return buildDigest(receipt, {
    authorities: registry.authorities,
    delegationTarget: DELEGATION_TARGET,
    allowedTokens: registry.tokens,
    entryPoint: registry.entryPoint,
    gasCap: 600_000n,
    usdc: USDC,
    usdt: USDT,
    usdcTotal: 23_640n,
    usdtTotal: 23_934n,
    authorityCode,
    balancesBefore: Object.fromEntries(Object.keys(recipientBalances).map((k) => [k, {}])),
    balancesAfter: recipientBalances,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
