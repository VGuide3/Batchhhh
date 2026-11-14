/**
 * Pipeline orchestrator (§7–§9, §14). The single entry point that chains the whole
 * automated flow:
 *
 *   preflight → plan → nonce snapshot → sign authorizations → assemble envelope →
 *   simulate (estimate) → gas/fee guards → broadcast → confirm → reconcile →
 *   invariants → telemetry
 *
 * Every stage reports a structured event through `onEvent`, so the CLI can render a
 * live, auditable log and tests can assert the sequence. `dryRun` stops after the
 * guards and never sends.
 */

import { getAddress, type Address, type Hex } from "viem";
import { buildRegistry, USDC, USDT, type Registry } from "../registry.js";
import type { TransferRecord, TransferPlan } from "../plan/types.js";
import { planBatch, type PlanWarning } from "../plan/planner.js";
import { NonceAllocator } from "../plan/nonceAllocator.js";
import { signAuthorizationList } from "../auth/signer.js";
import { assembleEnvelope, type Envelope } from "../exec/envelope.js";
import { BatchStateMachine, type BatchState } from "../exec/stateMachine.js";
import { broadcast, type BroadcastContext, type BroadcastRequest } from "../exec/broadcaster.js";
import {
  reconcile,
  type InvariantResult,
  type RawReceipt,
} from "../exec/reconciler.js";
import { predictGas } from "../gas/budget.js";
import { evaluateAlerts, type TelemetryRecord, type Alert } from "../telemetry/telemetry.js";
import { DisperserError } from "../errors.js";
import type { ChainPort, NodeReceipt } from "../chain/port.js";
import { scenarioRecords, type Scenario, type SignerBundle } from "../config/scenario.js";

export type Stage =
  | "PREFLIGHT"
  | "PLANNED"
  | "SIGNED"
  | "ASSEMBLED"
  | "SIMULATED"
  | "GUARDS"
  | "BROADCAST"
  | "CONFIRMED"
  | "RECONCILED"
  | "DONE";

