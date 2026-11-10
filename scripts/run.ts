/**
 * Automated terminal runner.
 *
 *   node --import tsx scripts/run.ts --scenario scenarios/anvil.json [--dry-run] [--json]
 *
 * Loads a scenario + keys, drives the full pipeline against `--rpc` (default from the
 * scenario env), streams every stage, and prints a final report including the sponsor
 * (outer-signer) ETH cost and the gas breakdown.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatGwei, formatEther } from "viem";
import { mainnet, foundry } from "viem/chains";
import { ViemChainPort } from "../src/chain/viemPort.js";
import { loadScenario, loadSigners, type Scenario } from "../src/config/scenario.js";
import { runBatch, type RunEvent } from "../src/run/runner.js";
import { CHAIN_ID } from "../src/registry.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")
    ? process.argv[i + 1]
    : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Minimal .env loader (KEY=VALUE, `#` comments). Does not override existing vars. */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const STAGE_ICON: Record<string, string> = {
  PREFLIGHT: "›",
  PLANNED: "·",
  SIGNED: "✎",
  ASSEMBLED: "▣",
  SIMULATED: "≈",
  GUARDS: "⛨",
  BROADCAST: "➤",
  CONFIRMED: "✔",
  RECONCILED: "✓",
  DONE: "★",
};

async function main(): Promise<void> {
  const scenarioPath = resolve(arg("scenario") ?? "scenarios/anvil.json");
  if (!existsSync(scenarioPath)) {
    console.error(`scenario not found: ${scenarioPath}`);
    console.error("hint: run `npm run anvil:bootstrap` first (or pass --scenario).");
    process.exit(2);
  }
  loadEnvFile(resolve("scenarios/anvil.env"));
  if (arg("env")) loadEnvFile(resolve(arg("env")!));

  const scenario: Scenario = loadScenario(scenarioPath);
  const rpcUrl = arg("rpc") ?? process.env.ETH_RPC_URL;
  if (!rpcUrl) {
    console.error("no RPC: pass --rpc <url> or set ETH_RPC_URL");
    process.exit(2);
  }

  const signers = loadSigners(scenario);
  const chain = BigInt(scenario.chainId) === CHAIN_ID ? mainnet : foundry;
  const chainPort = new ViemChainPort({ rpcUrl, chain, account: signers.outer });

  const json = flag("json");
  const events: RunEvent[] = [];
  const onEvent = (e: RunEvent): void => {
    events.push(e);
    if (!json) {
      const icon = STAGE_ICON[e.stage] ?? "·";
      console.log(`${icon} [${e.stage.padEnd(10)}] ${e.message}`);
    }
  };

  const result = await runBatch({
    chain: chainPort,
    scenario,
    signers,
    dryRun: flag("dry-run"),
    onEvent,
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          dryRun: result.dryRun,
          state: result.state,
          txHash: result.txHash ?? null,
          byteLength: result.envelope.byteLength,
          predictedGas: result.predictedGas.toString(),
          simulatedGas: result.simulatedGas.toString(),
          gasUsed: result.receipt?.gasUsed.toString() ?? null,
          invariants: result.invariants.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
          alerts: result.alerts,
          warnings: result.warnings,
        },
        null,
        2,
      ),
    );
    return;
  }

  // ---- human report --------------------------------------------------------
  console.log("\n" + "─".repeat(64));
  console.log("SUMMARY");
  console.log("─".repeat(64));
  console.log(`  batch          : ${scenario.name}`);
  console.log(`  records        : ${result.envelope.recordCount}`);
  console.log(`  sources        : ${result.envelope.sourceCount}`);
  console.log(`  calldata       : ${result.envelope.byteLength} bytes`);
  console.log(`  batchId        : ${result.envelope.batchId}`);
  console.log(`  predicted gas  : ${result.predictedGas}`);
  console.log(`  simulated gas  : ${result.simulatedGas}`);

  if (result.receipt) {
    const r = result.receipt;
    const ethCost = r.gasUsed * r.effectiveGasPrice;
    console.log(`  tx hash        : ${result.txHash}`);
    console.log(`  status         : ${r.status === 1 ? "success" : "FAILED"}`);
    console.log(`  gas used       : ${r.gasUsed}`);
    console.log(`  eff gas price  : ${r.effectiveGasPrice} wei (${formatGwei(r.effectiveGasPrice)} gwei)`);
    console.log(`  sponsor cost   : ${ethCost} wei (${formatEther(ethCost)} ETH)`);
  }

  if (result.invariants.length > 0) {
    console.log("\n  invariants:");
    for (const inv of result.invariants) {
      console.log(`    ${inv.ok ? "PASS" : "FAIL"}  ${inv.id}  ${inv.detail}`);
    }
  }
  if (result.warnings.length > 0) {
    console.log("\n  warnings:");
    for (const w of result.warnings) console.log(`    ${w.code}: ${w.message}`);
  }
  if (result.alerts.length > 0) {
    console.log("\n  ALERTS:");
    for (const a of result.alerts) console.log(`    ${a.kind}: ${a.message}`);
  }

  const failed = result.invariants.filter((i) => !i.ok);
  console.log("─".repeat(64));
  if (result.dryRun) {
    console.log("DRY-RUN OK — guards passed, nothing broadcast");
  } else if (failed.length === 0) {
    console.log("RUN OK — all invariants satisfied");
  } else {
    console.log(`RUN FAILED — ${failed.map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nrun failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
