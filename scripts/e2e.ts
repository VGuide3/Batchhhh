/**
 * One-command end-to-end harness.
 *
 *   npm run e2e
 *
 * Spins up a local Anvil (Prague), bootstraps the full system on it, prints the
 * sponsor report, runs a real type-4 batch, verifies all invariants, then tears the
 * node down. Exits non-zero if anything fails. This is the "clone and go" path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ANVIL_PORT ?? 8545);
const RPC = `http://127.0.0.1:${PORT}`;

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      stdio: "inherit",
      env: { ...process.env, ...opts.env },
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

async function waitForRpc(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error("anvil did not become ready");
}

async function main(): Promise<void> {
  console.log("=== E2E: starting anvil (prague) ===");
  const anvil: ChildProcess = spawn("anvil", ["--hardfork", "prague", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const stop = (): void => {
    if (!anvil.killed) anvil.kill("SIGTERM");
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });

  try {
    await waitForRpc();
    console.log(`=== E2E: anvil ready on ${RPC} ===\n`);

    console.log("=== E2E: building contracts ===");
    await run("forge", ["build"], { cwd: join(ROOT, "contracts") });
    console.log();

    console.log("=== E2E: bootstrapping system on anvil ===");
    await run("npx", ["tsx", "scripts/anvil-bootstrap.ts", "--rpc", RPC]);
    console.log();

    console.log("=== E2E: sponsor report ===");
    await run("npx", ["tsx", "scripts/sponsor-check.ts", "--rpc", RPC]);
    console.log();

    console.log("=== E2E: running batch ===");
    await run("npx", ["tsx", "scripts/run.ts", "--rpc", RPC]);

    console.log("\n=== E2E: OK ===");
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error("\nE2E FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
