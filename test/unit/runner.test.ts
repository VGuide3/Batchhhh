/**
 * End-to-end orchestration test for `runBatch`, driven by an in-memory `ChainPort`.
 *
 * The fake is a tiny EVM model: it keeps ERC-20 balances, mints Transfer logs when the
 * batch is "sent", and reports a type-4 receipt. This exercises the real
 * plan → sign → assemble → simulate → broadcast → reconcile path with no node.
 */

import { describe, expect, it } from "vitest";
import {
  getAddress,
  keccak256,
  toHex,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseScenario, loadSigners, type Scenario } from "../../src/config/scenario.js";
import { buildRegistry } from "../../src/registry.js";
import { runBatch, type RunEvent } from "../../src/run/runner.js";
import type { ChainPort, NodeReceipt, SendType4Request } from "../../src/chain/port.js";

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)")) as Hex;

const KEY = (i: number): Hex => `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}` as Hex;
const AUTH_KEYS = [0, 1, 2, 3, 4, 5, 6].map(KEY);
const OUTER_KEY = KEY(9);

const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
const TARGET = getAddress("0x0000000000000000000000000000000000000002");
const ENTRY = getAddress("0x0000000000000000000000000000000000000001");
const APPROVED = getAddress("0x0000000000000000000000000000000000000003");

const AUTHORITIES = AUTH_KEYS.map((k) => privateKeyToAccount(k).address);
const OUTER = privateKeyToAccount(OUTER_KEY).address;

/** One USDC record per authority → a deliberately non-reference shape. */
function buildScenario(): Scenario {
  const records = AUTHORITIES.map((_, i) => ({
    source: i,
    token: USDC,
    to: getAddress(toHex(BigInt(0x9000 + i), { size: 20 })),
    amount: String(1000 + i),
  }));
  return parseScenario(
    JSON.stringify({
      name: "unit",
      chainId: "31337",
      entryPoint: ENTRY,
      outerSigner: OUTER,
      delegationTarget: TARGET,
      tokens: [USDC, USDT],
      authorities: AUTHORITIES,
      approvedSources: [APPROVED],
      records,
      maxFeePerGas: "100000000000",
      maxPriorityFeePerGas: "1000000000",
      gasCap: "1500000",
    }),
  );
}

class FakeChain implements ChainPort {
  private readonly balances = new Map<string, bigint>();
  private nonces = new Map<string, number>();
  lastSend: SendType4Request | null = null;
  estimateShouldThrow = false;

  private bal(token: Address, who: Address): bigint {
    return this.balances.get(`${token.toLowerCase()}:${who.toLowerCase()}`) ?? 0n;
  }
  private setBal(token: Address, who: Address, v: bigint): void {
    this.balances.set(`${token.toLowerCase()}:${who.toLowerCase()}`, v);
  }

  async chainId(): Promise<bigint> {
    return 31337n;
  }
  async blockNumber(): Promise<bigint> {
    return 1n;
  }
  async baseFeePerGas(): Promise<bigint> {
    return 1_000_000_000n;
  }
  async getTransactionCount(address: Address): Promise<number> {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }
  async codeLength(): Promise<number> {
    return 0; // recipients are EOAs
  }
  async erc20Balance(token: Address, account: Address): Promise<bigint> {
    return this.bal(token, account);
  }
  async erc20Allowance(): Promise<bigint> {
    return 2n ** 256n - 1n;
  }
  async estimateGas(): Promise<bigint> {
    if (this.estimateShouldThrow) throw new Error("estimate unavailable");
    return 700_000n;
  }
  async sendType4(req: SendType4Request): Promise<Hex> {
    this.lastSend = req;
    // Move funds for every planned record so balancesAfter reflects the batch.
    const scenario = buildScenario();
    for (const r of scenario.records) {
      const source = AUTHORITIES[r.source]!;
      const amount = BigInt(r.amount);
      this.setBal(r.token, source, this.bal(r.token, source) - amount);
      this.setBal(r.token, getAddress(r.to), this.bal(r.token, getAddress(r.to)) + amount);
    }
    return keccak256(toHex("fake-tx"));
  }
  async waitForReceipt(): Promise<NodeReceipt> {
    const scenario = buildScenario();
    const logs = scenario.records.map((r) => ({
      address: r.token,
      topics: [
        TRANSFER_TOPIC,
        `0x000000000000000000000000${AUTHORITIES[r.source]!.slice(2)}` as Hex,
        `0x000000000000000000000000${getAddress(r.to).slice(2)}` as Hex,
      ],
      data: encodeAbiParameters([{ type: "uint256" }], [BigInt(r.amount)]),
    }));
    return {
      status: 1,
      type: 4,
      gasUsed: 700_000n,
      effectiveGasPrice: 1_000_000_000n,
      logs,
      authorizationList: AUTHORITIES.map((a) => ({ address: TARGET, recovered: a })),
    };
  }
  async delegationTargetOf(): Promise<Address | null> {
    return TARGET;
  }
}