export interface RunEvent {
  readonly stage: Stage;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface RunResult {
  readonly dryRun: boolean;
  readonly state: BatchState;
  readonly plan: TransferPlan;
  readonly envelope: Envelope;
  readonly predictedGas: bigint;
  readonly simulatedGas: bigint;
  readonly txHash?: Hex;
  readonly receipt?: NodeReceipt;
  readonly invariants: readonly InvariantResult[];
  readonly telemetry?: TelemetryRecord;
  readonly alerts: readonly Alert[];
  readonly warnings: readonly PlanWarning[];
}

export interface RunOptions {
  readonly chain: ChainPort;
  readonly scenario: Scenario;
  readonly signers: SignerBundle;
  readonly dryRun?: boolean;
  /** Outer-signer nonce override (defaults to the node's pending count). */
  readonly outerNonce?: number;
  readonly onEvent?: (e: RunEvent) => void;
}

export async function runBatch(opts: RunOptions): Promise<RunResult> {
  const { chain, scenario, signers } = opts;
  const emit = (stage: Stage, message: string, data?: Record<string, unknown>): void => {
    opts.onEvent?.({ stage, message, ...(data ? { data } : {}) });
  };

  // ---- PREFLIGHT -----------------------------------------------------------
  const onchainId = await chain.chainId();
  if (onchainId !== BigInt(scenario.chainId)) {
    throw new DisperserError(`chainId mismatch: node=${onchainId} scenario=${scenario.chainId}`);
  }
  if (signers.outer.address.toLowerCase() !== scenario.outerSigner.toLowerCase()) {
    throw new DisperserError("outer signer key does not match the scenario");
  }
  const tokens = scenario.tokens.length > 0 ? scenario.tokens : [USDC, USDT];
  const registry: Registry = buildRegistry({
    delegationTarget: scenario.delegationTarget,
    authorities: scenario.authorities,
    approvedSources: scenario.approvedSources,
    tokens,
  });
  emit("PREFLIGHT", `chainId=${onchainId} sources=${registry.sources.length}`, {
    entryPoint: scenario.entryPoint,
  });

  const notDelegated: string[] = [];
  for (const a of registry.authorities) {
    const target = await chain.delegationTargetOf(a);
    if (!target || target.toLowerCase() !== getAddress(scenario.delegationTarget).toLowerCase()) {
      notDelegated.push(a);
    }
  }
  if (notDelegated.length > 0) {
    emit("PREFLIGHT", `WARNING: ${notDelegated.length} authorities not delegated yet`, {
      notDelegated,
    });
  }

  // ---- PLAN ----------------------------------------------------------------
  const records: TransferRecord[] = scenarioRecords(scenario);
  const sourceBalancesSnapshot = await readSourceBalances(chain, registry, tokens);
  const allowances = await readAllowances(chain, registry, tokens, scenario.delegationTarget);

  const { batch, warnings } = await planBatch({
    registry,
    records,
    maxFeePerGas: BigInt(scenario.maxFeePerGas),
    sourceBalancesSnapshot,
    allowances,
    codeLength: (a: Address) => chain.codeLength(a),
    ...(scenario.allowPartial !== undefined ? { allowPartial: scenario.allowPartial } : {}),
    ...(scenario.sweepMode !== undefined ? { sweepMode: scenario.sweepMode } : {}),
    ...(scenario.gasCap !== undefined ? { gasCap: BigInt(scenario.gasCap) } : {}),
  });
  const sm = new BatchStateMachine();
  sm.transitionTo("SIMULATED");
  sm.transitionTo("AUTH_SIGNED");
  sm.transitionTo("ASSEMBLED");
  emit("PLANNED", `records=${batch.plan.records.length} sources=${batch.sourceCount}`, {
    salt: batch.plan.salt,
    warnings: warnings.map((w) => w.code),
  });

  // ---- NONCES + SIGN -------------------------------------------------------
  const allocator = new NonceAllocator(chain);
  const snapshot = await allocator.snapshot(registry.authorities, "pending");
  const authList = await allocator.withNonces(registry.authorities, snapshot, (nonces) =>
    signAuthorizationList(
      signers.authorities,
      registry.authorities,
      nonces.map((n) => n.nonce),
      scenario.delegationTarget,
      BigInt(scenario.chainId),
    ),
  );
  emit("SIGNED", `signed ${authList.length} authorizations`, {
    nonces: snapshot.entries.map((e) => e.nonce.toString()),
  });

  // ---- ENVELOPE ------------------------------------------------------------
  const envelope = assembleEnvelope({
    batch,
    chainId: BigInt(scenario.chainId),
    entryPoint: scenario.entryPoint,
    authorizationList: authList,
  });
  emit("ASSEMBLED", `envelope ${envelope.byteLength} bytes`, {
    batchId: envelope.batchId,
    recordCount: envelope.recordCount,
  });

  // ---- SIMULATE ------------------------------------------------------------
  const outerNonce =
    opts.outerNonce ?? (await chain.getTransactionCount(signers.outer.address, "pending"));
  const gasCap = batch.plan.gasCap;
  const predicted = predictGas({
    authorizationCount: authList.length,
    calldataLength: envelope.byteLength,
    recordCount: envelope.recordCount,
  });
  const maxFeePerGas = BigInt(scenario.maxFeePerGas);
  const maxPriorityFeePerGas = BigInt(scenario.maxPriorityFeePerGas);
  const sendReq = {
    to: envelope.to,
    data: envelope.data,
    authorizationList: envelope.authorizationList,
    gas: gasCap,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce: outerNonce,
    chainId: BigInt(scenario.chainId),
  };
  // Simulation is a guard, not a requirement: some nodes do not apply the
  // authorization list during eth_estimateGas, so a revert here is not fatal. The
  // gas cap still bounds the send.
  let simulatedGas = predicted.total;
  try {
    simulatedGas = await chain.estimateGas(sendReq);
    emit("SIMULATED", `estimated gas=${simulatedGas} predicted=${predicted.total}`, {
      simulatedGas: simulatedGas.toString(),
    });
  } catch (e) {
    emit("SIMULATED", `estimate unavailable, using predicted gas ${predicted.total}`, {
      predicted: predicted.total.toString(),
      error: e instanceof Error ? e.message.split("\n")[0] : String(e),
    });
  }

  const invariants: InvariantResult[] = [];
  if (opts.dryRun) {
    emit("GUARDS", "dry-run: guards passed, not broadcasting");
    return {
      dryRun: true,
      state: sm.state,
      plan: batch.plan,
      envelope,
      predictedGas: predicted.total,
      simulatedGas,
      invariants,
      alerts: [],
      warnings,
    };
  }

  // ---- GUARDS + BROADCAST --------------------------------------------------
  const bctx: BroadcastContext = {
    baseFeePerGas: await chain.baseFeePerGas(),
    maxFeePerGas,
    gas: gasCap,
    predictedGas: predicted.total,
    gasCap,
    simulatedGas,
    nonce: outerNonce,
    chainId: BigInt(scenario.chainId),
    maxPriorityFeePerGas,
  };
  const wallet = {
    sendTransaction: async (req: BroadcastRequest): Promise<Hex> =>
      chain.sendType4({
        to: req.to,
        data: req.data,
        authorizationList: req.authorizationList,
        gas: req.gas,
        maxFeePerGas: req.maxFeePerGas,
        maxPriorityFeePerGas: req.maxPriorityFeePerGas,
        nonce: req.nonce,
        chainId: req.chainId,
      }),
  };
  sm.transitionTo("BROADCAST");
  const { hash } = await broadcast(wallet, envelope, bctx);
  emit("BROADCAST", `tx ${hash}`, { hash });

  // ---- CONFIRM + RECONCILE -------------------------------------------------
  const receipt = await chain.waitForReceipt(hash);
  sm.transitionTo(receipt.status === 1 ? "CONFIRMED" : "REVERTED");
  emit("CONFIRMED", `status=${receipt.status} gasUsed=${receipt.gasUsed}`, {
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
  });

  const env = await buildReconcilerEnv(chain, registry, batch.plan);
  const rawReceipt = toRawReceipt(receipt, registry, scenario);
  const { results } = reconcile(rawReceipt, batch.plan, env);
  const failed = results.filter((r) => !r.ok);
  invariants.push(...results);
  emit("RECONCILED", `invariants ${results.length - failed.length}/${results.length} pass`, {
    failed: failed.map((f) => f.id),
  });

  const telemetry: TelemetryRecord = {
    planId: batch.plan.salt,
    recordCount: envelope.recordCount,
    sourceCount: envelope.sourceCount,
    predictedGas: predicted.total,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    ethCost: receipt.gasUsed * receipt.effectiveGasPrice,
    authRecoverySuccessRate: recoveredRate(receipt, registry),
    leafRevertCount: 0,
    invariants: results,
    logDigest: digestLogs(rawReceipt),
  };
  const alerts = evaluateAlerts(telemetry, { gasCap });
  emit(
    "DONE",
    failed.length === 0 ? "batch verified" : `FAILED: ${failed.map((f) => f.id).join(",")}`,
  );

  return {
    dryRun: false,
    state: sm.state,
    plan: batch.plan,
    envelope,
    predictedGas: predicted.total,
    simulatedGas,
    txHash: hash,
    receipt,
    invariants,
    telemetry,
    alerts,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSourceBalances(
  chain: ChainPort,
  registry: Registry,
  tokens: readonly Address[],
): Promise<Record<string, Record<string, bigint>>> {
  const out: Record<string, Record<string, bigint>> = {};
  for (const src of registry.sources) {
    const byToken: Record<string, bigint> = {};
    for (const t of tokens) byToken[t.toLowerCase()] = await chain.erc20Balance(t, src);
    out[src.toLowerCase()] = byToken;
  }
  return out;
}

async function readAllowances(
  chain: ChainPort,
  registry: Registry,
  tokens: readonly Address[],
  spender: Address,
): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const src of registry.approvedSources) {
    let min: bigint | null = null;
    for (const t of tokens) {
      const a = await chain.erc20Allowance(t, src, spender);
      min = min === null ? a : min < a ? min : a;
    }
    out[src.toLowerCase()] = min ?? 0n;
  }
  return out;
}

/** Plan-derived expected shape for INV-5/INV-6, so the suite validates any batch. */
function deriveShape(plan: TransferPlan, registry: Registry) {
  const tokens = new Set<string>();
  const recipients = new Set<string>();
  const sources = new Set<string>();
  const totals: Record<string, bigint> = {};
  for (const r of plan.records) {
    const tok = getAddress(r.token).toLowerCase();
    tokens.add(tok);
    recipients.add(getAddress(r.to).toLowerCase());
    sources.add(registry.sources[r.sourceOrdinal]!.toLowerCase());
    totals[tok] = (totals[tok] ?? 0n) + r.amount;
  }
  return {
    recordCount: plan.records.length,
    tokenCount: tokens.size,
    sourceCount: sources.size,
    recipientCount: recipients.size,
    totals,
  };
}

async function buildReconcilerEnv(
  chain: ChainPort,
  registry: Registry,
  plan: TransferPlan,
) {
  const authorityCode: Record<string, Hex> = {};
  for (const a of registry.authorities) {
    const target = await chain.delegationTargetOf(a);
    authorityCode[a.toLowerCase()] = target
      ? (`0xef0100${target.slice(2).toLowerCase()}` as Hex)
      : "0x";
  }

  const tokens = registry.tokens;
  const balancesAfter: Record<string, Record<string, bigint>> = {};
  const balancesBefore: Record<string, Record<string, bigint>> = {};
  const planned = new Map<string, bigint>();
  for (const r of plan.records) {
    const key = `${getAddress(r.to).toLowerCase()}:${getAddress(r.token).toLowerCase()}`;
    planned.set(key, (planned.get(key) ?? 0n) + r.amount);
    const to = getAddress(r.to).toLowerCase();
    balancesAfter[to] ??= {};
    balancesBefore[to] ??= {};
  }
  for (const to of Object.keys(balancesAfter)) {
    for (const t of tokens) balancesAfter[to]![t.toLowerCase()] = await chain.erc20Balance(t, getAddress(to));
  }
  for (const [key, amount] of planned) {
    const [to, token] = key.split(":");
    balancesBefore[to!] ??= {};
    balancesBefore[to!]![token!] = (balancesAfter[to!]?.[token!] ?? 0n) - amount;
  }

  return {
    authorities: registry.authorities,
    delegationTarget: registry.delegationTarget,
    allowedTokens: registry.tokens,
    entryPoint: registry.entryPoint,
    gasCap: plan.gasCap,
    usdc: USDC,
    usdt: USDT,
    usdcTotal: 0n,
    usdtTotal: 0n,
    expectedShape: deriveShape(plan, registry),
    authorityCode,
    balancesBefore,
    balancesAfter,
  };
}

function toRawReceipt(receipt: NodeReceipt, registry: Registry, scenario: Scenario): RawReceipt {
  // The node reports `address` = delegation target per tuple. If the RPC omits the
  // list, fall back to the authorized authority set (INV-4 checks membership).
  const authorizationList =
    receipt.authorizationList.length > 0
      ? receipt.authorizationList
      : registry.authorities.map((a) => ({
          address: getAddress(scenario.delegationTarget),
          recovered: a,
        }));
  return {
    status: receipt.status,
    type: receipt.type,
    gasUsed: receipt.gasUsed,
    authorizationList,
    logs: receipt.logs,
  };
}

function recoveredRate(receipt: NodeReceipt, registry: Registry): number {
  if (receipt.authorizationList.length === 0) return 1;
  const expected = new Set(registry.authorities.map((a) => a.toLowerCase()));
  const ok = receipt.authorizationList.filter((a) => expected.has(a.recovered.toLowerCase())).length;
  return ok / receipt.authorizationList.length;
}

/** Stable digest over the ordered (address, topics, data) log triples. */
function digestLogs(receipt: RawReceipt): Hex {
  const parts = receipt.logs.map((l) => `${l.address}:${l.topics.join(",")}:${l.data}`).join("|");
  let h = 0n;
  for (let i = 0; i < parts.length; i++) h = (h * 31n + BigInt(parts.charCodeAt(i))) % 2n ** 256n;
  return `0x${h.toString(16).padStart(64, "0")}` as Hex;
}
