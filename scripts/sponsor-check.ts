/**
 * Sponsor / funding inspector.
 *
 *   npm run sponsor -- --scenario scenarios/anvil.json [--rpc <url>]
 *
 * Answers "how much does this batch move, and who pays?" without broadcasting:
 *   - per-source planned outflow per token (what each authority disperses)
 *   - the outer signer's ETH balance and the projected gas cost at the current base fee
 *   - live ERC-20 balances of every source, so shortfalls are obvious before a run
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, formatEther, formatGwei, getAddress, createPublicClient, http } from "viem";
import { mainnet, foundry } from "viem/chains";
import { loadScenario, scenarioRecords } from "../src/config/scenario.js";
import { buildRegistry } from "../src/registry.js";
import { predictGas } from "../src/gas/budget.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")
    ? process.argv[i + 1]
    : undefined;
}
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = t.slice(eq + 1).trim();
  }
}

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

async function main(): Promise<void> {
  const scenarioPath = resolve(arg("scenario") ?? "scenarios/anvil.json");
  if (!existsSync(scenarioPath)) {
    console.error(`scenario not found: ${scenarioPath} (run \`npm run anvil:bootstrap\` first)`);
    process.exit(2);
  }
  loadEnvFile(resolve("scenarios/anvil.env"));
  const scenario = loadScenario(scenarioPath);
  const rpcUrl = arg("rpc") ?? process.env.ETH_RPC_URL ?? "http://127.0.0.1:8545";

  const registry = buildRegistry({
    delegationTarget: scenario.delegationTarget,
    authorities: scenario.authorities,
    approvedSources: scenario.approvedSources,
    tokens: scenario.tokens,
  });

  const records = scenarioRecords(scenario);
  const tokens = registry.tokens;

  // Token metadata.
  const pub = createPublicClient({
    chain: BigInt(scenario.chainId) === 1n ? mainnet : foundry,
    transport: http(rpcUrl),
  });
  const meta = new Map<string, { symbol: string; decimals: number }>();
  for (const t of tokens) {
    try {
      const [symbol, decimals] = await Promise.all([
        pub.readContract({ address: t, abi: ERC20, functionName: "symbol" }),
        pub.readContract({ address: t, abi: ERC20, functionName: "decimals" }),
      ]);
      meta.set(t.toLowerCase(), { symbol, decimals: Number(decimals) });
    } catch {
      meta.set(t.toLowerCase(), { symbol: t.slice(0, 8), decimals: 6 });
    }
  }
  const fmt = (token: string, amount: bigint): string => {
    const m = meta.get(token.toLowerCase())!;
    return `${formatUnits(amount, m.decimals)} ${m.symbol}`;
  };

  console.log("─".repeat(72));
  console.log(`SPONSOR REPORT — ${scenario.name}`);
  console.log("─".repeat(72));
  console.log(`  rpc             : ${rpcUrl}`);
  console.log(`  entry point     : ${scenario.entryPoint}`);
  console.log(`  outer signer    : ${scenario.outerSigner}`);
  console.log(`  delegation tgt  : ${scenario.delegationTarget}`);
  console.log(`  records         : ${records.length}`);
  console.log(`  sources         : ${registry.sources.length}`);

  // Per-source outflow.
  const perSource = new Map<number, Map<string, bigint>>();
  const totals = new Map<string, bigint>();
  for (const r of records) {
    const s = r.sourceOrdinal;
    perSource.set(s, perSource.get(s) ?? new Map());
    const m = perSource.get(s)!;
    m.set(r.token.toLowerCase(), (m.get(r.token.toLowerCase()) ?? 0n) + r.amount);
    totals.set(r.token.toLowerCase(), (totals.get(r.token.toLowerCase()) ?? 0n) + r.amount);
  }

  console.log("\n  PLANNED OUTFLOW (per source):");
  for (let s = 0; s < registry.sources.length; s++) {
    const src = registry.sources[s]!;
    const isAuth = s < registry.authorities.length;
    const label = isAuth ? "authority" : "approved ";
    const m = perSource.get(s);
    const desc = m
      ? [...m.entries()].map(([t, a]) => fmt(t, a)).join(", ")
      : "—";
    console.log(`    [${s}] ${label} ${getAddress(src)}  →  ${desc}`);
  }

  console.log("\n  BATCH TOTALS:");
  for (const [t, a] of totals) console.log(`    ${fmt(t, a)}`);

  // Live balances.
  console.log("\n  LIVE SOURCE BALANCES:");
  for (const src of registry.sources) {
    const parts: string[] = [];
    for (const t of tokens) {
      try {
        const bal = await pub.readContract({
          address: t,
          abi: ERC20,
          functionName: "balanceOf",
          args: [src],
        });
        parts.push(fmt(t, bal));
      } catch {
        parts.push("n/a");
      }
    }
    console.log(`    ${getAddress(src)}  ${parts.join("  |  ")}`);
  }

  // Sponsor gas.
  const predicted = predictGas({
    authorizationCount: registry.authorities.length,
    calldataLength: 36 + 80 * records.length,
    recordCount: records.length,
  });
  let baseFee = 1_000_000_000n;
  let ethBal = 0n;
  try {
    const block = await pub.getBlock({ blockTag: "latest" });
    baseFee = block.baseFeePerGas ?? baseFee;
    ethBal = await pub.getBalance({ address: getAddress(scenario.outerSigner) });
  } catch {
    /* offline: fall back to defaults */
  }
  const maxFeePerGas = BigInt(scenario.maxFeePerGas);
  const costAtBase = predicted.total * baseFee;

  console.log("\n  SPONSOR GAS (outer signer pays):");
  console.log(`    predicted gas   : ${predicted.total}`);
  console.log(`    base fee        : ${formatGwei(baseFee)} gwei`);
  console.log(`    cost @ base fee : ${costAtBase} wei (${formatEther(costAtBase)} ETH)`);
  console.log(`    max fee/gas     : ${formatGwei(maxFeePerGas)} gwei`);
  console.log(`    worst-case cost : ${formatEther(predicted.total * maxFeePerGas)} ETH`);
  console.log(`    signer ETH bal  : ${formatEther(ethBal)} ETH`);
  if (ethBal > 0n && ethBal < predicted.total * maxFeePerGas) {
    console.log("    ⚠ signer balance is below the worst-case cost");
  }
  console.log("─".repeat(72));
}

main().catch((e) => {
  console.error("sponsor check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