function fund(chain: FakeChain, scenario: Scenario): void {
  for (const a of AUTHORITIES) {
    // Ample balance for every token.
    (chain as unknown as { balances: Map<string, bigint> }).balances.set(
      `${USDC.toLowerCase()}:${a.toLowerCase()}`,
      1_000_000n,
    );
    (chain as unknown as { balances: Map<string, bigint> }).balances.set(
      `${USDT.toLowerCase()}:${a.toLowerCase()}`,
      1_000_000n,
    );
  }
  void scenario;
}

describe("runBatch (in-memory chain)", () => {
  it("dry-run stops before broadcast and passes guards", async () => {
    const scenario = buildScenario();
    const chain = new FakeChain();
    fund(chain, scenario);
    const events: RunEvent[] = [];
    const result = await runBatch({
      chain,
      scenario,
      signers: loadSigners(scenario, { OUTER_SIGNER_KEY: OUTER_KEY, AUTHORITY_KEYS: AUTH_KEYS.join(",") }),
      dryRun: true,
      onEvent: (e) => events.push(e),
    });
    expect(result.dryRun).toBe(true);
    expect(chain.lastSend).toBeNull();
    expect(events.map((e) => e.stage)).toContain("GUARDS");
    expect(result.envelope.byteLength).toBe(4 + 32 + 80 * 7);
  });

  it("broadcasts, confirms, and passes all invariants", async () => {
    const scenario = buildScenario();
    const chain = new FakeChain();
    fund(chain, scenario);
    const result = await runBatch({
      chain,
      scenario,
      signers: loadSigners(scenario, { OUTER_SIGNER_KEY: OUTER_KEY, AUTHORITY_KEYS: AUTH_KEYS.join(",") }),
    });

    expect(result.dryRun).toBe(false);
    expect(result.txHash).toBeTruthy();
    expect(result.receipt?.status).toBe(1);
    expect(chain.lastSend?.authorizationList).toHaveLength(7);

    const failed = result.invariants.filter((i) => !i.ok);
    expect(failed, JSON.stringify(failed)).toHaveLength(0);
    // Generalized shape: 7 records, 1 token, 7 sources, 7 recipients.
    const inv5 = result.invariants.find((i) => i.id === "INV-5")!;
    expect(inv5.detail).toBe("count=7 tokens=1 from=7 to=7");
    expect(result.alerts.filter((a) => a.kind === "INVARIANT_FAILURE")).toHaveLength(0);
  });

  it("falls back to predicted gas when estimation reverts", async () => {
    const scenario = buildScenario();
    const chain = new FakeChain();
    fund(chain, scenario);
    chain.estimateShouldThrow = true;
    const result = await runBatch({
      chain,
      scenario,
      signers: loadSigners(scenario, { OUTER_SIGNER_KEY: OUTER_KEY, AUTHORITY_KEYS: AUTH_KEYS.join(",") }),
    });
    expect(result.simulatedGas).toBe(result.predictedGas);
  });

  it("rejects a chainId mismatch before doing anything", async () => {
    const scenario = buildScenario();
    const chain = new FakeChain();
    const mismatched = { ...scenario, chainId: "1" } as Scenario;
    await expect(
      runBatch({
        chain,
        scenario: mismatched,
        signers: loadSigners(scenario, { OUTER_SIGNER_KEY: OUTER_KEY, AUTHORITY_KEYS: AUTH_KEYS.join(",") }),
      }),
    ).rejects.toThrow(/chainId mismatch/);
  });
});

// Keep the registry import meaningful (guards against accidental removal).
void buildRegistry;
